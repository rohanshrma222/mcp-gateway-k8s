/**
 * The seam between the chat agent and whichever model serves it.
 *
 * Groq is the only implementation today, and the interface exists anyway for one reason
 * that is not "we might swap providers later": it keeps the tool-calling loop testable and
 * readable without a network. The loop in `chat/agent.ts` is the part with the interesting
 * logic - iteration caps, tool dispatch, error surfacing - and the part most likely to be
 * wrong. Behind an interface it can be driven by a scripted provider that returns a fixed
 * sequence of tool calls, which is the only way to test "what happens on the eighth
 * consecutive tool call" without paying for eight model round trips and hoping the model
 * cooperates.
 *
 * The shape is deliberately the OpenAI chat-completions shape rather than something
 * neutral. Groq, OpenAI, Together, Fireworks and vLLM all speak it, so a neutral
 * abstraction would be a translation layer with exactly one dialect on each side - work
 * that buys nothing. The honest description is that this is the OpenAI tool-calling
 * protocol with a narrower surface, not a provider-agnostic abstraction, and pretending
 * otherwise would be the kind of claim Round 2 should catch.
 */

/** A tool as the model sees it: a name, a sentence, and a JSON Schema for the arguments. */
export interface LlmTool {
  name: string;
  description: string;
  /**
   * The normalised JSON Schema. `llm/schema.ts` produces this from an upstream's own
   * schema; it is `unknown` here because this layer does not inspect it, it forwards it.
   */
  parameters: unknown;
}

/** One tool call the model asked for. */
export interface LlmToolCall {
  /**
   * The provider's id for this call. It has to be echoed back on the result message, and
   * the model will not accept a result it cannot match to its request.
   */
  id: string;
  name: string;
  /**
   * The raw JSON text the model produced, NOT a parsed object.
   *
   * Kept as text on purpose: models emit invalid JSON often enough that parsing has to be
   * a handled failure rather than an exception in the transport layer, and the agent needs
   * the original text to tell the model what it sent that could not be read.
   */
  argumentsJson: string;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      /** Empty when the model only called tools and said nothing. */
      content: string;
      toolCalls?: LlmToolCall[];
    }
  | {
      role: 'tool';
      /** Must match the `id` of the call being answered. */
      toolCallId: string;
      content: string;
    };

/**
 * What the provider streams back.
 *
 * `text` arrives incrementally and is shown as it lands. `toolCalls` arrives once, at the
 * end of a turn, because a partially-streamed tool call is not actionable - you cannot
 * dispatch a call whose arguments are still arriving, and showing the user half-formed JSON
 * is noise. So the provider accumulates tool-call fragments internally and emits them
 * whole.
 */
export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'toolCalls'; calls: LlmToolCall[] }
  | {
      type: 'end';
      /**
       * Why the turn stopped, as the provider reported it. Carried through rather than
       * interpreted here, because `length` (the model hit its output cap mid-sentence) and
       * `stop` (it finished) need different handling and only the agent knows which it can
       * recover from.
       */
      finishReason: string | undefined;
    };

export interface LlmTurnRequest {
  messages: LlmMessage[];
  tools: LlmTool[];
  /**
   * Aborts the HTTP request to the provider.
   *
   * Threaded through rather than left to a timeout, because the user closing the chat tab
   * should stop the model mid-sentence and stop paying for it. Without this, a cancelled
   * chat keeps generating into a response nobody will read.
   */
  signal: AbortSignal;
}

export interface LlmProvider {
  /** For logs and for the UI, so a reviewer can see which model answered. */
  readonly model: string;

  /**
   * One model turn, streamed.
   *
   * An async generator rather than a callback: the agent loop needs to consume events,
   * decide whether to run tools, and then start another turn, which reads as a `for await`
   * inside a `while` and would otherwise be a callback threaded through a state machine.
   */
  turn(request: LlmTurnRequest): AsyncGenerator<LlmEvent, void, undefined>;
}

/**
 * Raised when the provider itself fails - a bad key, a rate limit, a 500.
 *
 * Distinct from a tool failing, which is a normal event the model is told about and can
 * work around. A provider failure ends the conversation, so it carries its status to let
 * the route choose a sensible HTTP code and the UI say something true about whose fault it
 * is.
 */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    /** True for 429 and 5xx: the same request might succeed shortly. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
