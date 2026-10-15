/**
 * The MCP client pool: one connected `Client` per enabled upstream, per gateway replica.
 *
 * This is the gateway's other half. It is an MCP *server* on `/mcp` and an MCP *client* to
 * every registered upstream, and this file is the client side.
 *
 * **Per replica, not shared.** Each gateway pod keeps its own pool, which follows from the
 * stateless design rather than being a separate decision: there is nothing to share
 * because a connection is not state anyone else needs. The consequence worth stating is
 * arithmetic - N replicas means N connections per upstream, so an upstream with a
 * connection limit sees twice what a single gateway would. With two replicas and a handful
 * of upstreams that is noise; it is the kind of number that stops being noise at thirty
 * replicas, and the answer then is a shared proxy rather than a shared pool.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from '../logger.js';
import { checkUrl, describeRejection } from '../security/ssrf.js';
import { CredentialError, type UpstreamTarget } from './upstreams.js';

/** What the dashboard shows, and what `mcp_servers.status` stores. */
export type UpstreamStatus = 'unknown' | 'connected' | 'unreachable' | 'disabled';

export interface PoolEntry {
  status: UpstreamStatus;
  /**
   * The human-readable reason, which the brief requires the dashboard to display.
   *
   * Written as `| undefined` rather than just `?`, and the same for the two below.
   * Under exactOptionalPropertyTypes those mean different things - `?` is "may be
   * absent" while `| undefined` is "may be absent OR explicitly cleared" - and these
   * genuinely need clearing: a stale failure reason sitting next to a connected status
   * is the kind of dashboard that makes people distrust the dashboard.
   */
  lastError?: string | undefined;
  consecutiveFailures: number;
  /** Earliest time a reconnect may be attempted. See the backoff note in connect(). */
  retryAfter?: number | undefined;
  lastValidatedAt?: number | undefined;
}

export class UpstreamUnavailableError extends Error {
  constructor(
    readonly slug: string,
    readonly reason: string,
  ) {
    // The slug is in the message on purpose. "Unreachable" with no subject is the thing
    // the brief explicitly asks us not to produce.
    super(`upstream "${slug}" is unavailable: ${reason}`);
    this.name = 'UpstreamUnavailableError';
  }
}

export interface PoolOptions {
  logger: Logger;
  allowlist: string[];
  privateHosts: string[];
  /**
   * How long a successful SSRF validation is trusted before the URL is re-checked.
   *
   * This is the call-time half of the DNS-rebinding defence promised in 4.6. Validating
   * once at registration tells you where the name pointed then; a long-lived connection
   * would otherwise never be re-examined. Re-checking on every single call would add a
   * DNS round trip to every tool invocation, so the compromise is a short TTL: the window
   * in which a rebind goes unnoticed is bounded by this number rather than by the
   * connection's lifetime.
   *
   * 60s rather than something smaller because the resolver caches anyway, so a lower
   * value buys less than it looks. Stated as a bound rather than a guarantee - the fully
   * closed version pins the validated address and connects to that, which is recorded as
   * a known gap.
   */
  validationTtlMs?: number;
}

const DEFAULT_VALIDATION_TTL_MS = 60_000;

/** Caps the exponential backoff. A dead upstream is retried every 30s, not every 30min. */
const MAX_BACKOFF_MS = 30_000;

/**
 * The first backoff window, and the number is chosen from measurement rather than taste.
 *
 * The first version used 1s, doubling. That looked sensible and did almost nothing,
 * because a *connection* failure is not instant: against a stopped upstream the attempt
 * takes about ten seconds to time out. So by the time the next call arrived, a 1s - then
 * 2s, then 4s - window had already expired, and the first four calls each paid the full
 * ten seconds before the backoff finally outgrew the failure latency.
 *
 * The lesson generalises: **a backoff window shorter than the failure it is backing off
 * from is not a backoff.** It has to exceed how long failing takes, or every caller still
 * pays full price. 5s doubling to a 30s ceiling means the second call to a dead upstream
 * fails in milliseconds with the reason the first one discovered, which is what the brief
 * asks for - a clear error rather than a hang.
 */
const BASE_BACKOFF_MS = 5_000;

interface Connection {
  client: Client;
  transport: StreamableHTTPClientTransport;
  /** The URL + header set this connection was built with, so a change can be detected. */
  fingerprint: string;
}

export class ClientPool {
  private readonly connections = new Map<string, Connection>();
  private readonly state = new Map<string, PoolEntry>();
  /** In-flight connects, so N concurrent calls to a cold upstream make ONE connection. */
  private readonly connecting = new Map<string, Promise<Client>>();
  private readonly validationTtlMs: number;

  constructor(private readonly options: PoolOptions) {
    this.validationTtlMs = options.validationTtlMs ?? DEFAULT_VALIDATION_TTL_MS;
  }

  /** Everything the dashboard and the prober need, without touching the network. */
  snapshot(): Map<string, PoolEntry> {
    return new Map(this.state);
  }

  entry(serverId: string): PoolEntry {
    return this.state.get(serverId) ?? { status: 'unknown', consecutiveFailures: 0 };
  }

  /**
   * Returns a connected client for this upstream, connecting if necessary.
   *
   * Lazy, deliberately: nothing connects at startup. A gateway that dialled every upstream
   * before it could serve would be a gateway that fails to start when an upstream is down -
   * and would report CrashLoopBackOff, which blames the gateway for someone else's outage.
   * The same reasoning as not connecting to Postgres before `listen()`.
   */
  async get(target: UpstreamTarget): Promise<Client> {
    const inFlight = this.connecting.get(target.id);
    if (inFlight !== undefined) {
      // Deliberately share the in-flight promise rather than starting a second connect.
      // Without this, ten concurrent tool calls against a cold upstream open ten
      // connections and nine of them leak, because only the last one is remembered.
      return inFlight;
    }

    const existing = this.connections.get(target.id);
    if (existing !== undefined) {
      const fingerprint = fingerprintTarget(target);
      if (existing.fingerprint !== fingerprint) {
        /**
         * The URL or the credential changed, so the connection is stale.
         *
         * `requestInit` is fixed when the transport is constructed, so an existing
         * connection keeps sending the old header forever. Without this check a rotated
         * upstream credential would appear to work until something happened to restart
         * the pod - which could be weeks, and the symptom would be 401s from the upstream
         * that look like the upstream's fault.
         */
        this.options.logger.info(
          { slug: target.slug },
          'upstream url or credential changed, reconnecting',
        );
        await this.drop(target.id);
      } else if (await this.stillValid(target)) {
        return existing.client;
      } else {
        // Re-validation failed: the URL now resolves somewhere it should not. Drop the
        // connection rather than keep using it.
        await this.drop(target.id);
        throw new UpstreamUnavailableError(target.slug, this.entry(target.id).lastError ?? 'revalidation failed');
      }
    }

    const attempt = this.connect(target);
    this.connecting.set(target.id, attempt);
    try {
      return await attempt;
    } finally {
      this.connecting.delete(target.id);
    }
  }

  /**
   * Runs one operation against an upstream, and OWNS the failure accounting for it.
   *
   * This exists because handing out a raw client was not enough, and the gap was only
   * visible once an upstream actually died mid-life. `get()` accounts for failures while
   * *connecting*; it cannot see a failure on an already-established connection. So a pool
   * holding a cached connection to an upstream that has since stopped reported
   * `connected` indefinitely, applied no backoff - because no reconnect was attempted -
   * and paid the full request timeout on every single call. One dead upstream made every
   * call to it slow, forever, which is exactly what the backoff was written to prevent.
   *
   * Putting the call inside the pool fixes it structurally rather than asking every caller
   * to remember to report back. The component that owns the connection is the only one
   * that can correctly decide a connection is dead, drop it, and start backing off.
   *
   * On success the upstream is marked connected and the failure count resets - so an
   * upstream that recovers is noticed by the next successful call rather than needing a
   * restart.
   */
  async use<T>(target: UpstreamTarget, operation: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.get(target);

    try {
      const result = await operation(client);
      // Reset on success. Without this a flapping upstream keeps a stale failure count
      // and backs off ever longer despite working.
      if (this.entry(target.id).consecutiveFailures > 0 || this.entry(target.id).status !== 'connected') {
        this.setState(target.id, { status: 'connected', consecutiveFailures: 0, retryAfter: undefined });
        this.state.set(target.id, { ...this.entry(target.id), lastError: undefined });
      }
      return result;
    } catch (error) {
      const reason = describeUpstreamError(error);
      // Drop the connection before recording the failure. The connection is, by
      // definition, no longer known to work - keeping it would mean the next call pays
      // the same timeout against the same dead socket instead of either reconnecting or
      // failing fast on the backoff.
      await this.drop(target.id);
      this.recordFailure(target, reason);
      throw new UpstreamUnavailableError(target.slug, reason);
    }
  }

  /**
   * Re-runs the SSRF guard if the cached validation has expired.
   *
   * Returns true when the URL is still acceptable. Records the reason and returns false
   * when it is not, so the caller can report something specific.
   */
  private async stillValid(target: UpstreamTarget): Promise<boolean> {
    const entry = this.entry(target.id);
    const age = Date.now() - (entry.lastValidatedAt ?? 0);
    if (age < this.validationTtlMs) return true;

    const guard = await checkUrl(target.url, {
      allowlist: this.options.allowlist,
      privateHosts: this.options.privateHosts,
    });

    if (!guard.ok) {
      const reason = `the URL is no longer permitted: ${describeRejection(guard.reason)}`;
      // Logged at warn, because a URL that passed at registration and fails now is either
      // a misconfiguration or an attack, and both are worth seeing.
      this.options.logger.warn(
        { slug: target.slug, url: target.url, reason: guard.reason.kind },
        'upstream failed SSRF re-validation',
      );
      this.setState(target.id, { status: 'unreachable', lastError: reason });
      return false;
    }

    this.setState(target.id, { lastValidatedAt: Date.now() });
    return true;
  }

  private async connect(target: UpstreamTarget): Promise<Client> {
    const entry = this.entry(target.id);

    /**
     * Backoff, checked before anything else.
     *
     * Without it, every request to a dead upstream pays a full connection timeout, so one
     * dead upstream makes every tool call slow - including calls to healthy upstreams, if
     * anything serialises on them. The backoff turns the second and subsequent attempts
     * into an immediate, cheap failure carrying the reason the first one produced.
     *
     * The error says how long is left rather than just "backing off", because the useful
     * question when debugging is "will it retry, and when".
     */
    if (entry.retryAfter !== undefined && Date.now() < entry.retryAfter) {
      const waitMs = entry.retryAfter - Date.now();
      throw new UpstreamUnavailableError(
        target.slug,
        `${entry.lastError ?? 'previous connection failed'} (not retrying for another ${Math.ceil(waitMs / 1000)}s)`,
      );
    }

    // The SSRF guard runs before the connection is made, every time a connection is made.
    const guard = await checkUrl(target.url, {
      allowlist: this.options.allowlist,
      privateHosts: this.options.privateHosts,
    });
    if (!guard.ok) {
      const reason = `the URL is not permitted: ${describeRejection(guard.reason)}`;
      this.recordFailure(target, reason);
      throw new UpstreamUnavailableError(target.slug, reason);
    }

    const client = new Client(
      { name: 'urumi-gateway', version: '0.1.0' },
      // No capabilities declared: this client consumes tools and offers the upstream
      // nothing. Declaring sampling or roots we do not implement would invite an upstream
      // to call back into us.
      { capabilities: {} },
    );

    const transport = new StreamableHTTPClientTransport(new URL(target.url), {
      requestInit: {
        headers: target.authHeader === undefined ? {} : { [target.authHeader.name]: target.authHeader.value },
      },
    });

    try {
      // The SDK's connect performs the `initialize` handshake, so a successful return
      // means the upstream is genuinely speaking MCP - not merely that a TCP connection
      // opened. That distinction is why this is the status signal rather than a ping.
      // Cast at the SDK boundary, the mirror image of the one in woo-mcp. The transport
      // declares `sessionId?: string | undefined` while the Transport interface declares
      // `sessionId?: string`, so under exactOptionalPropertyTypes the SDK class does not
      // satisfy the SDK interface. Relaxing the flag for this service would be the easy
      // fix - and would also have stopped it catching the three genuine
      // optional-undefined mistakes it caught in this very file.
      await client.connect(transport as unknown as Transport, { timeout: target.timeoutMs });
    } catch (error) {
      // Close the transport on a failed connect. Without this a failed attempt can leave
      // a socket and its listeners behind, and a dead upstream being retried every 30s
      // accumulates them for as long as the pod lives.
      await safeClose(transport, this.options.logger, target.slug);
      const reason = describeUpstreamError(error);
      this.recordFailure(target, reason);
      throw new UpstreamUnavailableError(target.slug, reason);
    }

    this.connections.set(target.id, {
      client,
      transport,
      fingerprint: fingerprintTarget(target),
    });
    this.setState(target.id, {
      status: 'connected',
      consecutiveFailures: 0,
      lastValidatedAt: Date.now(),
    });
    // lastError is cleared explicitly, because a stale reason next to a connected status
    // is the kind of dashboard that makes people distrust the dashboard.
    this.state.set(target.id, { ...this.entry(target.id), lastError: undefined });

    this.options.logger.info({ slug: target.slug, url: target.url }, 'connected to upstream');
    return client;
  }

  private recordFailure(target: UpstreamTarget, reason: string): void {
    const failures = this.entry(target.id).consecutiveFailures + 1;
    /**
     * Exponential with a ceiling: 5s, 10s, 20s, 30s, 30s...
     *
     * No jitter, unlike the WooCommerce client's retry. These are per-replica reconnects
     * rather than a thundering herd of in-flight requests, and 5.2's prober has its own
     * interval which already spreads them.
     *
     * One consequence the testing made visible and worth stating: **the backoff is per
     * replica, not global.** With two replicas behind the Ingress, consecutive calls land
     * alternately, each pool keeps its own failure count, and a dead upstream therefore
     * sees roughly twice the retry rate one gateway would produce - and a caller can see
     * a fast failure from one replica and a slow one from the other until both have
     * learned. That is inherent to per-replica pools rather than a bug, and the fix if it
     * ever mattered is shared state, which is precisely what the stateless design is
     * built to avoid. At two replicas it is noise.
     */
    const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (failures - 1));
    this.setState(target.id, {
      status: 'unreachable',
      lastError: reason,
      consecutiveFailures: failures,
      retryAfter: Date.now() + backoff,
    });
    this.options.logger.warn(
      { slug: target.slug, failures, backoffMs: backoff, reason },
      'upstream connection failed',
    );
  }

  private setState(serverId: string, patch: Partial<PoolEntry>): void {
    this.state.set(serverId, { ...this.entry(serverId), ...patch });
  }

  /** Closes and forgets one upstream's connection, keeping its recorded state. */
  async drop(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    this.connections.delete(serverId);
    if (connection === undefined) return;
    await safeClose(connection.transport, this.options.logger, serverId);
    await safeCloseClient(connection.client, this.options.logger, serverId);
  }

  /** Marks an upstream disabled and drops its connection. Used when an admin disables it. */
  async disable(serverId: string): Promise<void> {
    await this.drop(serverId);
    this.setState(serverId, { status: 'disabled', lastError: undefined, retryAfter: undefined });
  }

  /** Forgets an upstream entirely. Used when an admin deletes it. */
  async forget(serverId: string): Promise<void> {
    await this.drop(serverId);
    this.state.delete(serverId);
  }

  /**
   * Closes every connection. Called during shutdown, before the database pool drains.
   *
   * Settled rather than sequential: one upstream hanging on close must not stop the others
   * being closed, because the whole point is to finish inside the termination grace period.
   */
  async closeAll(): Promise<void> {
    await Promise.allSettled([...this.connections.keys()].map((id) => this.drop(id)));
  }
}

/**
 * A stable fingerprint of the auth header, used to notice a rotated credential.
 *
 * The VALUE is included, because the point is to detect a changed secret - the header name
 * alone would miss a rotation. It never leaves this process and is never logged; it exists
 * only to be compared with the previous one. A hash would be tidier but adds nothing: an
 * attacker who can read this process's memory already has the credential itself.
 */
function fingerprintTarget(target: UpstreamTarget): string {
  const auth =
    target.authHeader === undefined
      ? 'none'
      : `${target.authHeader.name}:${target.authHeader.value}`;
  // The URL is part of the fingerprint, not just the credential. The first version
  // fingerprinted auth alone, which meant an admin editing an upstream's URL left the
  // cached connection talking to the OLD address until the validation TTL happened to
  // expire - so the change appeared to take effect, and did not. A connection is only
  // reusable if BOTH the destination and the credential are unchanged.
  return `${target.url}|${auth}`;
}

/**
 * Turns an upstream failure - connecting OR calling - into one readable sentence.
 *
 * The brief asks the dashboard to show *why* an upstream is unreachable, so this is the
 * function that decides what an operator reads. A credential problem is named as such
 * rather than reported as a connection failure, because the two have completely different
 * fixes and look identical from the outside.
 */
function describeUpstreamError(error: unknown): string {
  if (error instanceof CredentialError) return error.message;

  if (error instanceof Error) {
    /**
     * JSON-RPC codes first, because an McpError carries its code as a NUMBER on the error
     * itself while the switch below reads undici's string `cause.code`. The first version
     * only had the undici switch, so every McpError fell through to its raw message and a
     * client saw "MCP error -32001: Request timed out" - the protocol's own wire text, with
     * a number nobody should have to look up.
     *
     * Three raw strings reached a client during stage 5 - "fetch failed", "Connection
     * closed" and this one - each found only by stopping a real upstream and reading what
     * came out. The pattern is the lesson: every layer that re-raises someone else's error
     * needs a default that is readable, not just a happy path that is. These are the
     * sentences the dashboard, the audit log and an LLM all see.
     */
    const rpcCode = (error as { code?: unknown }).code;
    if (typeof rpcCode === 'number') {
      switch (rpcCode) {
        case -32001:
          /**
           * RequestTimeout: the request did not complete inside its budget.
           *
           * The first wording said "the upstream accepted the request but did not answer",
           * on the assumption that -32001 implies an established connection. It does not,
           * and testing against a Service with zero endpoints proved it: the TCP connect
           * simply hung, the request timeout fired first, and a client was told an
           * upstream had accepted a request when nothing was listening at all.
           *
           * So this says only what the code actually evidences. Guessing at a cause from
           * an error code is the same mistake as reading one out of another component's
           * prose - decision 2.75 - and this time I made it in the fix for that.
           */
          return 'the request did not complete within the timeout';
        case -32000:
          return 'the connection closed before the call completed, which usually means the upstream stopped or restarted';
        default:
          break;
      }
    }

    const cause = (error as { cause?: unknown }).cause;
    const code = typeof cause === 'object' && cause !== null && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : undefined;

    switch (code) {
      case 'ECONNREFUSED':
        return 'connection refused: nothing is listening on that address and port';
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return 'the hostname could not be resolved';
      case 'ECONNRESET':
        return 'the connection was reset before the handshake finished';
      case 'UND_ERR_CONNECT_TIMEOUT':
      case 'ETIMEDOUT':
        return 'the connection attempt timed out';
      default:
        break;
    }

    /**
     * "fetch failed" is undici's message when it cannot open the socket at all, and with
     * no `cause.code` attached it is the single least useful string a dashboard could
     * show. It was the literal output of the first version of this function against a
     * stopped upstream. Translated, because "unreachable: fetch failed" tells an operator
     * nothing they did not already know.
     */
    if (error.message === 'fetch failed') {
      return 'the upstream could not be reached: the connection could not be opened';
    }

    /**
     * A belt-and-braces fallback for a "connection closed" that arrives without the
     * numeric code above - a transport-level close raised as a plain Error rather than an
     * McpError. Kept deliberately: the cost is one regex, and the thing it guards against
     * is the SDK's wire text reaching a user.
     *
     * Translated HERE rather than at the call site, which is the point. The first attempt
     * put this in mcp/server.ts and it never ran: a pool failure is wrapped in
     * UpstreamUnavailableError, whose reason the caller forwards verbatim - correctly, by
     * decision 2.75, because the pool is the component that knows what happened. A
     * translation added above that wrapper is unreachable for everything the pool handles.
     * Fixing it here also fixes the prober's persisted reason, the admin test route and the
     * dashboard's status text, which the call-site version left untouched.
     */
    if (/connection closed/i.test(error.message)) {
      return 'the connection closed before the call completed, which usually means the upstream stopped or restarted';
    }

    // Trimmed, because an SDK error message can be long and the dashboard shows this in a
    // table cell. The full error is already in the log line next to it.
    return error.message.slice(0, 200);
  }

  return String(error).slice(0, 200);
}

async function safeClose(
  transport: StreamableHTTPClientTransport,
  logger: Logger,
  subject: string,
): Promise<void> {
  try {
    await transport.close();
  } catch (error) {
    // Swallowed into a debug line on purpose: a failure while closing something we are
    // discarding anyway must not propagate into the caller's error path, where it would
    // replace the real reason with a cleanup artefact.
    logger.debug({ subject, err: error }, 'error closing upstream transport');
  }
}

async function safeCloseClient(client: Client, logger: Logger, subject: string): Promise<void> {
  try {
    await client.close();
  } catch (error) {
    logger.debug({ subject, err: error }, 'error closing upstream client');
  }
}
