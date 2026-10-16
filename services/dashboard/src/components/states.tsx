/**
 * The empty, error and loading states, in one place.
 *
 * Step 7.5 asks that "a grader clicking around should never see a blank screen", and the
 * honest reading of that is not "add a spinner to each page" - every page already had its
 * three states before this step. It is that they were written five separate times, so they
 * disagreed: two pages said "The gateway did not answer", one said "Could not load upstream
 * servers", one had no empty state at all, and a 403 produced a panel headed "Could not load
 * members" - which is true and useless, because the load worked perfectly and the answer was
 * no.
 *
 * Five implementations of one idea drift. This is the one implementation.
 */
import type { ReactNode } from 'react';
import { ApiError } from '../api/client.js';
import { Button } from './Button.js';

/**
 * A loading placeholder shaped like the content it replaces.
 *
 * No pulse animation, on all of them. The reasoning is the same as the Servers page's: three
 * rows load in under a hundred milliseconds, so a pulse appears and vanishes - more
 * distracting than the shape alone, which already says "something is coming". A pulse earns
 * its place when a load is slow enough that the user starts wondering whether anything is
 * happening, and nothing here is.
 */
export function LoadingRows({ rows = 3, height = 'h-16' }: { rows?: number; height?: string }) {
  return (
    <section>
      <div className="mb-6 h-10 w-48 rounded bg-ink-900" />
      <ul className="space-y-2">
        {Array.from({ length: rows }, (_, index) => (
          <li key={index} className={`${height} rounded-lg border border-ink-800 bg-ink-900/40`} />
        ))}
      </ul>
    </section>
  );
}

/**
 * An error, with the failure sorted into the three kinds a user can actually act on.
 *
 * This is the part of 7.5 that did real work. Before it, every failure rendered the same
 * panel with the gateway's sentence in it - correct, and unhelpful for the two cases that are
 * not really errors:
 *
 *   **403** is not a load failure. The request succeeded and the answer was "you may not".
 *   A panel headed "Could not load members" invites the user to retry something that will
 *   never work. It gets its own state: what the page is for, who can see it, and a way out.
 *
 *   **A network failure** (status 0) is not the gateway rejecting anything - it is the
 *   gateway being unreachable, or the browser being offline. Retry is the right action and
 *   the message should say which of the two it might be rather than quoting an HTTP code
 *   that does not exist.
 *
 *   Everything else keeps the gateway's own sentence, because every route in this project
 *   returns a readable `error` field and replacing it would discard that work at the only
 *   place a user sees it.
 */
export function ErrorState({
  error,
  title,
  onRetry,
  /** What this page shows, for the 403 case - "the upstream servers", "the member list". */
  subject,
}: {
  error: unknown;
  title: string;
  onRetry?: () => void;
  subject?: string;
}) {
  const status = error instanceof ApiError ? error.status : undefined;
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'Something went wrong.';

  if (status === 403) {
    return (
      <Panel tone="muted" title="This page is for admins">
        <p className="max-w-prose text-sm leading-relaxed text-ink-400">
          {subject === undefined ? 'This page' : `Viewing ${subject}`} requires an admin account,
          and yours is a member account. Nothing is broken — the gateway checked and said no.
        </p>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-ink-500">
          The check happens on the server for every request against your live account, so this
          is the same answer you would get calling the API directly. An admin can change your
          role from the Members page.
        </p>
      </Panel>
    );
  }

  /**
   * 0 is a true network failure - the fetch itself rejected, so the browser is offline or
   * DNS failed. 502/503/504 mean something else and arrive at the same place: Traefik
   * answered because the gateway has no endpoints or did not respond in time.
   *
   * Both were not grouped originally, and finding that out required producing the outage
   * rather than reasoning about it. I had assumed scaling the gateway to zero would make
   * the fetch reject and hit the status-0 branch. It does not - the ingress is still there,
   * so it answers **503** and the fetch succeeds. Which meant the carefully-worded message
   * below fired only when the user was offline, and the case that actually happens in this
   * deployment - the gateway restarting after a deploy - got the generic panel with
   * "Request failed with HTTP 503" in it.
   */
  if (status === 0 || status === 502 || status === 503 || status === 504) {
    return (
      <Panel tone="bad" title="Cannot reach the gateway">
        <p className="max-w-prose text-sm leading-relaxed text-ink-300">{message}</p>
        <p className="mt-2 max-w-prose text-xs leading-relaxed text-ink-500">
          The dashboard is served by nginx and the API by the gateway, so this page loading
          while requests fail means the gateway specifically is unavailable — most likely
          restarting after a deploy. If the page itself also stops loading, the problem is
          further out than the gateway.
        </p>
        {onRetry === undefined ? undefined : (
          <Button className="mt-4" onClick={onRetry}>
            Try again
          </Button>
        )}
      </Panel>
    );
  }

  return (
    <Panel tone="bad" title={title}>
      {/* break-words, because a gateway error can contain a URL with no spaces in it and an
          unbreakable string would push the panel wider than the viewport. */}
      <p className="max-w-prose break-words text-sm leading-relaxed text-ink-300">{message}</p>
      {status === undefined ? undefined : (
        <p className="mt-2 text-xs text-ink-600">HTTP {status}</p>
      )}
      {onRetry === undefined ? undefined : (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Panel>
  );
}

/**
 * An empty state that explains why it is empty.
 *
 * "No data" is a dead end. Each caller passes the reason this list might legitimately be
 * empty, because in this system most of them have one: no upstreams usually means the seed
 * Job has not run; no audit rows means nothing has called a tool yet; no tools means every
 * upstream is unreachable. A user who knows which of those it is can do something.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 p-8 text-center">
      <p className="text-sm text-ink-300">{title}</p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-500">{children}</p>
      {action === undefined ? undefined : <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * A banner for a failed refresh that still has good data behind it.
 *
 * The case `useResource` was built for: a poll fails, the last known state is still on
 * screen, and replacing the page with an error would throw away information the user can
 * still use. Warning-toned rather than error-toned, because nothing is broken from the
 * user's point of view - the data is just older than it looks.
 */
export function StaleBanner({ error }: { error: string }) {
  return (
    <p className="mb-4 rounded-md border border-warn-600/40 bg-warn-600/10 px-3 py-2 text-sm text-warn-500">
      Showing the last known state — {error}
    </p>
  );
}

function Panel({
  tone,
  title,
  children,
}: {
  tone: 'bad' | 'muted';
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      className={
        tone === 'bad'
          ? 'rounded-lg border border-bad-600/40 bg-bad-600/10 p-6'
          : 'rounded-lg border border-ink-800 bg-ink-900/40 p-6'
      }
    >
      <h1 className="text-base font-semibold text-ink-50">{title}</h1>
      {children}
    </div>
  );
}
