/**
 * The status chip, and the reason beside it.
 *
 * The brief asks for status "with a reason" rather than just a colour, and that phrasing is
 * doing a lot of work. A red dot says something is wrong; it does not say the connection
 * was refused, or that the credential will not decrypt, or that a URL stopped resolving.
 * The gateway spent stage 5 and 6 making those reasons readable sentences - three separate
 * bugs were fixed to stop raw wire text like `MCP error -32001` reaching a user - and this
 * component is the only place that work becomes visible.
 *
 * So the reason is NOT hidden behind a tooltip or an expander. It sits in the row, where
 * someone scanning the page reads it without asking for it.
 *
 * No animation here at all. The chip is the thing the page exists to show, it is on screen
 * constantly, and it changes on a 10-second poll without the user doing anything - a
 * transition on a value that updates by itself is motion the user did not cause and cannot
 * predict. A colour fade would also make two consecutive polls visually ambiguous, which
 * on a status display is the one thing to avoid.
 */
import clsx from 'clsx';
import type { UpstreamServer } from '../api/types.js';

type Status = UpstreamServer['status'];

/**
 * The four states the gateway actually reports, mapped to words a person uses.
 *
 * `unknown` is its own state rather than being folded into `unreachable`, and the
 * distinction matters: it means nothing has probed this server yet - a freshly registered
 * upstream, or a gateway replica that just started. Showing that as "unreachable" would be
 * a red light for a server that is very likely fine.
 */
const PRESENTATION: Record<Status, { label: string; dot: string; text: string; ring: string }> = {
  connected: {
    label: 'Connected',
    dot: 'bg-ok-500',
    text: 'text-ok-500',
    ring: 'border-ok-600/40 bg-ok-600/10',
  },
  unreachable: {
    label: 'Unreachable',
    dot: 'bg-bad-500',
    text: 'text-bad-500',
    ring: 'border-bad-600/40 bg-bad-600/10',
  },
  disabled: {
    label: 'Disabled',
    dot: 'bg-ink-500',
    text: 'text-ink-400',
    ring: 'border-ink-700 bg-ink-800/60',
  },
  unknown: {
    label: 'Not yet probed',
    dot: 'bg-warn-500',
    text: 'text-warn-500',
    ring: 'border-warn-600/40 bg-warn-600/10',
  },
};

export function StatusChip({ status }: { status: Status }) {
  const style = PRESENTATION[status];
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        style.ring,
        style.text,
      )}
    >
      {/* A dot as well as a colour, and a word as well as a dot. Colour alone fails for
          anyone who cannot distinguish red from green - and a status display is exactly
          where that matters, because the whole message is in the colour. */}
      <span className={clsx('size-1.5 rounded-full', style.dot)} aria-hidden="true" />
      {style.label}
    </span>
  );
}

/**
 * The failure reason.
 *
 * Rendered only when there is one AND the server is not merely disabled - a disabled
 * server's last error is stale history, and showing it beside a grey "Disabled" chip reads
 * as a current problem. The gateway keeps the column populated deliberately, so this is a
 * presentation decision rather than missing data.
 */
export function StatusReason({ server }: { server: UpstreamServer }) {
  if (server.lastError === null || server.lastError === '') return undefined;
  if (server.status === 'disabled') return undefined;

  return (
    <p className="mt-1 text-xs leading-relaxed text-ink-400">
      {/* `break-words` because these are generated sentences that can contain a URL with no
          spaces in it, and an unbreakable string would push the card wider than the page.
          See the worst-case pass in the step notes. */}
      <span className="break-words">{server.lastError}</span>
      {server.lastProbedAt === null ? undefined : (
        <span className="ml-1 whitespace-nowrap text-ink-600">· {relativeTime(server.lastProbedAt)}</span>
      )}
    </p>
  );
}

/**
 * "12s ago", not a timestamp.
 *
 * On a page that refreshes every ten seconds, the useful question is "how stale is this",
 * and an ISO timestamp makes the reader do the subtraction. Hand-written rather than
 * pulling in a date library for one function: `Intl.RelativeTimeFormat` is built in, and
 * this is the only place the app formats a relative time.
 */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'at an unknown time';

  const seconds = Math.round((Date.now() - then) / 1000);
  // Clock skew between the browser and the cluster can make a fresh probe look like it
  // happened in the future. Reported as "just now" rather than "in 3 seconds", which is
  // technically what the numbers say and is never what the user wants to read.
  if (seconds < 5) return 'just now';

  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
  ];

  let value = seconds;
  for (const [unit, limit] of steps) {
    if (value < limit) return format.format(-value, unit);
    value = Math.round(value / limit);
  }
  return format.format(-value, 'week');
}
