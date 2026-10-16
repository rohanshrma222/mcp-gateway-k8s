/**
 * A per-key token bucket, held in Postgres.
 *
 * **Postgres rather than memory**, which is the decision that matters. An in-process counter
 * is faster and simpler and it would be wrong here for a specific reason: the gateway runs
 * two replicas (stand-out #7), so a per-process bucket means a client gets its full
 * allowance *per pod*. Two replicas and a limit of 120/minute is a real limit of 240, and the
 * number changes when somebody scales the Deployment - a limit that silently depends on the
 * replica count is not a limit. Redis would also solve it and would be a second stateful
 * system to deploy, back up and explain; Postgres is already here, already has the row, and
 * the whole operation is one statement.
 *
 * **A token bucket rather than a fixed window.** A fixed window - "120 requests per calendar
 * minute" - lets a client send 120 at 11:59:59 and another 120 at 12:00:00, so the real
 * burst is double the limit at an edge the client can find. A bucket refills continuously,
 * so the burst is the capacity and the sustained rate is the refill rate, both stated
 * independently.
 *
 * ## Why the decision lives in a WHERE clause
 *
 * The read-then-write shape is the obvious one and it loses updates. Two concurrent requests
 * both read "5 tokens left", both compute 4, both write 4 - and two requests cost one token.
 * A CTE does not fix it either: the SELECT half still reads a value the UPDATE half then
 * overwrites, and under `ON CONFLICT DO UPDATE` the second transaction blocks on the row
 * lock and then writes a figure computed from its stale read.
 *
 * So the refill and the test are both expressions inside a single `UPDATE ... WHERE`, which
 * Postgres evaluates while holding the row lock. The second concurrent request re-evaluates
 * against the first one's committed value. Zero rows returned means refused - no second
 * query, no decision made outside the lock.
 */
import type { Db } from '../db.js';
import type { Logger } from 'pino';

export interface RateLimitOptions {
  /** Sustained rate. The bucket refills at this many tokens per minute. */
  requestsPerMinute: number;
  /**
   * Burst capacity, in tokens.
   *
   * Defaulted to one minute's worth rather than exposed as a second knob, because the two
   * numbers answer different questions and most operators only have an opinion about one.
   * Capacity is "how much can arrive at once"; the rate is "how much is sustainable". A
   * client that has been idle may spend a full minute's allowance immediately, which is the
   * behaviour people expect and the reason a bucket is nicer than a window.
   */
  capacity?: number;
}

export type RateLimitResult =
  | { allowed: true; remaining: number }
  | {
      allowed: false;
      /** Whole seconds until one token is available. Advisory - see the note below. */
      retryAfterSeconds: number;
      remaining: number;
    };

export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
    options: RateLimitOptions,
  ) {
    this.capacity = options.capacity ?? options.requestsPerMinute;
    this.refillPerSecond = options.requestsPerMinute / 60;
  }

  /**
   * Spend one token for this key, or refuse.
   */
  async consume(apiKeyId: string): Promise<RateLimitResult> {
    /**
     * The bucket is created full on first use, and `ON CONFLICT DO NOTHING` makes that safe
     * to race: two first-requests both try to insert, one wins, the other no-ops, and both
     * then go through the same UPDATE. Creating it full rather than empty means a brand-new
     * key is not rate limited into its own first request, which would be a baffling welcome.
     */
    await this.db.query(
      `INSERT INTO rate_buckets (api_key_id, tokens, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (api_key_id) DO NOTHING`,
      [apiKeyId, this.capacity],
    );

    /**
     * One statement. The refill is computed from the elapsed time since `updated_at`, capped
     * at capacity, and the `WHERE` admits the request only if that refilled figure is at
     * least one token.
     *
     * `updated_at` advances on a GRANTED request only - which is subtle and deliberate. If a
     * refused request also advanced it, the elapsed time it represented would be consumed
     * without any token being credited, so a client hammering a drained bucket would
     * repeatedly reset its own refill clock and never recover. The bucket would be a trap
     * rather than a queue.
     */
    const { rows } = await this.db.query<{ tokens: number }>(
      `UPDATE rate_buckets AS b
          SET tokens = LEAST($2::float8, b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * $3::float8) - 1,
              updated_at = now()
        WHERE b.api_key_id = $1
          AND LEAST($2::float8, b.tokens + EXTRACT(EPOCH FROM (now() - b.updated_at)) * $3::float8) >= 1
      RETURNING b.tokens`,
      [apiKeyId, this.capacity, this.refillPerSecond],
    );

    const granted = rows[0];
    if (granted !== undefined) {
      return { allowed: true, remaining: Math.floor(granted.tokens) };
    }

    /**
     * Refused. The `Retry-After` figure needs a second read, and it is **advisory**, which is
     * worth being explicit about rather than implying precision the number does not have.
     *
     * This read happens outside the lock the UPDATE held, so by the time it runs the bucket
     * may have refilled slightly or another request may have spent a token. The error is
     * sub-second either way. Being approximate is acceptable because the header is a hint to
     * a well-behaved client; the ENFORCEMENT is the UPDATE above, and that is exact. A client
     * that ignores the hint and retries immediately is refused again, by the statement that
     * actually decides.
     */
    const { rows: state } = await this.db.query<{ available: number }>(
      `SELECT LEAST($2::float8, tokens + EXTRACT(EPOCH FROM (now() - updated_at)) * $3::float8) AS available
         FROM rate_buckets
        WHERE api_key_id = $1`,
      [apiKeyId, this.capacity, this.refillPerSecond],
    );

    const available = state[0]?.available ?? 0;
    const deficit = Math.max(0, 1 - available);
    /**
     * Rounded UP and floored at 1. A `Retry-After: 0` invites an immediate retry that will
     * be refused, which wastes a round trip and looks like the limiter flapping.
     */
    const retryAfterSeconds = Math.max(1, Math.ceil(deficit / this.refillPerSecond));

    return { allowed: false, retryAfterSeconds, remaining: Math.max(0, Math.floor(available)) };
  }

  /**
   * How the limit should be described to a client, for the headers.
   */
  describe(): { limit: number; capacity: number } {
    return { limit: Math.round(this.refillPerSecond * 60), capacity: this.capacity };
  }

  /**
   * Prunes buckets whose key is gone.
   *
   * Not strictly needed - `rate_buckets.api_key_id` is `ON DELETE CASCADE`, so deleting a
   * key removes its bucket. But this project **revokes** keys rather than deleting them
   * (4.4: the id has to stay resolvable for audit rows to mean anything), and chat mints one
   * key per message, so the table grows a row per ephemeral key and keeps it forever.
   *
   * Called from the same sweeper as the chat keys, because the two have the same cause.
   */
  async pruneRevoked(): Promise<number> {
    try {
      const { rowCount } = await this.db.query(
        `DELETE FROM rate_buckets
          WHERE api_key_id IN (
            SELECT id FROM api_keys WHERE revoked_at IS NOT NULL AND revoked_at < now() - interval '1 hour'
          )`,
      );
      return rowCount ?? 0;
    } catch (caught) {
      // Never throws: this is housekeeping, and failing it must not affect a request.
      this.logger.error({ err: caught }, 'pruning rate buckets failed');
      return 0;
    }
  }
}
