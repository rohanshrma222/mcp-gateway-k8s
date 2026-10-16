/**
 * Revokes ephemeral chat keys that outlived their request.
 *
 * **This is cleanup, not enforcement, and the distinction is the whole point.** An expired
 * key is already unusable: `resolveApiKey` checks `expires_at` on every `/mcp` call, so the
 * credential is dead the moment it expires whether or not this sweeper is running. If
 * expiry were enforced *here* instead, a crashed sweeper would silently restore the
 * vulnerability it exists to close - and nothing would look wrong. 6.1 settled that
 * argument about the audit write: a control that can be skipped without anyone noticing is
 * not a control.
 *
 * So what this does is tidy. It sets `revoked_at` on keys whose request died before the
 * `finally` in `routes/chat.ts` could run - a pod killed by a rollout, an OOM, a node
 * eviction - which turns "expired but still looks live" into "revoked", so the keys table
 * tells the truth about what is outstanding. That matters because the Keys page lists what
 * exists, and an operator reading a list of apparently-live credentials cannot tell which
 * ones are actually dead by expiry.
 *
 * **Running on every replica is fine and is not coordinated.** The statement is
 * `... WHERE revoked_at IS NULL`, so two replicas sweeping the same row means one updates it
 * and the other matches nothing. No leader election, no advisory lock, no second system to
 * explain - the idempotence is in the predicate. This is the same reasoning the rate-limit
 * buckets use in 4.x: make the write safe to repeat rather than arranging for it to happen
 * once.
 */
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import type { Metrics } from '../metrics.js';

export interface KeySweeperOptions {
  db: Db;
  logger: Logger;
  metrics: Metrics | undefined;
  intervalMs: number;
  /**
   * Optional: also prune rate-limit buckets belonging to long-revoked keys (9.2).
   *
   * Here rather than on its own timer because the two have the SAME CAUSE. Chat mints a key
   * per message and this project revokes rather than deletes - 4.4 keeps the id resolvable
   * so audit rows mean something - so every ephemeral key leaves a permanent bucket row
   * behind. One sweep, one cause, one interval.
   */
  rateLimiter?: { pruneRevoked: () => Promise<number> } | undefined;
}

export class ChatKeySweeper {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: KeySweeperOptions) {}

  start(): void {
    if (this.timer !== undefined) return;

    /**
     * One sweep immediately, then on the interval.
     *
     * The interesting case for this component is a pod that was just killed mid-chat, which
     * means the keys needing attention most are the ones that existed before this process
     * started. Waiting a full interval before the first look would leave them live for that
     * long after a restart - exactly the window a restart creates.
     */
    void this.sweep();

    this.timer = setInterval(() => void this.sweep(), this.options.intervalMs);
    // Unreffed so the timer cannot hold the process open during shutdown. The prober does
    // the same; a stray interval is a surprisingly common reason a container refuses to
    // exit and then gets SIGKILLed.
    this.timer.unref();

    this.options.logger.info(
      { intervalMs: this.options.intervalMs },
      'chat key sweeper started',
    );
  }

  stop(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
    this.options.logger.info('chat key sweeper stopped');
  }

  /**
   * One pass. Public so a test can run it deterministically rather than waiting.
   */
  async sweep(): Promise<number> {
    /**
     * Overlapping sweeps are skipped rather than queued.
     *
     * If a sweep ever takes longer than the interval - a slow database, a long lock wait -
     * the interval would otherwise stack passes on top of each other, each doing the same
     * work and competing for the same rows. Skipping is right because this is a periodic
     * reconciliation: the next tick will catch whatever this one is still working on.
     */
    if (this.running) {
      this.options.logger.debug('chat key sweep skipped: the previous one is still running');
      return 0;
    }
    this.running = true;

    try {
      const { rows } = await this.options.db.query<{ key_id: string; user_id: string }>(
        /**
         * Scoped to `kind = 'chat'` deliberately, even though only chat keys have an
         * `expires_at` today.
         *
         * If a future feature gives standard keys an expiry - a reasonable thing for an
         * admin to want - then a sweeper written without this clause would start silently
         * revoking keys a human configured into an external client. Narrowing now costs
         * nothing and means that feature cannot be surprised by this one.
         */
        `UPDATE api_keys
            SET revoked_at = now()
          WHERE kind = 'chat'
            AND revoked_at IS NULL
            AND expires_at IS NOT NULL
            AND expires_at < now()
      RETURNING key_id, user_id`,
      );

      if (rows.length > 0) {
        this.options.metrics?.chatKeysSwept.inc(rows.length);
        /**
         * Logged at `warn`, not `info`, because every row here is a key that SHOULD have
         * been revoked by its own request and was not. A nonzero sweep is evidence that a
         * chat was interrupted - usually a deploy, sometimes something worth knowing about -
         * and the key ids make it traceable against the audit log.
         */
        this.options.logger.warn(
          { swept: rows.length, keyIds: rows.map((row) => row.key_id) },
          'revoked expired chat keys whose request did not clean up after itself',
        );
      }

      /**
       * Bucket pruning runs after the key sweep and its result is logged rather than
       * returned, because it is housekeeping about rows nobody can use: the keys are already
       * revoked. An hour of grace before deleting, so a bucket is not removed from under a
       * request that is mid-flight when its key is revoked.
       */
      if (this.options.rateLimiter !== undefined) {
        const pruned = await this.options.rateLimiter.pruneRevoked();
        if (pruned > 0) {
          this.options.logger.debug({ pruned }, "pruned rate-limit buckets for revoked keys");
        }
      }

      return rows.length;
    } catch (caught) {
      /**
       * Never throws out of the interval. An unhandled rejection in a `setInterval` callback
       * takes the process down in Node, which would turn a transient database hiccup into a
       * restart of a gateway that is otherwise serving fine - and the next tick would have
       * fixed it anyway.
       */
      this.options.logger.error({ err: caught }, 'chat key sweep failed');
      return 0;
    } finally {
      this.running = false;
    }
  }
}

/**
 * How long a chat key may live.
 *
 * **Derived rather than a magic number**, because the constraint is not arbitrary: the TTL
 * has to outlast the longest legitimate turn, or a long chat would have its own credential
 * expire underneath it and start failing with an auth error halfway through an answer. That
 * would be the worst kind of bug - intermittent, dependent on how talkative the model was,
 * and looking exactly like a key problem rather than a timeout.
 *
 * The worst case is `maxIterations` model turns, each up to `modelTimeoutMs`, plus the tool
 * calls in between. So the floor is the product of the two, and the slack covers the tool
 * calls and any queueing. Computing it means the number cannot drift when somebody raises
 * the iteration cap - which they would do without thinking about key expiry, and should not
 * have to.
 *
 * It is still bounded: a configured value wins if one is set, because an operator may know
 * something about their deployment that this formula does not.
 */
export function chatKeyTtlMs(config: {
  /**
   * Optional with a `?` rather than `number | undefined`, because under
   * `exactOptionalPropertyTypes` those are different types and the config object has the
   * first - a distinction tsc caught here rather than at the call site.
   */
  CHAT_KEY_TTL_MS?: number | undefined;
  CHAT_MAX_ITERATIONS: number;
  CHAT_MODEL_TIMEOUT_MS: number;
}): number {
  if (config.CHAT_KEY_TTL_MS !== undefined) return config.CHAT_KEY_TTL_MS;

  const worstCaseModelTime = config.CHAT_MAX_ITERATIONS * config.CHAT_MODEL_TIMEOUT_MS;
  const slackForToolCalls = 120_000;
  return worstCaseModelTime + slackForToolCalls;
}
