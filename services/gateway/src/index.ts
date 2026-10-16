/**
 * Entry point: validate configuration, build the dependencies, listen, and shut down
 * cleanly.
 *
 * The order is deliberate. Configuration is validated before anything is constructed, so
 * a missing secret is a one-line startup failure rather than an exception thrown from a
 * request handler once the process is already serving traffic.
 */
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { createMetrics } from './metrics.js';
import { ClientPool } from './mcp/pool.js';
import { HealthProber } from './mcp/prober.js';
import { ChatKeySweeper } from './chat/keySweeper.js';
import { RateLimiter } from './auth/rateLimit.js';
import { initDummyHash } from './auth/passwords.js';

// Exits non-zero with the offending field names if anything is missing or malformed.
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createPool(config, logger);
const metrics = createMetrics(config.METRICS_ENABLED);

/**
 * One pool per replica, constructed here rather than inside buildApp so the shutdown
 * handler can close it. Nothing connects yet - the pool is lazy, so a dead upstream
 * cannot delay startup.
 */
const pool = new ClientPool({
  logger,
  allowlist: config.UPSTREAM_ALLOWLIST,
  privateHosts: config.UPSTREAM_PRIVATE_HOSTS,
});

/**
 * The health prober, started after the server is listening rather than before.
 *
 * Order matters: starting it first would mean the first probe cycle runs while the process
 * is not yet answering /readyz, so a slow cycle delays the pod becoming ready for a reason
 * that has nothing to do with readiness.
 */
const prober = new HealthProber({
  db,
  logger,
  metrics,
  pool,
  encryptionKey: config.ENCRYPTION_KEY,
  intervalMs: config.UPSTREAM_PROBE_INTERVAL_MS,
  probeTimeoutMs: config.UPSTREAM_PROBE_TIMEOUT_MS,
});

/**
 * The chat key sweeper (8.4).
 *
 * A separate interval from the prober rather than extra work in its cycle, because the
 * two have nothing to do with each other and sharing a timer would couple their
 * failures: a slow probe cycle would delay key cleanup, and 6.6 already had to add a
 * freshness metric because a stalled prober is hard to notice from outside. Two cheap
 * intervals are easier to reason about than one cycle doing two jobs.
 *
 * This is cleanup, not enforcement - expiry is checked in `resolveApiKey` on every
 * call - so if it never ran, no credential would be usable that is not usable now. The
 * file header has the argument for why that separation is the important part.
 */
const keySweeper = new ChatKeySweeper({
  db,
  logger,
  metrics,
  intervalMs: config.CHAT_KEY_SWEEP_INTERVAL_MS,
  /**
   * A SECOND RateLimiter instance, which is safe rather than sloppy: the limiter holds no
   * state of its own - every token lives in the `rate_buckets` table - so this one and the
   * one inside the app agree by construction. Threading the app instance back out here would
   * mean changing what createApp returns for the sake of a housekeeping call.
   */
  rateLimiter: config.RATE_LIMIT_ENABLED
    ? new RateLimiter(db, logger, { requestsPerMinute: config.RATE_LIMIT_PER_MINUTE })
    : undefined,
});


/**
 * Note what is NOT done here: no connection to Postgres is attempted before listening.
 *
 * That is on purpose. Blocking startup on the database means a gateway that cannot start
 * while Postgres is briefly unavailable, so it never reaches the point of serving
 * /readyz - and Kubernetes reports CrashLoopBackOff, which looks like the gateway is
 * broken rather than like its dependency is. Starting, then reporting unready with a
 * reason, is both more honest and more useful: the pod stays inspectable and `/readyz`
 * says exactly what is wrong.
 */
async function main(): Promise<void> {
  // Computed once, before listening. This is the hash the login route verifies against
  // when no user matches, so that a missing account costs the same time as a wrong
  // password - see auth/passwords.ts. Doing it per request would add a second, different
  // timing signal, which is the problem it exists to remove.
  await initDummyHash();

  const app = await buildApp({ config, logger, db, metrics, pool });
  appRef = app;

  // 0.0.0.0, not localhost. A server bound to the loopback interface inside a container
  // is unreachable from the kubelet and from every other pod, which presents as a
  // readiness probe failing with "connection refused" on a process that is running
  // perfectly.
  await app.listen({ host: '0.0.0.0', port: config.PORT });

  prober.start();
  keySweeper.start();

  logger.info(
    {
      port: config.PORT,
      database: `${config.PGHOST}:${config.PGPORT}/${config.PGDATABASE}`,
      poolMax: config.PG_POOL_MAX,
      metrics: config.METRICS_ENABLED,
      upstreamAllowlist: config.UPSTREAM_ALLOWLIST,
    },
    'gateway listening',
  );
}

/**
 * Graceful shutdown.
 *
 * Kubernetes sends SIGTERM and waits `terminationGracePeriodSeconds` before SIGKILL. Two
 * things have to happen in that window, in this order: stop accepting new work and let
 * in-flight requests finish (`app.close()`), then release the database pool. Draining
 * the pool first would fail the very requests the drain is meant to protect.
 *
 * This matters more once there are writes. A `tools/call` cut off mid-flight is the
 * difference between a clean failure the caller can retry and a half-written audit row.
 */
let shuttingDown = false;
/**
 * Held at module scope because the signal handlers are registered before the app exists -
 * buildApp is async now that it registers plugins. A handler firing before startup
 * finishes therefore has nothing to close, which is handled explicitly below rather than
 * crashing in the handler.
 */
let appRef: Awaited<ReturnType<typeof buildApp>> | undefined;

async function shutdown(signal: string): Promise<void> {
  // A second SIGTERM during a drain must not start a second drain - that races the first
  // and can close the pool while requests are still using it.
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'shutting down');
  try {
    // The prober stops FIRST. It holds no request, so draining it is instant - and
    // leaving it running during the drain would have it opening upstream connections
    // while closeAll is trying to close them.
    prober.stop();
    // The sweeper stops with the prober and for the same reason: it holds no request, so
    // there is nothing to drain, and leaving it running would have it writing to the
    // database while the pool is being closed.
    keySweeper.stop();
    if (appRef !== undefined) await appRef.close();
    // Upstream connections close after the HTTP server stops accepting work and before
    // the database pool drains: an in-flight tool call still needs both, and closing
    // either first would fail the very requests the drain exists to protect.
    await pool.closeAll();
    await db.end();
    logger.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'error during shutdown');
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal));
}

// An unhandled rejection leaves the process in a state nobody reasoned about. Logging and
// exiting lets Kubernetes restart a clean one; the alternative is a replica that stays in
// its Service while holding corrupt state, which is strictly worse than being gone.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection, exiting');
  process.exit(1);
});

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
