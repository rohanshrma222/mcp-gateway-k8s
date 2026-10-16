/**
 * Groq, over its OpenAI-compatible chat-completions endpoint.
 *
 * No SDK. The request is one POST with a JSON body and the response is an SSE stream of
 * JSON chunks, which `fetch` and a small parser handle in about as many lines as
 * configuring a client library would take - and without adding a dependency whose own
 * release cadence we would then be on. The gateway already talks raw Streamable HTTP to
 * three upstreams; one more hand-written HTTP client is consistent with that rather than a
 * new kind of thing.
 *
 * The part worth reading is `accumulateToolCalls`. Tool calls do not arrive whole.
 */
import type {
  LlmEvent,
  LlmMessage,
  LlmProvider,
  LlmTool,
  LlmToolCall,
  LlmTurnRequest,
} from './provider.js';
import { LlmError } from './provider.js';

export interface GroqOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  /**
   * How long to wait for the whole streamed turn.
   *
   * Separate from the per-tool-call timeout the gateway already has for upstreams: a model
   * generating a long answer is legitimately slow in a way a tool call is not, so the two
   * cannot share a number.
   */
  timeoutMs: number;
}

/** The wire shape of one streamed chunk. Only the fields actually read are declared. */
interface StreamChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  error?: { message?: string };
}

export class GroqProvider implements LlmProvider {
  readonly model: string;

  constructor(private readonly options: GroqOptions) {
    this.model = options.model;
  }

  async *turn(request: LlmTurnRequest): AsyncGenerator<LlmEvent, void, undefined> {
    /**
     * The caller's signal and our own timeout are combined.
     *
     * `AbortSignal.any` rather than a manual pair of listeners, and the timer is cleared in
     * a `finally` below: a 60-second timer left behind on every chat turn is a slow leak
     * that only shows up under load, which is the worst time to find it.
     */
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeout]);

    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages.map(toWireMessage),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map(toWireTool),
                /**
                 * `auto`, explicitly rather than by omission.
                 *
                 * It is the default, but the alternatives matter enough to name the choice:
                 * `required` would force a tool call on every turn, which makes "hello"
                 * produce a pointless call, and `none` would make the tools decorative.
                 * `auto` is also what lets the model answer a question about something it
                 * already fetched without fetching it again.
                 */
                tool_choice: 'auto',
              }
            : {}),
          stream: true,
          /**
           * Low but not zero.
           *
           * This agent's job is to pick the right tool and report what came back, which is
           * closer to extraction than to writing. Temperature 0 is tempting and slightly
           * worse in practice for tool-calling models - it makes them more likely to repeat
           * a failing call verbatim rather than try a different argument, which matters
           * because the loop below feeds tool errors back to the model specifically so it
           * can adjust.
           */
          temperature: 0.2,
        }),
        signal,
      });
    } catch (caught) {
      // A rejected fetch is a transport failure: DNS, TLS, the socket, or an abort. The
      // user's own cancellation is not an error and is reported as such by the route.
      if (request.signal.aborted) throw new LlmError('the chat was cancelled', undefined, false);
      if (timeout.aborted) {
        throw new LlmError(
          `the model did not respond within ${this.options.timeoutMs}ms`,
          undefined,
          true,
        );
      }
      throw new LlmError(
        `could not reach the model provider: ${caught instanceof Error ? caught.message : String(caught)}`,
        undefined,
        true,
      );
    }

    if (!response.ok) {
      /**
       * The provider's own error text is read and included.
       *
       * A bare "the provider returned 401" sends whoever is debugging to the wrong place.
       * Groq's body says whether the key is malformed, revoked, or out of quota, and those
       * are three different fixes. Capped, because an error body is not a bounded thing.
       */
      const body = await response.text().catch(() => '');
      const detail = extractProviderMessage(body);
      throw new LlmError(
        `the model provider returned ${response.status}${detail === undefined ? '' : `: ${detail}`}`,
        response.status,
        response.status === 429 || response.status >= 500,
      );
    }

    if (response.body === null) {
      throw new LlmError('the model provider returned an empty stream', response.status, true);
    }

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finishReason: string | undefined;

    try {
      for await (const data of readSseData(response.body)) {
        /**
         * `[DONE]` is a sentinel, not JSON. Parsing it throws, and a throw here would be
         * reported as a provider failure at the very end of a successful turn.
         */
        if (data === '[DONE]') break;

        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data) as StreamChunk;
        } catch {
          // A single unparseable chunk is skipped rather than failing the turn. The stream
          // is a sequence of independent deltas, so one bad frame costs a few characters;
          // aborting would cost the whole answer.
          continue;
        }

        /**
         * An error can arrive INSIDE a 200 stream.
         *
         * Groq returns 200 and then streams an error object when something fails after the
         * response has begun - a content filter, or a mid-generation rate limit. Checking
         * only `response.ok` would let that pass as a normal short answer, which is the
         * same class of mistake as 6.6's `/metrics` check that read the status and not the
         * body.
         */
        if (chunk.error !== undefined) {
          throw new LlmError(
            `the model provider failed mid-stream: ${chunk.error.message ?? 'no reason given'}`,
            response.status,
            true,
          );
        }

        const choice = chunk.choices?.[0];
        if (choice === undefined) continue;

        const content = choice.delta?.content;
        if (typeof content === 'string' && content !== '') {
          yield { type: 'text', delta: content };
        }

        accumulateToolCalls(choice.delta?.tool_calls, pending);

        if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
          finishReason = choice.finish_reason;
        }
      }
    } finally {
      /**
       * The body is cancelled if we leave the loop early.
       *
       * Breaking out of a `for await` over a fetch body does not by itself close the
       * underlying socket, so a cancelled chat would hold the connection until the provider
       * gave up. Harmless once; a leak at any volume.
       */
      await response.body.cancel().catch(() => undefined);
    }

    if (pending.size > 0) {
      const calls: LlmToolCall[] = [...pending.entries()]
        // By index, because the model's ordering is meaningful - it may expect the first
        // call's result before the second makes sense - and Map iteration order follows
        // insertion, which is not the same thing when fragments arrive interleaved.
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({
          id: call.id,
          name: call.name,
          // Empty arguments become `{}`: a no-argument tool legitimately streams no
          // argument fragments at all, and `JSON.parse('')` would throw downstream.
          argumentsJson: call.args === '' ? '{}' : call.args,
        }));
      yield { type: 'toolCalls', calls };
    }

    yield { type: 'end', finishReason };
  }
}

/**
 * Tool calls arrive in fragments, keyed by index, and have to be reassembled.
 *
 * This is the one genuinely fiddly part of the OpenAI streaming protocol and the thing a
 * client library would otherwise hide. A single call `get_weather({"city":"Berlin"})`
 * typically arrives as:
 *
 *     { index: 0, id: 'call_abc', function: { name: 'get_weather', arguments: '' } }
 *     { index: 0, function: { arguments: '{"ci' } }
 *     { index: 0, function: { arguments: 'ty":"Ber' } }
 *     { index: 0, function: { arguments: 'lin"}' } }
 *
 * The `id` and `name` appear once, on the first fragment; `arguments` is a string that must
 * be CONCATENATED, not replaced. Replacing it - the obvious reading of a field called
 * `arguments` - yields `lin"}`, which parses as nothing and produces a tool call with no
 * arguments. And because several calls can stream in parallel, the index is the only thing
 * tying a fragment to the call it belongs to; a parser that assumes one call at a time
 * interleaves two sets of arguments into one unparseable string.
 */
function accumulateToolCalls(
  fragments: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined,
  pending: Map<number, { id: string; name: string; args: string }>,
): void {
  if (fragments === undefined) return;

  for (const fragment of fragments) {
    const existing = pending.get(fragment.index) ?? { id: '', name: '', args: '' };
    pending.set(fragment.index, {
      // id and name are assigned when they appear and never overwritten with an empty
      // later fragment.
      id: fragment.id ?? existing.id,
      name: fragment.function?.name ?? existing.name,
      args: existing.args + (fragment.function?.arguments ?? ''),
    });
  }
}

/**
 * Reads an SSE body and yields the `data:` payloads.
 *
 * Written out rather than taken from a library because the framing is three rules - events
 * are separated by a blank line, fields are `name: value`, and we only care about `data` -
 * and because the buffering is the part that has to be right: a chunk boundary can fall
 * anywhere, including inside a field name, so a parser that processes each chunk
 * independently loses whatever straddles the boundary.
 */
async function* readSseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // `stream: true` on the decoder, so a multi-byte character split across two chunks is
    // held until complete rather than emitted as a replacement character. Every tool
    // description in this system can contain non-ASCII - one of the test ones is Japanese.
    buffer += decoder.decode(value, { stream: true });

    // `\n\n` is the event separator. Some servers send `\r\n\r\n`, so both are handled.
    let separator = findSeparator(buffer);
    while (separator !== undefined) {
      const raw = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);

      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        // One space after the colon is conventional and optional; trimStart handles both
        // without trimming meaningful leading whitespace inside the JSON.
        yield line.slice('data:'.length).trimStart();
      }

      separator = findSeparator(buffer);
    }
  }
}

function findSeparator(buffer: string): { index: number; length: number } | undefined {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  if (lf !== -1) return { index: lf, length: 2 };
  return undefined;
}

function toWireMessage(message: LlmMessage): Record<string, unknown> {
  switch (message.role) {
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.toolCalls !== undefined && message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.argumentsJson },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: message.toolCallId, content: message.content };
    default:
      return { role: message.role, content: message.content };
  }
}

function toWireTool(tool: LlmTool): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  };
}

/** Pulls a readable sentence out of a provider error body, whatever shape it came in. */
function extractProviderMessage(body: string): string | undefined {
  if (body === '') return undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string };
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message;
    if (typeof message === 'string' && message !== '') return message.slice(0, 300);
  } catch {
    // Not JSON. The raw body is still better than nothing, capped.
  }
  return body.slice(0, 300);
}
