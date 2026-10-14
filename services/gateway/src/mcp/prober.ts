/**
 * The health prober: every 15s, ask each enabled upstream for its tools, and write down
 * what happened.
 *
 * Two jobs in one pass, deliberately, because they need the same round trip:
 *
 *   1. Persist status + the human-readable reason + the probe time to `mcp_servers`, which
 *      is what the dashboard reads. The brief requires a *reason*, not just "Unreachable".
 *   2. Refresh the `mcp_tools` cache, which is what lets `tools/list` be answered from the
 *      database in 5.3 and therefore never block on a dead upstream.
 *
 * `tools/list` rather than a ping, because it is the only call that proves the thing we
 * actually care about: not that a socket opens, but that this upstream is speaking MCP and
 * can enumerate what it offers. It also happens to be the data we need to cache, so the
 * health check and the cache refresh are the same request rather than two.
 */
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { forgetUpstream } from '../metrics.js';
import { ClientPool, UpstreamUnavailableError } from './pool.js';
import { CredentialError, loadUpstream, type UpstreamTarget } from './upstreams.js';

export interface ProberOptions {
  db: Db;
  logger: Logger;
  metrics: Metrics;
  pool: ClientPool;
  encryptionKey: string;
  intervalMs: number;
  /**
   * Far shorter than a tool call's timeout, and that is the point.
   *
   * A probe is a liveness question, not a unit of work. If it used the upstream's
   * configured 20s then one slow upstream would consume more than the whole 15s interval
   * on its own, cycles would overlap, and the prober would spend its life waiting on the
   * least healthy thing it monitors. 3s says "answer promptly or you are not healthy",
   * which is a different and correct question.
   */
  probeTimeoutMs: number;
}

/**
 * The separator between an upstream's slug and its tool name.
 *
 * Double underscore because a single one appears inside tool names constantly
 * (`list_products`), so a single-underscore separator would be ambiguous to split on. The
 * slug pattern forbids underscores entirely, which is what makes the first `__` the
 * unambiguous boundary.
 *
 * NOTE: this is the simple form. The 60-character clamp with a hash suffix, and the
 * collision handling for two upstreams exposing the same tool name, are step 5.3. The
 * column is NOT NULL and UNIQUE, so something has to be written now; writing the plain
 * form and tightening it next is honest, and 5.3 changes one function rather than adding
 * a column.
 */
export const PREFIX_SEPARATOR = '__';

export function prefixedName(slug: string, toolName: string): string {
  return `${slug}${PREFIX_SEPARATOR}${toolName}`;
}

export class HealthProber {
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;

  constructor(private readonly options: ProberOptions) {}

  /**
   * Starts the loop and runs one cycle immediately.
   *
   * Immediately, because otherwise the dashboard shows every upstream as `unknown` for the
   * first fifteen seconds after a deploy - which looks like a broken gateway at exactly
   * the moment someone is watching it roll out.
   */
  start(): void {
    void this.cycle();
    this.timer = setInterval(() => void this.cycle(), this.options.intervalMs);
    // unref so an idle timer cannot hold the process open. Without it, a Node process with
    // a repeating interval never exits on its own, and shutdown relies entirely on the
    // explicit process.exit - which is a worse place to depend on.
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearInterval(this.timer);
  }

  /**
   * One pass over every enabled upstream.
   *
   * Guarded against overlap: if a cycle is still running when the interval fires, the new
   * one is skipped rather than queued. Queueing would mean a slow upstream causes cycles
   * to pile up, each holding connections, until the pod runs out of something.
   */
  async cycle(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      const targets = await this.loadTargets();
      // Settled, not sequential: one upstream taking its full 3s must not delay the
      // others. With `allSettled` a cycle costs the SLOWEST upstream rather than the sum
      // of all of them, which is what keeps a cycle inside the interval as upstreams are
      // added.
      await Promise.allSettled(targets.map((target) => this.probe(target)));
      await this.reconcileRemoved(targets);
    } catch (error) {
      // A cycle failing as a whole means the database read failed - the probes themselves
      // handle their own errors. Logged and swallowed, because throwing from a timer
      // callback would reach the process-level unhandledRejection handler and exit the
      // gateway over a transient database blip.
      this.options.logger.error({ err: error }, 'health probe cycle failed');
    } finally {
      this.running = false;
    }
  }

  /**
   * Loads every enabled upstream, turning a credential failure into a recorded status
   * rather than losing the whole cycle.
   *
   * Loading them one at a time rather than with a single `loadEnabledUpstreams` call,
   * because that function decrypts: one row with an undecryptable credential would throw
   * and take every other upstream's probe down with it. Per-row loading means a bad row
   * records its own reason and the rest of the cycle continues.
   *
   * The cost is one query per upstream per cycle instead of one query per cycle - at 15s
   * intervals for a handful of rows that is nothing, and it is bounded by the number of
   * registered upstreams rather than by traffic. The first version of this loop was worse
   * than it needed to be: it called `loadEnabledUpstreams` *inside* the loop and then
   * searched the result, which re-read and re-decrypted every row for every row.
   */
  private async loadTargets(): Promise<UpstreamTarget[]> {
    const ids = await this.options.db.query<{ id: string; slug: string }>(
      'SELECT id, slug FROM mcp_servers WHERE enabled = true ORDER BY slug',
    );
    for (const row of ids.rows) this.slugById.set(row.id, row.slug);

    const targets: UpstreamTarget[] = [];

    for (const { id, slug } of ids.rows) {
      try {
        const loaded = await loadUpstream(this.options.db, this.options.encryptionKey, id);
        if (loaded !== undefined && loaded.enabled) {
          targets.push(loaded.target);
          this.slugById.set(id, loaded.target.slug);
        }
      } catch (error) {
        if (error instanceof CredentialError) {
          await this.record(id, slug, 'unreachable', error.message, undefined);
          continue;
        }
        throw error;
      }
    }

    return targets;
  }

  private async probe(target: UpstreamTarget): Promise<void> {
    try {
      const listed = await this.options.pool.use(target, (client) =>
        client.listTools({}, { timeout: this.options.probeTimeoutMs }),
      );

      await this.record(target.id, target.slug, 'connected', undefined, listed.tools.length);
      await this.refreshTools(target, listed.tools);
    } catch (error) {
      /**
       * Prefer the pool’s own recorded reason over the thrown message.
       *
       * They differ in one important way. When the backoff refuses an attempt, the thrown
       * error appends a live countdown - "(not retrying for another 6s)" - which is useful
       * in an immediate API response and wrong to persist: the number is stale the instant
       * it is written, and a dashboard would display it unchanged for as long as the
       * upstream stayed down. The pool keeps the clean underlying reason, which is what
       * belongs in a stored field someone reads minutes later.
       */
      const pooled = this.options.pool.entry(target.id).lastError;
      const reason =
        pooled ??
        (error instanceof UpstreamUnavailableError
          ? error.reason
          : error instanceof Error
            ? error.message.slice(0, 500)
            : String(error).slice(0, 500));

      await this.record(target.id, target.slug, 'unreachable', reason, undefined);

      /**
       * The cached tools are deliberately NOT deleted when an upstream goes down.
       *
       * This is the decision that makes `tools/list` survive an outage, and it is worth
       * being explicit about the trade. Keeping them means a client can still see what the
       * upstream offers and gets a precise error on call, rather than watching tools
       * silently disappear from its list and having no idea why. Deleting them would make
       * a transient blip look like the admin removed the server.
       *
       * The cost is that the cache can be stale - a tool that was renamed while the
       * upstream was down is advertised until it comes back. `last_seen_at` is what makes
       * that visible, and a call to a vanished tool fails with the upstream's own "unknown
       * tool" error, which is the correct answer anyway.
       */
    }
  }

  /** Writes status, reason and probe time. One statement, no read first. */
  private async record(
    serverId: string,
    slug: string,
    status: 'connected' | 'unreachable',
    reason: string | undefined,
    toolCount: number | undefined,
  ): Promise<void> {
    await this.options.db.query(
      `UPDATE mcp_servers
          SET status = $2,
              last_error = $3,
              last_probed_at = now()
        WHERE id = $1`,
      [serverId, status, reason ?? null],
    );

    // The gauge the dashboard's graphs and any alerting read. `server` is the slug rather
    // than the uuid, because a uuid on a graph axis is unreadable and the slug is already
    // bounded and unique.
    this.options.metrics.upstreamUp.set({ server: slug }, status === 'connected' ? 1 : 0);

    // Only logged on a *change*, which is the difference between a useful log and 5,760
    // lines a day saying nothing happened. The pool already logs the transition into
    // failure with the reason, so this is the recovery side.
    const previous = this.lastLogged.get(serverId);
    if (previous !== status) {
      this.lastLogged.set(serverId, status);
      if (status === 'connected') {
        this.options.logger.info({ slug, toolCount }, 'upstream is healthy');
      } else {
        this.options.logger.warn({ slug, reason }, 'upstream is unreachable');
      }
    }
  }

  private readonly lastLogged = new Map<string, string>();

  /**
   * server id -> slug, remembered across cycles.
   *
   * Needed because `mcp_upstream_up` is labelled by slug while the pool is keyed by id,
   * and by the time a DELETE is noticed the row - and therefore the slug - is gone from
   * the database. Without this the gauge for a deleted upstream can never be cleared, and
   * it keeps reporting its LAST value: a deleted server showing as healthy forever, which
   * is worse than showing a phantom failure because nobody goes looking for it.
   *
   * This was a real bug found by deleting an upstream and watching the series survive,
   * and it is exactly the case `forgetUpstream` was written for - the helper existed and
   * the delete path simply never called it.
   */
  private readonly slugById = new Map<string, string>();

  /**
   * Refreshes the tool cache for one upstream.
   *
   * An upsert keyed on `(server_id, name)` plus a delete of anything not seen in this
   * pass, rather than delete-then-insert. Three reasons, and the third is the one that
   * matters with two replicas:
   *
   *   - delete-then-insert leaves a window where `tools/list` would return nothing, so a
   *     client that asked mid-refresh would see an empty tool list and treat the server as
   *     having no tools.
   *   - the row's `id` is stable across refreshes, so anything that ever references a tool
   *     row keeps referring to the same thing.
   *   - two replicas probing concurrently both upsert the same rows harmlessly. A
   *     delete-then-insert pair from two replicas can interleave into a lost insert or a
   *     unique violation.
   *
   * Only `(server_id, name)` is inferred in ON CONFLICT, even though `prefixed_name` is
   * also unique: the prefixed name is derived from the slug and the name, and the slug is
   * immutable per server, so uniqueness of the pair implies uniqueness of the derived
   * name. That stops being true once 5.3 adds the 60-char clamp with a hash suffix, which
   * is why the clamp arrives with the collision handling rather than before it.
   */
  private async refreshTools(
    target: UpstreamTarget,
    // Each optional spells out `| undefined` rather than relying on `?` alone, because
    // under exactOptionalPropertyTypes those differ and the SDK’s own tool type uses the
    // `| undefined` form. Writing `title?: string` here would reject the SDK’s value -
    // which is the flag correctly pointing out that my hand-written shape was narrower
    // than the data it receives.
    tools: {
      name: string;
      title?: string | undefined;
      description?: string | undefined;
      inputSchema?: unknown;
      annotations?: unknown;
    }[],
  ): Promise<void> {
    if (tools.length === 0) {
      // An upstream that genuinely reports zero tools is a real state, not an error, and
      // its cache should become empty rather than keep stale rows.
      await this.options.db.query('DELETE FROM mcp_tools WHERE server_id = $1', [target.id]);
      return;
    }

    const probedAt = new Date();

    for (const tool of tools) {
      await this.options.db.query(
        `INSERT INTO mcp_tools
           (server_id, name, prefixed_name, title, description, input_schema, annotations, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (server_id, name) DO UPDATE
            SET prefixed_name = EXCLUDED.prefixed_name,
                title         = EXCLUDED.title,
                description   = EXCLUDED.description,
                input_schema  = EXCLUDED.input_schema,
                annotations   = EXCLUDED.annotations,
                last_seen_at  = EXCLUDED.last_seen_at`,
        [
          target.id,
          tool.name,
          prefixedName(target.slug, tool.name),
          tool.title ?? null,
          tool.description ?? null,
          // Stringified for jsonb. The schema and annotations are stored verbatim because
          // 5.4 forwards them to clients: rewriting them here would mean a client sees a
          // schema the upstream never published, and an argument that validates at the
          // gateway and fails upstream.
          JSON.stringify(tool.inputSchema ?? {}),
          JSON.stringify(tool.annotations ?? {}),
          probedAt,
        ],
      );
    }

    /**
     * Remove tools the upstream no longer advertises.
     *
     * Compared against this pass's own timestamp rather than `now()`, so a row written
     * moments ago by the *other* replica is not deleted for being a few milliseconds
     * older. Using `now()` here would let two replicas delete each other's work on every
     * cycle, which presents as tools flickering in and out of the list.
     */
    await this.options.db.query(
      'DELETE FROM mcp_tools WHERE server_id = $1 AND last_seen_at < $2',
      [target.id, probedAt],
    );
  }

  /**
   * Reconciles upstreams that are no longer enabled or no longer exist.
   *
   * Without this, disabling an upstream leaves its last status on the dashboard forever and
   * its connection open in the pool, and deleting one leaves a `mcp_upstream_up` series
   * reporting a permanent phantom failure for a server nobody can see. Both are the kind
   * of staleness that makes people stop trusting a dashboard.
   */
  private async reconcileRemoved(active: UpstreamTarget[]): Promise<void> {
    const activeIds = new Set(active.map((target) => target.id));

    const rows = await this.options.db.query<{ id: string; slug: string; enabled: boolean }>(
      'SELECT id, slug, enabled FROM mcp_servers',
    );
    const known = new Map(rows.rows.map((row) => [row.id, row]));
    for (const row of rows.rows) this.slugById.set(row.id, row.slug);

    // Disabled upstreams: mark them disabled, close the connection, clear the gauge.
    for (const row of rows.rows) {
      if (!row.enabled && !activeIds.has(row.id)) {
        if (this.lastLogged.get(row.id) !== 'disabled') {
          this.lastLogged.set(row.id, 'disabled');
          this.options.logger.info({ slug: row.slug }, 'upstream disabled, closing connection');
        }
        await this.options.pool.disable(row.id);
        await this.options.db.query(
          `UPDATE mcp_servers SET status = 'disabled', last_error = NULL WHERE id = $1`,
          [row.id],
        );
        forgetUpstream(this.options.metrics, row.slug);
      }
    }

    // Deleted upstreams: forget them entirely. The pool keeps state keyed by server id, so
    // without this a long-lived pod accumulates an entry per deleted upstream.
    const seen = new Set([...this.options.pool.snapshot().keys(), ...this.slugById.keys()]);
    for (const serverId of seen) {
      if (!known.has(serverId)) {
        const slug = this.slugById.get(serverId);
        await this.options.pool.forget(serverId);
        if (slug !== undefined) {
          // Clear the metric series as well as the pool entry. The gauge is labelled by
          // slug, which is why it had to be remembered - see slugById.
          forgetUpstream(this.options.metrics, slug);
          this.options.logger.info({ slug }, 'upstream removed, forgetting its state');
        }
        this.lastLogged.delete(serverId);
        this.slugById.delete(serverId);
      }
    }
  }
}
