/**
 * The Chat page: the agent's reply as it arrives, and a trace line for every tool call.
 *
 * **The trace is the point of this screen, not the chat.** A chat box with a language model
 * behind it is unremarkable; what the brief asks to see - and what a reviewer needs in order
 * to believe any of the claims made in stage 8 - is *which tool was called, how long it
 * took, and whether it worked*, visible as it happens. The trace is what turns "the agent
 * said there are five products" into "the agent called `woo__list_products`, it answered in
 * 679ms, and here is what it said". One of those is checkable.
 *
 * So the trace lines are not a debug affordance tucked behind a toggle. They sit inline, in
 * the conversation, in the order things happened, and they stay there afterwards.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import type { ChatEvent } from '../api/types.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/states.js';
import { useSession } from '../auth/session.js';

/**
 * One entry in the visible transcript.
 *
 * Tool calls and notices are entries in the same ordered list as messages rather than being
 * attached to the assistant turn that produced them. That is deliberate: the order a user
 * needs to see is the order things happened - ask, call, result, call, result, answer - and
 * nesting them under the final answer would put the explanation after the conclusion it
 * explains.
 */
type Entry =
  | { kind: 'user'; id: number; text: string }
  | { kind: 'assistant'; id: number; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: number;
      tool: string;
      args: unknown;
      /** Undefined until the result arrives, which is what shows the call as in flight. */
      durationMs?: number;
      outcome?: 'ok' | 'error';
      summary?: string;
    }
  | { kind: 'notice'; id: number; text: string }
  | { kind: 'error'; id: number; text: string };

export function Chat() {
  const { session } = useSession();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<(() => void) | undefined>(undefined);
  const nextId = useRef(0);
  const endRef = useRef<HTMLDivElement | null>(null);

  const id = () => {
    nextId.current += 1;
    return nextId.current;
  };

  /**
   * The history sent to the server is derived from the transcript, and deliberately
   * contains ONLY user and assistant text.
   *
   * Tool calls and results are left out. They are already in the model's own context during
   * a turn - the agent builds that itself - and replaying them on the next turn would
   * duplicate them, grow every request, and make the token cost climb with the length of
   * the conversation. 8.1 measured a turn at ~3,100 tokens against an 8,000/minute budget,
   * so this is a real constraint rather than tidiness.
   *
   * It does mean the model cannot see the exact JSON a tool returned three turns ago, only
   * what it said about it. That is the right trade: the summary is what mattered, and if
   * the user asks again the agent can simply call the tool again.
   */
  const history = useMemo(
    () =>
      entries
        .filter(
          (entry): entry is Extract<Entry, { kind: 'user' | 'assistant' }> =>
            (entry.kind === 'user' || entry.kind === 'assistant') && entry.text.trim() !== '',
        )
        .map((entry) => ({
          role: entry.kind === 'user' ? ('user' as const) : ('assistant' as const),
          content: entry.text,
        })),
    [entries],
  );

  /**
   * Scrolls to the bottom as content arrives, and only while a turn is running.
   *
   * Unconditional auto-scroll is one of the most irritating things a chat interface does: it
   * yanks the view away the moment you scroll up to re-read something. Tying it to `busy`
   * means it follows a reply that is still being written and leaves a finished conversation
   * alone, which is when a user actually reads back.
   *
   * `behavior: 'auto'` rather than `'smooth'`: tokens arrive every few tens of
   * milliseconds, and a smooth scroll that is re-triggered before it finishes animates
   * against itself and visibly lags the text.
   */
  useEffect(() => {
    if (!busy) return;
    endRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [entries, busy]);

  /** Aborts an in-flight turn if the page is left, so the model request stops server-side. */
  useEffect(() => () => abortRef.current?.(), []);

  const send = useCallback(
    async (message: string) => {
      const trimmed = message.trim();
      if (trimmed === '' || busy) return;

      const snapshot = history;
      setDraft('');
      setBusy(true);

      const assistantId = id();
      setEntries((previous) => [
        ...previous,
        { kind: 'user', id: id(), text: trimmed },
        { kind: 'assistant', id: assistantId, text: '', streaming: true },
      ]);

      const onEvent = (event: ChatEvent): void => {
        setEntries((previous) => {
          switch (event.type) {
            case 'text':
              return previous.map((entry) =>
                entry.id === assistantId && entry.kind === 'assistant'
                  ? { ...entry, text: entry.text + event.text }
                  : entry,
              );

            case 'tool_call':
              /**
               * The tool entry is inserted BEFORE the assistant entry it belongs to, so the
               * trace reads in the order it happened: the call appears while it is running,
               * and the answer lands underneath it afterwards.
               */
              return insertBefore(previous, assistantId, {
                kind: 'tool',
                id: id(),
                tool: event.tool,
                args: event.args,
              });

            case 'tool_result':
              return completeLastCall(previous, event);

            case 'notice':
              return insertBefore(previous, assistantId, { kind: 'notice', id: id(), text: event.text });

            case 'error':
              return insertBefore(previous, assistantId, { kind: 'error', id: id(), text: event.text });

            case 'done':
              return previous.map((entry) =>
                entry.id === assistantId && entry.kind === 'assistant'
                  ? { ...entry, streaming: false }
                  : entry,
              );
          }
        });
      };

      const { done, abort } = api.chat.send(trimmed, snapshot, onEvent);
      abortRef.current = abort;

      try {
        await done;
      } catch (caught) {
        /**
         * An abort is the user's own doing and is not reported as a failure. Everything
         * else becomes an entry in the transcript rather than a toast, because it belongs
         * to a particular message - a toast would vanish and leave a conversation that
         * silently stops.
         */
        if (!(caught instanceof DOMException && caught.name === 'AbortError')) {
          const text =
            caught instanceof ApiError
              ? caught.message
              : caught instanceof Error
                ? caught.message
                : 'the chat request failed';
          setEntries((previous) => insertBefore(previous, assistantId, { kind: 'error', id: id(), text }));
        }
      } finally {
        abortRef.current = undefined;
        setBusy(false);
        setEntries((previous) =>
          previous
            .map((entry) =>
              entry.id === assistantId && entry.kind === 'assistant'
                ? { ...entry, streaming: false }
                : entry,
            )
            /**
             * An assistant entry that never received any text is removed.
             *
             * It happens whenever a turn dies before the model said anything - a provider
             * 429 on the first turn, most often, which on the free tier is common. Leaving
             * it would show an empty reply bubble under the error, which reads as the agent
             * having answered with silence.
             */
            .filter((entry) => !(entry.kind === 'assistant' && entry.text.trim() === '')),
        );
      }
    },
    [busy, history],
  );

  return (
    <section className="flex min-h-[calc(100dvh-10rem)] flex-col">
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink-50">Chat</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-400">
          The agent calls tools as you, using a short-lived key issued for each message. Every
          call is traced below and recorded on the{' '}
          {/* Link, not an anchor. A plain href would reload the whole SPA - re-running the
              session check, re-fetching everything and discarding the conversation in this
              component, which is state the user cannot get back. */}
          <Link className="text-brand-400 underline-offset-2 hover:underline" to="/audit">
            Audit page
          </Link>{' '}
          under {session?.email ?? 'your account'}.
        </p>
      </header>

      <div className="flex-1">
        {entries.length === 0 ? (
          <EmptyState title="Ask the agent something about your store.">
            It can read products and orders, create products, change an order&rsquo;s status and
            keep notes — whatever the connected servers expose. Try{' '}
            <em>&ldquo;how many orders came in?&rdquo;</em> or{' '}
            <em>&ldquo;check the orders and save a note about them&rdquo;</em>, which needs two
            different servers in one answer.
          </EmptyState>
        ) : (
          <ol className="space-y-3">
            {entries.map((entry) => (
              <li key={entry.id}>
                <EntryView entry={entry} />
              </li>
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>

      <form
        className="sticky bottom-0 mt-6 bg-ink-950/90 pb-2 pt-3 backdrop-blur"
        onSubmit={(formEvent) => {
          formEvent.preventDefault();
          void send(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(changeEvent) => setDraft(changeEvent.target.value)}
            onKeyDown={(keyEvent) => {
              /**
               * Enter sends; Shift+Enter makes a newline.
               *
               * The convention every chat interface uses, and worth matching rather than
               * inventing: a user who has typed into one chat box has learned this one.
               * `isComposing` is checked because an IME uses Enter to accept a candidate,
               * and sending on that would make the field unusable for Japanese or Chinese
               * input - the kind of thing that works perfectly until somebody who needs it
               * tries.
               */
              if (keyEvent.key === 'Enter' && !keyEvent.shiftKey && !keyEvent.nativeEvent.isComposing) {
                keyEvent.preventDefault();
                void send(draft);
              }
            }}
            rows={2}
            maxLength={8000}
            disabled={busy}
            placeholder={busy ? 'Waiting for the agent…' : 'Ask about your store…'}
            className="min-h-0 flex-1 resize-y rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-brand-600 focus:outline-none disabled:opacity-60"
            aria-label="Message"
          />
          {busy ? (
            /**
             * Stop, not a disabled Send.
             *
             * A turn can take tens of seconds and involve several tool calls, and the server
             * aborts the model request when the client disconnects - so this button does
             * real work rather than only tidying the screen. A greyed-out Send would leave
             * the user with nothing to do but wait or close the tab.
             */
            <Button intent="ghost" onClick={() => abortRef.current?.()}>
              Stop
            </Button>
          ) : (
            <Button intent="primary" type="submit" disabled={draft.trim() === ''}>
              Send
            </Button>
          )}
        </div>
        <p className="mt-1.5 text-xs text-ink-600">
          Enter sends, Shift+Enter for a new line. Tool calls are listed as they happen.
        </p>
      </form>
    </section>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          {/* max-w so a long message does not run the full width and become hard to read;
              whitespace-pre-wrap so the newlines the user typed survive. */}
          <p className="max-w-[46rem] whitespace-pre-wrap break-words rounded-lg bg-brand-600/20 px-3 py-2 text-sm text-ink-100">
            {entry.text}
          </p>
        </div>
      );

    case 'assistant':
      return (
        <div className="max-w-[52rem]">
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-200">
            {entry.text}
            {entry.streaming ? <Caret /> : undefined}
          </p>
        </div>
      );

    case 'tool':
      return <ToolTrace entry={entry} />;

    case 'notice':
      /**
       * Notices are warning-toned and prominent, because this is where 8.2's defences
       * surface: a neutralised tool description, or a tool withheld because its schema
       * could not be shown faithfully. A user whose upstream is behaving like an attacker
       * should not have to read server logs to find out.
       */
      return (
        <p className="max-w-[52rem] rounded-lg border border-warn-600/40 bg-warn-600/10 px-3 py-2 text-xs leading-relaxed text-warn-500">
          {entry.text}
        </p>
      );

    case 'error':
      return (
        <p className="max-w-[52rem] break-words rounded-lg border border-bad-600/40 bg-bad-600/10 px-3 py-2 text-xs leading-relaxed text-bad-500">
          {entry.text}
        </p>
      );
  }
}

/**
 * The trace line the step asks for: `called woo__list_orders (320ms, ok)`.
 *
 * Monospace for the tool name, because it is an identifier the user may want to paste into
 * the Audit page's filter - and because `server__tool` is read structurally rather than as
 * a word. The arguments are shown too: knowing that `woo__list_orders` was called matters
 * much less than knowing it was called with `per_page: 20`, and this is the only place a
 * user can see what the model actually decided to ask for.
 */
function ToolTrace({ entry }: { entry: Extract<Entry, { kind: 'tool' }> }) {
  const pending = entry.durationMs === undefined;

  return (
    <div className="max-w-[52rem] rounded-lg border border-ink-800 bg-ink-900/40 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-xs text-ink-500">called</span>
        <code className="min-w-0 break-all text-xs text-brand-400">{entry.tool}</code>
        {pending ? (
          <span className="text-xs text-ink-600">…</span>
        ) : (
          <span
            className={
              entry.outcome === 'error'
                ? 'text-xs font-medium text-bad-500'
                : 'text-xs font-medium text-ok-500'
            }
          >
            {/* tabular-nums so consecutive durations line up and can be compared at a
                glance, which is the whole reason the number is here. */}
            ({<span className="tabular-nums">{formatDuration(entry.durationMs ?? 0)}</span>},{' '}
            {entry.outcome})
          </span>
        )}
      </div>

      {entry.args !== undefined && !isEmptyArgs(entry.args) ? (
        <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap break-all text-[11px] leading-relaxed text-ink-500">
          {formatArgs(entry.args)}
        </pre>
      ) : undefined}

      {entry.summary !== undefined && entry.summary !== '' ? (
        // Clamped: a result can be thousands of characters, and the trace is a receipt
        // rather than the data. The full result shaped the answer above it.
        <p className="mt-1.5 line-clamp-2 break-words text-[11px] leading-relaxed text-ink-600">
          → {entry.summary}
        </p>
      ) : undefined}
    </div>
  );
}

/**
 * A blinking caret while text streams.
 *
 * **This is the only animation on the page, and it is here because it is the one piece of
 * state the text itself cannot express.** A reply that has stopped arriving and a reply that
 * is still coming look identical when both are just text; the caret distinguishes them, and
 * a user watching a long answer needs to know which one they are looking at.
 *
 * Everything else deliberately does not animate. Tokens appearing is already motion - the
 * fastest-updating thing on any screen in this app - and fading each one in would blur text
 * that the user is actively reading. Tool traces do not slide in, because they appear during
 * the busiest moment on the screen and a transform would compete with the text for
 * attention. 1s step animation rather than a smooth fade, because a cursor blinks; it does
 * not pulse.
 */
function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.1em] animate-[caret_1s_steps(2,start)_infinite] bg-brand-400"
    />
  );
}

function insertBefore(entries: Entry[], beforeId: number, entry: Entry): Entry[] {
  const index = entries.findIndex((candidate) => candidate.id === beforeId);
  if (index === -1) return [...entries, entry];
  return [...entries.slice(0, index), entry, ...entries.slice(index)];
}

/**
 * Attaches a result to the most recent tool entry still waiting for one.
 *
 * Searched from the end and matched on the tool name, because the same tool can legitimately
 * be called twice in one turn - the agent is explicitly allowed to retry with different
 * arguments after a failure - and matching the first pending entry would attach the second
 * result to the first call, mislabelling both durations.
 */
function completeLastCall(
  entries: Entry[],
  event: Extract<ChatEvent, { type: 'tool_result' }>,
): Entry[] {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === 'tool' && entry.durationMs === undefined && entry.tool === event.tool) {
      const updated: Entry = {
        ...entry,
        durationMs: event.durationMs,
        outcome: event.outcome,
        ...(event.summary === undefined ? {} : { summary: event.summary }),
      };
      return [...entries.slice(0, index), updated, ...entries.slice(index + 1)];
    }
  }

  /**
   * A result with no matching call still gets shown, as a trace entry of its own.
   *
   * It should not happen - the agent always emits the call first - but silently dropping a
   * result would hide a real tool invocation from the one screen that exists to show them,
   * which is worse than an oddly-placed line.
   */
  return [
    ...entries,
    {
      kind: 'tool',
      id: Math.random(),
      tool: event.tool,
      args: undefined,
      durationMs: event.durationMs,
      outcome: event.outcome,
      ...(event.summary === undefined ? {} : { summary: event.summary }),
    },
  ];
}

/** Shares 7.5's rule: pick the precision from the rounded value, so 9,999ms is not "10.00s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  return Number(seconds.toFixed(2)) < 10 ? `${seconds.toFixed(2)}s` : `${seconds.toFixed(1)}s`;
}

function isEmptyArgs(args: unknown): boolean {
  return args !== null && typeof args === 'object' && Object.keys(args).length === 0;
}

function formatArgs(args: unknown): string {
  try {
    const text = JSON.stringify(args);
    // Short arguments on one line, which is most of them; only wrap when it earns it.
    return text.length <= 120 ? text : JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}
