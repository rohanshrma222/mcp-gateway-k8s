/**
 * The gateway's own MCP server: the single endpoint Claude Code and MCP Inspector connect
 * to, exposing every upstream's tools as one set.
 *
 * Built on the SDK's **low-level `Server`** with explicit request handlers, not the
 * higher-level `McpServer.registerTool`. That is the central implementation decision here
 * and it follows from what a gateway is.
 *
 * `registerTool` wants a zod schema per tool so it can validate arguments for you. But an
 * upstream publishes JSON Schema, and this gateway has no business reinterpreting it:
 * converting JSON Schema to zod and back would mean a client sees a schema the upstream
 * never published, and an argument that validates here and is rejected there - or worse,
 * one that passes both but means something different. A proxy's job is to forward the
 * schema verbatim and let the upstream be the authority on its own arguments. The low-level
 * handlers let the schema through untouched.
 *
 * The same reasoning covers validation: the gateway deliberately does NOT validate
 * `tools/call` arguments. The upstream already does, with the schema it actually published,
 * and woo-mcp's own zod rejection is a better error than anything a second validator could
 * produce. Two validators is one more place for them to disagree.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  type CallToolRequest,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ApiKeyPrincipal } from '../auth/apiKeys.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { listAggregatedTools, resolveTool } from './aggregator.js';
import { splitToolName } from './naming.js';
import { UpstreamUnavailableError, type ClientPool, type UpstreamFailureKind } from './pool.js';
import { CredentialError, loadUpstream } from './upstreams.js';
import { recordCalls, type AuditErrorCode, type AuditRow } from '../audit.js';

export interface GatewayServerDeps {
  db: Db;
  logger: Logger;
  metrics: Metrics;
  pool: ClientPool;
  encryptionKey: string;
  /** Who is calling. Resolved from the Bearer key before the server is built. */
  principal: ApiKeyPrincipal;
  requestId: string;
  /**
   * Which door the call came through.
   *
   * 'external' for a Bearer-authenticated MCP client such as Claude Code. Stage 8's chat
   * agent passes 'chat' - and it is a parameter rather than a constant here precisely
   * because that agent connects to this same endpoint by the same code path, which is what
   * makes its audit attribution unarguable: it is the real user's row, distinguished only
   * by the door.
   */
  actor: 'chat' | 'external';
}

/** Matches `audit_log.outcome`, so a metric label and a database row use one vocabulary. */
export type CallOutcome = 'ok' | 'error' | 'denied' | 'timeout';

export interface CallRecord {
  serverId?: string;
  serverSlug?: string;
  toolName: string;
  outcome: CallOutcome;
  /** The real start of the call, not the time the row is written. See audit.ts. */
  startedAt: Date;
  durationMs: number;
  errorCode?: AuditErrorCode;
  errorMessage?: string;
}

/**
 * Builds a fresh MCP server for one request.
 *
 * Per request, with no session id, exactly as woo-mcp does and for the same reason: any
 * replica must be able to answer any request, so there is no session state to keep and no
 * sticky routing to arrange. Construction is cheap because everything expensive - the
 * database pool, the upstream connections, the metrics registry - is passed in rather than
 * created here.
 */
export function buildGatewayServer(deps: GatewayServerDeps): {
  server: Server;
  /**
   * What this request did, as audit rows are written from it.
   *
   * Still exposed although the handler now writes its own rows: the HTTP layer uses it to
   * tell a request that did nothing from one that called a tool, and a test can assert on
   * it without reading the database.
   */
  records: CallRecord[];
} {
  const records: CallRecord[] = [];
  /**
   * How much of `records` has already been written.
   *
   * An index rather than clearing the array, because `records` is returned to the caller
   * and the HTTP layer reads it after the response - emptying it on flush would make a
   * handled call look like a request that did nothing.
   */
  let pendingFrom = 0;

  const server = new Server(
    { name: 'urumi-gateway', version: '0.1.0' },
    {
      capabilities: {
        // Tools only. `listChanged` is declared because the set genuinely does change when
        // an admin registers or disables an upstream - a client is right to re-list.
        tools: { listChanged: true },
      },
      instructions:
        'Tools from every MCP server registered with this gateway. Each name is prefixed with its ' +
        'source server, as <server>__<tool>, so identically named tools on different servers are ' +
        'distinct. Calls are made on your behalf using credentials held by the gateway; you never ' +
        'see them. Every call is recorded in an audit log against your account.',
    },
  );

  /**
   * `tools/list` - answered entirely from the cache. See mcp/aggregator.ts.
   *
   * Nothing here touches an upstream, which is what makes this survive an outage: a dead
   * upstream's tools are still listed, and the error arrives on call instead. The schema
   * and annotations are passed through exactly as the upstream published them.
   */
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await listAggregatedTools(deps.db);

    deps.logger.debug(
      { requestId: deps.requestId, userId: deps.principal.userId, toolCount: tools.length },
      'served tools/list from cache',
    );

    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        ...(tool.title === undefined ? {} : { title: tool.title }),
        ...(tool.description === undefined ? {} : { description: tool.description }),
        // Cast because the SDK types inputSchema as an object with a required `type`
        // literal, while this value is whatever JSON Schema the upstream published and is
        // forwarded verbatim rather than reshaped. Reshaping it is the thing this file
        // exists to avoid.
        inputSchema: tool.inputSchema as { type: 'object' },
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      })),
    };
  });

  /**
   * `tools/call` - the path the whole project exists to serve.
   *
   * Order: resolve the prefixed name, check permission, call through the pool with a
   * timeout, and turn every failure into a structured result that names the server.
   */
  /**
   * The registered handler is a WRAPPER, and the structure is the point.
   *
   * `handleCall` below has eight return points - unknown tool, disabled server, bad
   * credential, server deleted mid-call, unreachable, timeout, an upstream's own error,
   * success. Writing the audit row at each one would mean the audit log is complete only
   * as long as nobody adds a ninth and forgets, and the thing most likely to be forgotten
   * is the path added in a hurry to handle a failure.
   *
   * So there is exactly ONE write point, and it sits where it cannot be bypassed: after
   * the inner function returns, whatever it returns. The same argument produced
   * `pool.use()` in 5.1 - if correctness depends on every caller remembering to report a
   * result, it is the wrong interface.
   *
   * The write is awaited before the result is returned, so the client does not learn the
   * outcome before the system has recorded it. `recordCalls` explains the one deliberate
   * exception: once an upstream side effect has landed, a failed audit write is logged and
   * counted rather than turned into a lie about a mutation that happened.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    let result: CallToolResult;
    try {
      result = await handleCall(request);
    } catch (error) {
      /**
       * handleCall is not expected to throw - every failure it knows about becomes an
       * isError result. If it does, the call still happened and must still be recorded, so
       * the row is written before the error propagates. An audit log that is complete
       * except when something surprising happened is not much of an audit log.
       */
      records.push({
        toolName: request.params.name,
        outcome: 'error',
        startedAt: new Date(),
        durationMs: 0,
        errorCode: 'internal_error',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      await flushRecords();
      throw error;
    }

    await flushRecords();
    return result;
  });

  /** Drains `records` into the audit log. Called once per handled call. */
  async function flushRecords(): Promise<void> {
    if (pendingFrom >= records.length) return;
    const fresh = records.slice(pendingFrom);
    pendingFrom = records.length;

    const rows: AuditRow[] = fresh.map((record) => ({
      userId: deps.principal.userId,
      apiKeyId: deps.principal.apiKeyId,
      userEmail: deps.principal.email,
      toolName: record.toolName,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      outcome: record.outcome,
      actor: deps.actor,
      requestId: deps.requestId,
      ...(record.serverId === undefined ? {} : { serverId: record.serverId }),
      ...(record.serverSlug === undefined ? {} : { serverSlug: record.serverSlug }),
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
      ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
    }));

    await recordCalls(deps.db, deps.logger, deps.metrics, rows);
  }

  async function handleCall(request: CallToolRequest): Promise<CallToolResult> {
    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs);
    const exposedName = request.params.name;

    const finish = (
      outcome: CallOutcome,
      message?: string,
      server?: { slug: string; id?: string },
      code?: AuditErrorCode,
    ): void => {
      const durationMs = Date.now() - startedAtMs;
      const slug = server?.slug;
      records.push({
        toolName: exposedName,
        outcome,
        startedAt,
        durationMs,
        ...(slug === undefined ? {} : { serverSlug: slug }),
        ...(server?.id === undefined ? {} : { serverId: server.id }),
        ...(code === undefined ? {} : { errorCode: code }),
        ...(message === undefined ? {} : { errorMessage: message }),
      });

      // Labels use the slug, or a literal 'unknown' rather than the tool name a caller
      // invented - otherwise an attacker could create unbounded metric series just by
      // calling random names, which is the cardinality trap described in metrics.ts.
      deps.metrics.toolCalls.inc({ server: slug ?? 'unknown', tool: slug === undefined ? 'unknown' : exposedName, outcome });
      if (slug !== undefined) {
        deps.metrics.toolCallDuration.observe({ server: slug, tool: exposedName }, durationMs / 1000);
      }
    };

    /**
     * Every failure below returns `isError: true` inside a RESULT, never a thrown
     * protocol error. The distinction is the one woo-mcp established and it matters more
     * here, because this gateway is what an LLM talks to: a protocol error reads as "the
     * server is broken" and aborts a tool loop, while a result flagged as an error is
     * information the model can act on - try a different tool, tell the user that server
     * is down, ask for a different argument.
     */
    const fail = (
      message: string,
      outcome: CallOutcome,
      code: AuditErrorCode,
      server?: { slug: string; id?: string },
    ): CallToolResult => {
      finish(outcome, message, server, code);
      deps.logger.warn(
        {
          requestId: deps.requestId,
          userId: deps.principal.userId,
          keyId: deps.principal.keyId,
          tool: exposedName,
          outcome,
        },
        'tool call refused',
      );
      return { content: [{ type: 'text', text: message }], isError: true };
    };

    const resolved = await resolveTool(deps.db, exposedName);

    if (!resolved.ok) {
      if (resolved.reason.kind === 'server-disabled') {
        return fail(
          `the server "${resolved.reason.slug}" is currently disabled, so "${exposedName}" cannot be called. An administrator can re-enable it.`,
          'denied',
          'server_disabled',
          { slug: resolved.reason.slug },
        );
      }

      /**
       * Unknown tool. The guess from parsing the name is used only to make the message
       * more useful - see naming.ts on why the parse is a hint rather than an authority.
       */
      const guess = splitToolName(exposedName);
      const hint =
        guess === undefined
          ? 'Tool names are of the form <server>__<tool>; call tools/list to see what is available.'
          : `No server "${guess.slug}" exposes a tool matching that name. Call tools/list to see what is available.`;
      return fail(`unknown tool "${exposedName}". ${hint}`, 'error', 'unknown_tool');
    }

    const tool = resolved.tool;

    /**
     * The permission check goes HERE, and today it is a deliberate no-op.
     *
     * Stage 9 adds per-user and per-role tool permissions, resolved against the
     * `tool_permissions` table built in migration 004. The hook is in place at the correct
     * point - after resolution, before any upstream is contacted - so that step wires in
     * a decision rather than restructuring this handler.
     *
     * The requirement it must satisfy is already decided: a tool a user may not call is
     * BOTH hidden from `tools/list` and refused here. Hiding alone is a UI convenience an
     * attacker skips by guessing the name, which is why this check is on the call path and
     * not only on the list path. The outcome vocabulary already includes `denied` for
     * exactly this.
     */

    let loaded;
    try {
      loaded = await loadUpstream(deps.db, deps.encryptionKey, tool.serverId);
    } catch (error) {
      if (error instanceof CredentialError) {
        // Named rather than reported as a connection failure: a rotated encryption key and
        // an unreachable server look identical from outside and have different fixes.
        return fail(error.message, 'error', 'credential_error', { slug: tool.serverSlug, id: tool.serverId });
      }
      throw error;
    }

    if (loaded === undefined) {
      // The row vanished between resolving the tool and loading the server - an admin
      // deleted it mid-call. Rare, and reported honestly rather than as a 500.
      return fail(
        `the server "${tool.serverSlug}" was removed while this call was being prepared`,
        'error',
        'server_removed',
        { slug: tool.serverSlug },
      );
    }

    try {
      /**
       * The call itself, through the pool so the circuit breaker applies.
       *
       * `pool.use` owns the failure accounting: an upstream that has gone away is dropped
       * and put into backoff, so the *second* call fails in milliseconds with the reason
       * the first discovered rather than paying the timeout again. That is the breaker -
       * built in 5.1 and consumed here rather than implemented a second time.
       *
       * The timeout is the upstream's own configured value, so a slow store gets the
       * patience an admin chose for it. Note what is NOT reset here: progress
       * notifications do not extend the deadline, because a tool that keeps reporting
       * progress forever is indistinguishable from one that is stuck.
       */
      const result = await deps.pool.use(loaded.target, (client) =>
        client.callTool(
          { name: tool.upstreamToolName, arguments: request.params.arguments ?? {} },
          undefined,
          { timeout: loaded.target.timeoutMs },
        ),
      );

      // An upstream's own isError result is forwarded as-is and recorded as `error`. It
      // means the call round-tripped and the answer was negative - "no such order 999" -
      // which the model should see verbatim rather than wrapped in our own phrasing.
      const upstreamFailed = result.isError === true;
      /**
       * When the upstream says no, its own words go in the audit row.
       *
       * The first version passed `undefined` here, because this branch forwards the result
       * verbatim and never builds a message of its own. Querying the table showed the
       * consequence: a row reading `outcome=error, error_code=upstream_error` with an
       * empty reason - which is the exact failure `003_audit_log.sql` warns about in
       * another context, a row that "looks like data" while saying nothing. An operator
       * asking why a call failed would have had to go and find the gateway's logs.
       *
       * The text is already in the result; it just had to be read out of it.
       */
      finish(
        upstreamFailed ? 'error' : 'ok',
        upstreamFailed ? describeResultError(result) : undefined,
        { slug: tool.serverSlug, id: tool.serverId },
        upstreamFailed ? 'upstream_error' : undefined,
      );

      deps.logger.info(
        {
          requestId: deps.requestId,
          userId: deps.principal.userId,
          keyId: deps.principal.keyId,
          server: tool.serverSlug,
          tool: exposedName,
          upstreamTool: tool.upstreamToolName,
          durationMs: Date.now() - startedAtMs,
          outcome: upstreamFailed ? 'error' : 'ok',
        },
        'tool call completed',
      );

      return result as CallToolResult;
    } catch (error) {
      /**
       * The message names the server, which the brief asks for explicitly. "Unreachable"
       * on its own is the thing it says not to produce - and for an LLM caller the server
       * name is what lets it tell the user something useful.
       *
       * The two branches are chosen by the error's TYPE, not by matching words in its
       * prose. The first version asked `isTimeout()`, which among other things looked for
       * "timed out" anywhere in the message - and the pool's backoff refusal reads
       * "the connection attempt timed out (not retrying for another 25s)". So a refusal
       * that returned in 192ms was reported as "did not respond within 20000ms": a
       * fabricated duration, in exactly the register this project has been careful to
       * avoid. Substring-matching another component's wording is a coupling that breaks
       * silently the moment that wording improves.
       */
      if (error instanceof UpstreamUnavailableError) {
        /**
         * The pool reduced this to BOTH a readable sentence and a category, and both are
         * used: the sentence goes to the caller verbatim because the pool knows what
         * happened and this handler does not, while the category decides the audit
         * outcome.
         *
         * Before 6.4 this branch hardcoded `upstream_unreachable`, which made the
         * `timeout` outcome and the `upstream_timeout` code unreachable - the check for a
         * request timeout sits BELOW this one, and the pool wraps everything, so nothing
         * ever got there. It took an upstream that could be made slow on demand to notice,
         * because until 6.4 no test could produce a genuine request timeout at all.
         */
        const { outcome, code } = classifyUpstreamFailure(error.kind);
        return fail(
          `the server "${tool.serverSlug}" could not be reached: ${error.reason}`,
          outcome,
          code,
          { slug: tool.serverSlug, id: tool.serverId },
        );
      }

      /**
       * A RequestTimeout that did NOT come through the pool.
       *
       * Everything routed via `pool.use` is wrapped above, so in practice this branch is
       * for a direct SDK call made outside the pool. Kept rather than deleted because the
       * alternative - falling through to the generic handler - would record a genuine
       * timeout as `upstream_unreachable`, which is the bug this step just fixed one layer
       * up. It is a guard against reintroducing it by a different route.
       *
       * It does NOT establish that the upstream received anything. An earlier version said
       * "accepted the request but did not respond", and a Service with zero endpoints
       * disproved it: the connect hung, this timeout fired first, and the message asserted
       * a handshake that never happened. The wording now claims only the timeout.
       */
      if (isRequestTimeout(error)) {
        return fail(
          `the server "${tool.serverSlug}" did not respond within its ${loaded.target.timeoutMs}ms timeout`,
          'timeout',
          'upstream_timeout',
          { slug: tool.serverSlug, id: tool.serverId },
        );
      }

      const reason = describeCallError(error);
      return fail(
        `the server "${tool.serverSlug}" could not be reached: ${reason}`,
        'error',
        'upstream_unreachable',
        { slug: tool.serverSlug, id: tool.serverId },
      );
    }
  }

  return { server, records };
}

/**
 * Maps the pool's failure category onto the audit vocabulary.
 *
 * One place, so the two vocabularies cannot drift apart silently. Written as an exhaustive
 * switch rather than a lookup object so that adding a kind to UpstreamFailureKind is a
 * compile error here rather than a row quietly labelled with whatever the default was.
 */
function classifyUpstreamFailure(kind: UpstreamFailureKind): {
  outcome: CallOutcome;
  code: AuditErrorCode;
} {
  switch (kind) {
    case 'timeout':
      return { outcome: 'timeout', code: 'upstream_timeout' };
    case 'credential':
      return { outcome: 'error', code: 'credential_error' };
    case 'url-forbidden':
      // Not 'denied'. 'denied' is reserved for a decision about the CALLER - a disabled
      // server, and in stage 9 a permission refusal. A URL that fails the SSRF guard is a
      // misconfiguration or an attack on the gateway, which is an error about the upstream
      // and belongs with the other upstream errors when someone filters the audit log.
      return { outcome: 'error', code: 'upstream_unreachable' };
    case 'backoff':
    case 'unreachable':
      // A backoff refusal records as unreachable, because that is what it is: the upstream
      // was unreachable a moment ago and we did not try again. The reason string carries
      // the countdown for whoever reads it.
      return { outcome: 'error', code: 'upstream_unreachable' };
  }
}

/**
 * Pulls a readable reason out of an upstream's own error result.
 *
 * An MCP result carries a list of content blocks, and only text blocks have anything an
 * audit row can use. Non-text blocks - an image, audio, an embedded resource - are
 * described by type rather than skipped silently, because "the tool failed and returned a
 * picture" is itself worth knowing when someone is trying to work out what happened.
 */
function describeResultError(result: unknown): string {
  if (typeof result !== 'object' || result === null) {
    return 'the upstream reported an error with no message';
  }

  /**
   * `unknown` rather than CallToolResult, because the SDK types a call result as a UNION:
   * the modern `{ content: [...] }` shape, or a legacy `{ toolResult: unknown }` one kept
   * for older servers. Typing the parameter as the modern shape does not compile, and
   * casting it would have been a lie that held until the first legacy upstream arrived -
   * precisely the kind of upstream a gateway exists to accommodate. So both shapes are
   * read, and anything else degrades to a sentence rather than throwing inside the audit
   * path.
   */
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content as { type?: unknown; text?: unknown }[]) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      } else if (typeof block.type === 'string') {
        // Described rather than skipped: "the tool failed and returned a picture" is
        // itself worth knowing to someone working out what happened.
        parts.push(`[${block.type} content]`);
      }
    }
    const joined = parts.join(' ').trim();
    if (joined !== '') return joined;
  }

  const legacy = (result as { toolResult?: unknown }).toolResult;
  if (legacy !== undefined) {
    return typeof legacy === 'string' ? legacy : JSON.stringify(legacy).slice(0, 500);
  }

  // A tool is allowed to flag an error with no content at all. Saying so beats an empty
  // column, which is indistinguishable from a bug in this code.
  return 'the upstream reported an error with no message';
}

/**
 * Was this the SDK's own request timeout?
 *
 * Narrow on purpose: only JSON-RPC code -32001 (RequestTimeout), which the SDK raises when
 * a request on an ESTABLISHED connection outlives its deadline. Everything else - a refused
 * connection, a connect timeout, a backoff refusal - arrives as an UpstreamUnavailableError
 * and keeps the pool's own wording, because the pool is the component that knows which it
 * was.
 *
 * `timeout` remains its own audit outcome, but for a narrower and more defensible reason
 * than the one first written here. It does not mean "the upstream is overloaded" - a
 * timeout cannot distinguish a slow server from a connect that never completed. It means
 * "we gave up waiting", as opposed to "the transport told us it had failed", and those are
 * genuinely different events: one is bounded by our own configuration and the other is
 * not.
 */
function isRequestTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === -32001
  );
}

/**
 * Turns a call failure into one readable sentence.
 *
 * "Connection closed" is the SDK's wording when the transport dies under an in-flight
 * request, and it was the literal text a client saw after the upstream was stopped - true,
 * and uninformative, since a client cannot tell from it whether the server is down, was
 * restarted, or dropped the stream. Translated, for the same reason the pool translates
 * undici's "fetch failed".
 */
function describeCallError(error: unknown): string {
  if (error instanceof Error) {
    if (/connection closed/i.test(error.message)) {
      return 'the connection was closed before the call completed, which usually means the upstream stopped or restarted';
    }
    return error.message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}
