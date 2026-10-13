/**
 * The Postgres connection pool.
 *
 * A pool rather than a connection per request, and `pg` rather than an ORM. The ORM
 * question is the same one the migrations answered: this project has to be defended line
 * by line, and an ORM's generated SQL is something I would be explaining rather than
 * something I chose. The queries here are small and the interesting ones - the atomic
 * token bucket, the permission resolution - are precisely the ones an ORM expresses
 * worst.
 */
import pg from 'pg';
import type { Config } from './config.js';
import type { Logger } from './logger.js';

export type Db = pg.Pool;

export function createPool(config: Config, logger: Logger): Db {
  const pool = new pg.Pool({
    host: config.PGHOST,
    port: config.PGPORT,
    database: config.PGDATABASE,
    user: config.PGUSER,
    password: config.PGPASSWORD,

    // Per replica. See the note on PG_POOL_MAX in config.ts: this is multiplied by the
    // replica count, and overshooting Postgres's max_connections converts a traffic spike
    // into "too many clients already" across every replica simultaneously.
    max: config.PG_POOL_MAX,

    // Return idle connections rather than holding them for the process lifetime. With two
    // replicas and a rolling upgrade there are briefly four, and a pool that never
    // releases makes that overlap more expensive than it needs to be.
    idleTimeoutMillis: 30_000,

    // Fail a connection attempt rather than queueing forever. Without this, Postgres
    // being unreachable presents as requests that hang until the client gives up, which
    // reads as "the gateway is slow" rather than "the database is down" - and /readyz
    // would hang with them, which is the woo-mcp readiness bug all over again.
    connectionTimeoutMillis: 5_000,

    // A ceiling on any single statement, enforced by the server. A runaway query in an
    // audit-log filter would otherwise hold a pool slot indefinitely and, at
    // PG_POOL_MAX such queries, stop the gateway serving anything at all.
    statement_timeout: 15_000,

    // Identifies the gateway in pg_stat_activity, so a session holding a lock can be
    // traced to a component rather than to "some node client".
    application_name: 'urumi-gateway',
  });

  // An idle client erroring - the server restarting, a network blip, an administrator
  // terminating a backend - emits on the pool, not on a request. Unhandled, that is an
  // 'error' event with no listener, which in Node takes the whole process down. So this
  // listener is not optional politeness: without it, restarting Postgres kills the
  // gateway rather than causing a few retried connections.
  pool.on('error', (error) => {
    logger.error({ err: error }, 'idle postgres client error');
  });

  return pool;
}

/**
 * Readiness check for the database.
 *
 * Deliberately `SELECT 1` and nothing more. It proves a connection can be acquired from
 * the pool and the server will answer - which is exactly what "can this replica serve a
 * request" means. A richer check (counting rows, verifying the schema) would make
 * readiness fail for reasons that are not readiness, and the budget is bounded by
 * `connectionTimeoutMillis` and `statement_timeout` above rather than left open-ended.
 *
 * That bound is the lesson from woo-mcp: a health check that can outlive the kubelet's
 * probe timeout fails the probe by timing out, which looks identical to the dependency
 * being down and takes the pod out of its Service either way.
 */
export async function pingDb(db: Db): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('SELECT 1');
  } finally {
    // release() in a finally, because an exception between connect and release leaks the
    // connection. Leak PG_POOL_MAX of them and the pool is permanently exhausted - a
    // failure that appears minutes after the bug, under load, with no obvious cause.
    client.release();
  }
}
