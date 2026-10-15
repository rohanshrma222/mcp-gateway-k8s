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
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type { ApiKeyPrincipal } from '../auth/apiKeys.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { listAggregatedTools, resolveTool } from './aggregator.js';
import { splitToolName } from './naming.js';
import { UpstreamUnavailableError, type ClientPool } from './pool.js';
import { CredentialError, loadUpstream } from './upstreams.js';

export interface GatewayServerDeps {
  db: Db;
  logger: Logger;
  metrics: Metrics;
  pool: ClientPool;
  encryptionKey: string;
  /** Who is calling. Resolved from the Bearer key before the server is built. */
  principal: ApiKeyPrincipal;
  requestId: string;
}

/** Matches `audit_log.outcome`, so a metric label and a database row use one vocabulary. */
export type CallOutcome = 'ok' | 'error' | 'denied' | 'timeout';

export interface CallRecord {
  serverSlug?: string;
  toolName: string;
  outcome: CallOutcome;
  durationMs: number;
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
  /** Populated as calls are handled, so the HTTP layer can write audit rows in 6.1. */
  records: CallRecord[];
} {
  const records: CallRecord[] = [];

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
  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const startedAt = Date.now();
    const exposedName = request.params.name;

    const finish = (outcome: CallOutcome, message?: string, slug?: string): void => {
      const durationMs = Date.now() - startedAt;
      records.push({
        toolName: exposedName,
        outcome,
        durationMs,
        ...(slug === undefined ? {} : { serverSlug: slug }),
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
    const fail = (message: string, outcome: CallOutcome, slug?: string): CallToolResult => {
      finish(outcome, message, slug);
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
          resolved.reason.slug,
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
      return fail(`unknown tool "${exposedName}". ${hint}`, 'error');
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
        return fail(error.message, 'error', tool.serverSlug);
      }
      throw error;
    }

    if (loaded === undefined) {
      // The row vanished between resolving the tool and loading the server - an admin
      // deleted it mid-call. Rare, and reported honestly rather than as a 500.
      return fail(
        `the server "${tool.serverSlug}" was removed while this call was being prepared`,
        'error',
        tool.serverSlug,
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
      finish(upstreamFailed ? 'error' : 'ok', undefined, tool.serverSlug);

      deps.logger.info(
        {
          requestId: deps.requestId,
          userId: deps.principal.userId,
          keyId: deps.principal.keyId,
          server: tool.serverSlug,
          tool: exposedName,
          upstreamTool: tool.upstreamToolName,
          durationMs: Date.now() - startedAt,
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
        // The pool already reduced this to an operator-readable sentence - a connect
        // timeout, a refused connection, a backoff refusal with its countdown. Forwarded
        // verbatim rather than re-described, because the pool knows which it was and this
        // handler does not.
        return fail(
          `the server "${tool.serverSlug}" could not be reached: ${error.reason}`,
          'error',
          tool.serverSlug,
        );
      }

      /**
       * A RequestTimeout from the SDK is the genuine article: the connection was
       * established, the request was sent, and the upstream did not answer inside the
       * budget. That is the only case where quoting the configured timeout is truthful.
       */
      if (isRequestTimeout(error)) {
        return fail(
          `the server "${tool.serverSlug}" accepted the request but did not respond within ${loaded.target.timeoutMs}ms`,
          'timeout',
          tool.serverSlug,
        );
      }

      const reason = describeCallError(error);
      return fail(
        `the server "${tool.serverSlug}" could not be reached: ${reason}`,
        'error',
        tool.serverSlug,
      );
    }
  });

  return { server, records };
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
 * `timeout` is its own audit outcome for exactly this reason: "accepted the request but did
 * not respond" tells an operator the upstream is overloaded, while "could not be reached"
 * tells them it is down. Those lead to different actions, so conflating them loses
 * information the audit log exists to keep.
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
