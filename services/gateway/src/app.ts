/**
 * The Fastify application: request ids, structured logging, and the three operational
 * endpoints.
 *
 * Fastify here rather than plain node:http, which is the opposite of the choice made in
 * woo-mcp - and the difference is the point. woo-mcp has three routes and one body
 * parser, so a framework would mostly have been something to unwrap. This service will
 * carry authentication, cookie sessions, role guards, a REST surface for the dashboard,
 * an MCP endpoint and rate limiting. Schema validation, hooks and typed routes stop
 * being overhead and start being the thing that keeps it coherent.
 */
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import Fastify, { LogController, type FastifyError } from 'fastify';
import { makeRequireAuth } from './auth/middleware.js';
import { authRoutes } from './routes/auth.js';
import type { Config } from './config.js';
import { pingDb, type Db } from './db.js';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  db: Db;
  metrics: Metrics;
}

/** Bound well under the readiness probe's `timeoutSeconds`. See the comment on /readyz. */
const READYZ_BUDGET_MS = 2_000;

/**
 * The return type is inferred rather than annotated as `FastifyInstance`.
 *
 * Passing `loggerInstance` parameterises the instance over pino's concrete `Logger` type
 * instead of Fastify's `FastifyBaseLogger`, so the default-generic `FastifyInstance` is
 * genuinely a different type and annotating it is a lie the compiler correctly rejects.
 * Inferring keeps the real type, and `App` below gives callers a name for it.
 */
export async function buildApp({ config, logger, db, metrics }: AppDeps) {
  const app = Fastify({
    // Fastify logs through pino natively, so handing it the configured instance means
    // application logs and request logs share one stream, one redaction list and one
    // format. Two loggers would mean a secret redacted on one path and printed on the
    // other.
    loggerInstance: logger,

    // Trust the hop in front of us for X-Forwarded-*. Correct here because the only way
    // in is through Traefik, and without it every client address is the ingress pod -
    // which would make rate limiting and audit attribution by address meaningless.
    // It is only safe BECAUSE of the NetworkPolicy: nothing else can reach this port, so
    // a client cannot forge the header by connecting directly.
    trustProxy: true,

    // Reuse an inbound request id when one is present, generate otherwise, so a trace
    // started at the dashboard survives the whole chain.
    requestIdHeader: 'x-request-id',
    genReqId: () => randomUUID(),

    // The log label goes through LogController rather than the top-level
    // `requestIdLogLabel`, which Fastify 5 deprecates and removes in 6. Worth fixing now
    // rather than carrying a startup warning: a deprecation notice in the logs trains
    // whoever reads them to ignore warnings, which is the opposite of what these logs are
    // for.
    logController: new LogController({ requestIdLogLabel: 'requestId' }),

    // 1 MiB. The largest legitimate body is a tool call's arguments or an upstream
    // registration, both a few hundred bytes.
    bodyLimit: 1_048_576,

    // Fastify's default of 0 means "no timeout": a client that opens a connection and
    // dribbles bytes holds a socket indefinitely, and enough of those exhaust the
    // server without any request ever completing.
    requestTimeout: 30_000,
  });

  // Cookie parsing, registered before any route that reads request.cookies.
  //
  // No `secret` option, so cookies are not signed. That is deliberate rather than an
  // omission: the session cookie contains a JWT which is already signed and verified with
  // JWT_SECRET, so a second signature layer would add a second key to manage and protect
  // nothing that is not already protected. Signed cookies earn their place when the value
  // is opaque data the server must trust; here the value defends itself.
  await app.register(cookie);

  // Resolves the session cookie to a principal, re-reading the user row every request so
  // a disabled or demoted account takes effect immediately. See auth/middleware.ts.
  const requireAuth = makeRequireAuth({
    db,
    jwtSecret: config.JWT_SECRET,
    cookieSecure: config.COOKIE_SECURE,
  });

  await app.register(
    authRoutes({
      db,
      jwtSecret: config.JWT_SECRET,
      cookieSecure: config.COOKIE_SECURE,
      requireAuth: requireAuth as never,
    }),
  );

  // Echo the request id back on every response, including errors. Without this, a user
  // reporting "it failed" has nothing to correlate against the logs, and the id is only
  // useful to whoever can already read them.
  app.addHook('onRequest', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  /**
   * Liveness: is this process able to answer at all? It checks nothing else, and that is
   * deliberate.
   *
   * A liveness probe that touched Postgres would restart every gateway replica whenever
   * the database blipped - which fixes nothing, loses every in-flight request, and
   * removes the one process that could have reported the problem. Liveness failure kills
   * a container; it must only ever mean "this process is wedged".
   */
  app.get('/healthz', async () => ({ status: 'ok', service: 'gateway' }));

  /**
   * Readiness: can this replica serve a request? That means the database is reachable,
   * because without it there is no identity, no registry and no audit trail - a gateway
   * that cannot reach Postgres can serve nothing useful and should leave its Service
   * until it can.
   *
   * This is the opposite conclusion to woo-mcp's /readyz, which reports its store's
   * reachability without letting it affect the status code. The distinction is whether
   * the dependency is *this* service's own state or someone else's: Postgres is the
   * gateway's own database and it cannot work without it, whereas WordPress is an
   * upstream woo-mcp proxies for, and a proxy that vanishes during an outage explains
   * nothing. Upstream MCP servers are treated the woo-mcp way here too - a dead upstream
   * degrades one server's tools and must never remove the gateway from its Service, or
   * one broken upstream would take the dashboard down with it.
   *
   * Bounded by an explicit race, which is the direct lesson from the woo-mcp readiness
   * bug: a check that can outlive the kubelet's probe timeout fails the probe by timing
   * out, which is indistinguishable from the dependency being down and takes the pod out
   * of its Service either way. `pingDb` is already bounded by the pool's connection and
   * statement timeouts; this is the belt to that braces.
   */
  app.get('/readyz', async (request, reply) => {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`database check exceeded ${READYZ_BUDGET_MS}ms`)),
        READYZ_BUDGET_MS,
      ).unref(),
    );

    try {
      await Promise.race([pingDb(db), timeout]);
    } catch (error) {
      request.log.warn({ err: error }, 'readiness check failed');
      // 503 with the reason named. The alternative - a bare 503 - makes a reviewer open
      // the logs to learn something the response could have told them.
      return reply.code(503).send({
        status: 'unready',
        reason: 'database unreachable',
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    return reply.send({ status: 'ok', database: 'reachable' });
  });

  /**
   * Metrics, in Prometheus text format.
   *
   * No Ingress path points here - see charts/platform/values.yaml. Metrics are scraped
   * in-cluster, and exposing them publicly would publish tool names, user counts and
   * failure rates to anyone who asked.
   *
   * Returns 404 when disabled rather than an empty 200, so a misconfigured scrape target
   * is visibly wrong instead of quietly reporting nothing.
   */
  app.get('/metrics', async (_request, reply) => {
    if (!config.METRICS_ENABLED) {
      return reply.code(404).send({ error: 'metrics are disabled' });
    }
    const body = await metrics.registry.metrics();
    return reply.header('content-type', metrics.registry.contentType).send(body);
  });

  // One error handler, so no route can leak an internal message by forgetting to catch.
  //
  // The response carries a flat sentence and the request id; the detail goes to the log.
  // An unexpected exception's message is exactly the thing most likely to contain a file
  // path, a SQL fragment or a credential, and the person who can act on it is the
  // operator reading logs, not the caller.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode ?? 500;

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error serving request');
      return reply.code(status).send({ error: 'internal error', requestId: request.id });
    }

    // 4xx messages are about the caller's own request, so they are safe and useful to
    // return - a validation failure that says only "bad request" is a support ticket.
    request.log.info({ err: error, statusCode: status }, 'request rejected');
    return reply.code(status).send({ error: error.message, requestId: request.id });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: 'not found', path: request.url, requestId: request.id }),
  );

  return app;
}

/** The concrete application type, for callers that need to name it. */
export type App = Awaited<ReturnType<typeof buildApp>>;
