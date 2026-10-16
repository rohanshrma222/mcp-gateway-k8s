/**
 * The tool-calling loop: the model, our own `/mcp`, and the user's identity in between.
 *
 * The agent is an MCP **client**. It connects to the gateway's own `/mcp` endpoint over
 * loopback with the ephemeral key from `ephemeralKey.ts`, calls `tools/list`, hands the
 * result to the model as function definitions, and dispatches whatever the model asks for
 * back through `tools/call`. It is the same client code and the same wire protocol that
 * Claude Code uses, which is what makes "the chat agent acts as the logged-in user" a fact
 * about the architecture rather than a promise in a README.
 *
 * **Loopback rather than the Service DNS name**, which is a real choice and not an
 * optimisation. `platform-gateway:3000` would route through the Service and could land on
 * the other replica, so a chat request served by replica A would depend on replica B being
 * healthy - turning a one-pod failure into a user-visible chat failure, for no benefit.
 * `127.0.0.1:PORT` keeps one chat inside one pod. The statelessness that would make the
 * Service route work is still real and still demonstrable through `/mcp` directly; it just
 * is not something to spend availability on here.
 *
 * It does mean the agent's HTTP request is to itself, so the gateway must not be
 * single-threaded-blocking while it waits. Node is not, and the request is `await`ed, so
 * the event loop serves the inbound `/mcp` call while the chat handler waits on it.
 */
import type { Logger } from 'pino';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { LlmMessage, LlmProvider, LlmToolCall } from '../llm/provider.js';
import { LlmError } from '../llm/provider.js';
import { normaliseToolsForModel } from '../llm/schema.js';
import { labelToolDescription, wrapToolOutput } from './untrusted.js';

export interface AgentEvent {
  type: 'text' | 'tool_call' | 'tool_result' | 'notice' | 'done';
  /** `text`: the delta. `notice`: a sentence for the user. */
  text?: string;
  /** `tool_call` / `tool_result`: which tool. */
  tool?: string;
  /** `tool_call`: the arguments, as sent. */
  args?: unknown;
  /** `tool_result`: how long the call took and whether it worked. */
  durationMs?: number;
  outcome?: 'ok' | 'error';
  /** `tool_result`: a short form of what came back, for the trace line. */
  summary?: string;
}

export interface AgentOptions {
  /** `http://127.0.0.1:3000/mcp` - the gateway's own endpoint. */
  mcpUrl: string;
  /** The ephemeral key, as a Bearer token. */
  apiKey: string;
  provider: LlmProvider;
  systemPrompt: string;
  /** How many model turns may make tool calls before the loop gives up. */
  maxIterations: number;
  logger: Logger;
  signal: AbortSignal;
}

/**
 * Run one user message to completion, yielding events as they happen.
 */
export async function* runAgent(
  userMessage: string,
  history: LlmMessage[],
  options: AgentOptions,
): AsyncGenerator<AgentEvent, void, undefined> {
  const { logger } = options;

  const client = new Client({ name: 'urumi-chat-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(options.mcpUrl), {
    requestInit: {
      headers: { authorization: `Bearer ${options.apiKey}` },
    },
  });

  try {
    /**
     * Cast at the SDK boundary, the same one `mcp/pool.ts` makes: the transport declares
     * `sessionId?: string | undefined` while the Transport interface declares
     * `sessionId?: string`, so under `exactOptionalPropertyTypes` the SDK class does not
     * satisfy the SDK interface.
     */
    await client.connect(transport as unknown as Transport);
  } catch (caught) {
    /**
     * A failure here is the gateway failing to talk to itself, which is worth saying
     * plainly rather than dressing up as a model problem. The most likely causes are a
     * revoked key (so: a bug in this file's lifecycle) or `/mcp` rejecting the handshake.
     */
    logger.error({ err: caught, mcpUrl: options.mcpUrl }, 'chat agent could not connect to /mcp');
    throw new Error(
      `the chat agent could not reach the gateway's own MCP endpoint: ${
        caught instanceof Error ? caught.message : String(caught)
      }`,
      // The original is attached rather than only summarised into the message. The summary
      // is what the user reads; the cause is what a stack trace needs, and discarding it
      // turns a transport error carrying a real stack into a sentence carrying none.
      { cause: caught },
    );
  }

  try {
    /**
     * `listTools` is where an unreachable `/mcp` actually shows up, not `connect`.
     *
     * The first version of this file wrapped `connect` in a try/catch with a message about
     * not reaching the endpoint, and left `listTools` bare. That is the wrong way round.
     * `mcp/pool.ts` records what was measured in 6.4: for Streamable HTTP the SDK's
     * `connect` sets the transport up without round-tripping, so a URL with nothing behind
     * it connects happily and then fails on the first real request. (There are two
     * contradictory comments about this in `pool.ts` - the one written from observation is
     * the one that is right, and the other is noted as stale.)
     *
     * So the message for a failure here says what a failure here means. The likely causes
     * are specific and worth naming: the key we minted a moment ago being rejected would be
     * a bug in this file's own lifecycle, and a connection refused means the port is wrong,
     * which `CHAT_SELF_MCP_URL` exists to make configurable rather than a hardcoded guess.
     */
    let listed: Awaited<ReturnType<typeof client.listTools>>;
    try {
      listed = await client.listTools();
    } catch (caught) {
      logger.error(
        { err: caught, mcpUrl: options.mcpUrl },
        'the chat agent reached /mcp but could not list tools',
      );
      throw new Error(
        `the chat agent could not list tools from the gateway's own MCP endpoint (${options.mcpUrl}): ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
        { cause: caught },
      );
    }

    /**
     * The schemas are normalised and some tools may be dropped. `excluded` is reported to
     * the user as a notice rather than only logged, because a missing tool is otherwise
     * indistinguishable from the model choosing not to use it - and "why didn't it check
     * the orders?" is a question whose answer should not require reading server logs.
     */
    const schemaByName = new Map(listed.tools.map((tool) => [tool.name, tool.inputSchema]));
    const allToolNames = listed.tools.map((tool) => tool.name);
    /** Descriptions this gateway replaced because they directed the agent elsewhere. */
    const neutralised: { tool: string; referenced: string }[] = [];
    const { tools, excluded } = normaliseToolsForModel(
      listed.tools.map((tool) => ({
        name: tool.name,
        /**
         * Every description is labelled with the upstream that wrote it (8.2).
         *
         * 5.2 stores descriptions verbatim by design, and one of the three upstreams is
         * third-party software we did not write - so a description is text from outside
         * this system that the model reads as language. The label says so, and
         * `labelToolDescription` also escapes the envelope markers inside it, because a
         * description containing the closing marker could otherwise break out of a RESULT
         * envelope appearing later in the same conversation.
         */
        description: (() => {
          if (tool.description === undefined) return undefined;
          const labelled = labelToolDescription(tool.name, tool.description, allToolNames);
          if (labelled.neutralised !== undefined) {
            neutralised.push({ tool: tool.name, referenced: labelled.neutralised });
          }
          return labelled.description;
        })(),
      })),
      (name) => schemaByName.get(name),
      logger,
    );

    /**
     * A neutralised description is reported to the USER, not only logged.
     *
     * This is the one place the user can learn that one of their upstreams is behaving like
     * an attacker, and it is exactly the thing they would want to know. Logging alone would
     * put it somewhere only an operator reads, and the operator and the user are the same
     * person in a small deployment - who is looking at the chat, not at pino output.
     */
    if (neutralised.length > 0) {
      logger.warn(
        { neutralised },
        'SECURITY: an upstream tool description tried to direct the agent to call another tool; description replaced',
      );
      yield {
        type: 'notice',
        text: `Warning: ${neutralised.length} tool description${neutralised.length === 1 ? '' : 's'} from your upstream servers tried to instruct me to call other tools (${neutralised
          .map((item) => `${item.tool} -> ${item.referenced}`)
          .join('; ')}). I have ignored those descriptions. This is a prompt-injection attempt and worth investigating.`,
      };
    }

    if (excluded.length > 0) {
      yield {
        type: 'notice',
        text: `${excluded.length} tool${excluded.length === 1 ? '' : 's'} could not be offered to the model (${excluded
          .map((item) => `${item.name}: ${item.reason}`)
          .join('; ')}).`,
      };
    }

    logger.info(
      { toolCount: tools.length, excluded: excluded.length, model: options.provider.model },
      'chat agent connected and listed tools',
    );

    const messages: LlmMessage[] = [
      { role: 'system', content: options.systemPrompt },
      ...history,
      { role: 'user', content: userMessage },
    ];

    for (let iteration = 0; iteration < options.maxIterations; iteration += 1) {
      let assistantText = '';
      let toolCalls: LlmToolCall[] = [];
      let finishReason: string | undefined;

      for await (const event of options.provider.turn({
        messages,
        tools,
        signal: options.signal,
      })) {
        if (event.type === 'text') {
          assistantText += event.delta;
          yield { type: 'text', text: event.delta };
        } else if (event.type === 'toolCalls') {
          toolCalls = event.calls;
        } else {
          finishReason = event.finishReason;
        }
      }

      /**
       * No tool calls means the model has answered, and the loop is done.
       *
       * `finishReason === 'length'` is called out rather than passed over: the model ran
       * out of output budget mid-sentence, so the answer is truncated. Saying so is the
       * difference between a user thinking the agent stopped making sense and knowing it
       * was cut off.
       */
      if (toolCalls.length === 0) {
        if (finishReason === 'length') {
          yield {
            type: 'notice',
            text: 'The model reached its output limit, so this answer is cut off.',
          };
        }
        yield { type: 'done' };
        return;
      }

      messages.push({ role: 'assistant', content: assistantText, toolCalls });

      for (const call of toolCalls) {
        /**
         * Arguments are parsed here, and a parse failure is reported TO THE MODEL rather
         * than thrown.
         *
         * Models produce invalid JSON - a trailing comma, a truncated object when they hit
         * the token limit mid-call. Throwing would end the conversation over a recoverable
         * mistake. Telling the model what it sent and that it could not be read lets it
         * try again, which is the entire reason the loop runs more than once.
         */
        let args: unknown;
        try {
          args = JSON.parse(call.argumentsJson);
        } catch (caught) {
          const reason = caught instanceof Error ? caught.message : String(caught);
          logger.warn({ tool: call.name, reason }, 'the model produced unparseable tool arguments');
          yield {
            type: 'tool_result',
            tool: call.name,
            outcome: 'error',
            durationMs: 0,
            summary: 'arguments were not valid JSON',
          };
          messages.push({
            role: 'tool',
            toolCallId: call.id,
            content: `Your arguments for ${call.name} were not valid JSON (${reason}). You sent: ${call.argumentsJson.slice(0, 500)}. Send valid JSON.`,
          });
          continue;
        }

        /**
         * Null-valued top-level arguments are dropped before dispatch.
         *
         * The other half of `allowNullOnOptionalProperties`. We widened the schema so the
         * provider accepts `{"author": null}`, because models send that constantly for a
         * value they do not have - but the upstream's own zod `.optional()` rejects null,
         * so forwarding it verbatim would just move the rejection one hop later and blame
         * the upstream for it.
         *
         * Top level only, deliberately. Reaching into nested objects would mean rewriting
         * an upstream's arguments more deeply than this gateway has any business doing -
         * 5.4 settled that a proxy forwards arguments rather than reinterpreting them, and
         * this is already the narrowest exception that makes the model usable.
         */
        if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
          for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
            if (value === null) delete (args as Record<string, unknown>)[key];
          }
        }

        yield { type: 'tool_call', tool: call.name, args };

        const startedAt = Date.now();
        let resultText: string;
        let outcome: 'ok' | 'error';

        try {
          /**
           * The call goes through `/mcp` like any other, so everything the gateway does on
           * that path happens here: the key is resolved, the permission hook runs, the
           * audit row is written with `actor = 'chat'`, the per-upstream timeout and
           * circuit breaker apply, and `mcp_tool_calls_total` is incremented. None of that
           * is re-implemented for chat, which is the point.
           */
          const result = await client.callTool({
            name: call.name,
            arguments: args as Record<string, unknown>,
          });

          resultText = renderToolResult(result);
          /**
           * `isError` on the RESULT, not an exception. 5.4 established that a tool failing
           * is a result with `isError: true` rather than a protocol error, and this is the
           * consumer side of that decision: the model is told the tool failed and what it
           * said, and can choose another approach.
           */
          outcome = result.isError === true ? 'error' : 'ok';
        } catch (caught) {
          /**
           * An exception here is a transport or protocol failure - the gateway refused the
           * call, the upstream timed out and the gateway turned that into an error, the key
           * was revoked. Still fed back to the model rather than ending the chat: "that
           * upstream is unavailable" is something it can report to the user, and a user
           * being told which tool is down is better served than one told the chat broke.
           */
          resultText = caught instanceof Error ? caught.message : String(caught);
          outcome = 'error';
          logger.warn({ err: caught, tool: call.name }, 'a chat tool call failed');
        }

        const durationMs = Date.now() - startedAt;

        yield {
          type: 'tool_result',
          tool: call.name,
          outcome,
          durationMs,
          summary: summarise(resultText),
        };

        messages.push({
          role: 'tool',
          toolCallId: call.id,
          /**
           * Capped. A tool can return a great deal - `woo__list_products` with a high
           * `per_page`, or everything-mcp's image tool - and an uncapped result both blows
           * the context window and costs tokens for data the model will not use. Truncated
           * with a marker so the model knows it is seeing part of something rather than all
           * of a small thing, which changes how it should answer.
           */
          /**
           * Wrapped in the untrusted envelope (8.2), and truncated BEFORE wrapping.
           *
           * Order matters: truncating afterwards could cut the closing marker off the end,
           * leaving the model an envelope that never closes - and everything after it in
           * the conversation would then read as though it were inside the untrusted region.
           * The content is capped first so the envelope is always intact.
           */
          content: wrapToolOutput({
            tool: call.name,
            content: truncateForModel(resultText),
            isError: outcome === 'error',
          }),
        });
      }
    }

    /**
     * The iteration cap was reached.
     *
     * Said out loud to the user, not silently stopped. A loop that gives up without saying
     * so is indistinguishable from a model that lost interest, and the cap exists for a
     * real reason - a model can get stuck calling the same failing tool - so the user
     * deserves to know that is what happened rather than wondering why the answer stopped.
     */
    logger.warn(
      { maxIterations: options.maxIterations },
      'chat agent hit its iteration cap with tool calls still pending',
    );
    yield {
      type: 'notice',
      text: `Stopped after ${options.maxIterations} rounds of tool calls without reaching an answer. This usually means a tool kept failing — the Audit page shows what was tried.`,
    };
    yield { type: 'done' };
  } finally {
    /**
     * The MCP client is closed whatever happened, including on an abort. Leaving it open
     * holds the transport's connection, and the ephemeral key is about to be revoked - a
     * client still holding it would start failing in a way that looks like an auth bug.
     */
    await client.close().catch((caught: unknown) => {
      logger.debug({ err: caught }, 'closing the chat agent MCP client failed');
    });
  }
}

/**
 * Flattens an MCP tool result into text for the model.
 *
 * The result's `content` is an array of blocks which may be text, an image, or a resource.
 * Only text is passed on: this model is not multimodal in this deployment, and handing it
 * base64 image data would spend a large number of tokens to tell it nothing. The block is
 * acknowledged rather than dropped silently, so the model can say "the tool returned an
 * image" instead of appearing to ignore the result.
 */
function renderToolResult(result: unknown): string {
  if (result === null || typeof result !== 'object') return String(result);

  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    // The SDK types a result as a union - `{ content }` or the legacy `{ toolResult }` -
    // which 6.1 ran into when reading error text out of one. Handled rather than assumed.
    const legacy = (result as { toolResult?: unknown }).toolResult;
    return legacy === undefined ? JSON.stringify(result) : JSON.stringify(legacy);
  }

  const parts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const type = (block as { type?: unknown }).type;
    if (type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string') parts.push(text);
    } else if (typeof type === 'string') {
      parts.push(`[the tool returned a ${type} block, which this agent does not forward]`);
    }
  }

  return parts.length > 0 ? parts.join('\n') : '[the tool returned no content]';
}

const MODEL_RESULT_CAP = 8000;

function truncateForModel(text: string): string {
  if (text.length <= MODEL_RESULT_CAP) return text;
  return `${text.slice(0, MODEL_RESULT_CAP)}\n\n[truncated: the tool returned ${text.length} characters, of which the first ${MODEL_RESULT_CAP} are shown]`;
}

/** A one-line form of a result, for the trace the UI shows. */
function summarise(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 120 ? collapsed : `${collapsed.slice(0, 117)}...`;
}

export { LlmError };
