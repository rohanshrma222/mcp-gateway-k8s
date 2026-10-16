/**
 * The Audit page: every tool call, filterable, newest first.
 *
 * This is the page the brief's "visible in the dashboard" requirement names, and the one
 * where the keyset pagination from 6.2 becomes visible as a design constraint rather than an
 * implementation detail - see the note on `loadMore` below.
 *
 * **Nothing here animates, and that is the decision.** An audit table is scrolled, filtered
 * and re-filtered by whoever is investigating something; rows arrive in batches of fifty.
 * Staggering their entrance - the obvious flourish - would mean waiting for a cascade before
 * being able to read the thing you came to read, every single time. The guidance is explicit
 * that stagger is for a list seen occasionally and not for one scrolled past all day. The
 * only motion on the page is the press feedback the shared Button already has.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { api } from '../api/client.js';
import type { AuditEntry, AuditPage, AuditSummaryBucket } from '../api/types.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../components/Button.js';
import { relativeTime } from '../components/StatusChip.js';
import { useSession } from '../auth/session.js';

/** The four outcomes, mapped to the same vocabulary the database and the metrics use. */
const OUTCOME_STYLE: Record<string, string> = {
  ok: 'border-ok-600/40 bg-ok-600/10 text-ok-500',
  error: 'border-bad-600/40 bg-bad-600/10 text-bad-500',
  timeout: 'border-warn-600/40 bg-warn-600/10 text-warn-500',
  denied: 'border-ink-700 bg-ink-800/60 text-ink-300',
};

interface Filters {
  user: string;
  server: string;
  tool: string;
  outcome: string;
  errorCode: string;
  actor: string;
  from: string;
  to: string;
}

const EMPTY: Filters = { user: '', server: '', tool: '', outcome: '', errorCode: '', actor: '', from: '', to: '' };

const PAGE = 50;

export function Audit() {
  const { session } = useSession();
  const [filters, setFilters] = useState<Filters>(EMPTY);
  /**
   * The filters the table is actually using, debounced.
   *
   * Typing "woo__list_products" into the tool box would otherwise fire eighteen requests,
   * each one cancelling the previous answer's relevance. 300ms is long enough to finish a
   * word and short enough not to feel laggy.
   */
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [extraPages, setExtraPages] = useState<AuditEntry[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | undefined>(undefined);

  useEffect(() => {
    const timer = window.setTimeout(() => setApplied(filters), 300);
    return () => window.clearTimeout(timer);
  }, [filters]);

  const query = useMemo(
    () => ({
      limit: PAGE,
      ...(applied.user === '' ? {} : { user: applied.user }),
      ...(applied.server === '' ? {} : { server: applied.server }),
      ...(applied.tool === '' ? {} : { tool: applied.tool }),
      ...(applied.outcome === '' ? {} : { outcome: applied.outcome }),
      ...(applied.errorCode === '' ? {} : { errorCode: applied.errorCode }),
      ...(applied.actor === '' ? {} : { actor: applied.actor }),
      // datetime-local gives "2026-10-16T09:30" with no zone. Sent as-is would be
      // ambiguous; appending the browser's offset makes it the instant the user meant.
      ...(applied.from === '' ? {} : { from: new Date(applied.from).toISOString() }),
      ...(applied.to === '' ? {} : { to: new Date(applied.to).toISOString() }),
    }),
    [applied],
  );

  /**
   * No polling on either, and the option is OMITTED rather than passed as undefined -
   * `exactOptionalPropertyTypes` rejects the explicit undefined, the same distinction as
   * woo-mcp omitting `sessionIdGenerator`.
   *
   * The audit log is append-only history. A row never changes once written, so there is
   * nothing to refresh *into* - only newer rows to discover, which is what the filters and
   * a reload are for. Polling it would re-fetch fifty immutable rows every ten seconds to
   * learn nothing, and would fight the "Load more" accumulator by resetting the first page
   * underneath it.
   */
  const page = useResource<AuditPage>(() => api.audit.list(query));
  const summary = useResource<AuditSummaryBucket[]>(() => api.audit.summary());

  // A ref so the effect below does not depend on the resource object identity, which
  // changes every render and would reset the accumulator continuously.
  const reload = useRef(page.reload);
  reload.current = page.reload;

  /**
   * Any filter change discards the accumulated pages and re-fetches from the top.
   *
   * Without this, "Load more" would append rows from the *previous* query - the cursor is
   * only meaningful within one filter set, because it encodes a position in an ordering the
   * filters define. The symptom would be a table that mixes two searches, which is far worse
   * than a slow one.
   */
  useEffect(() => {
    setExtraPages([]);
    setMoreError(undefined);
    void reload.current();
  }, [applied]);

  const entries = useMemo(() => [...(page.data?.entries ?? []), ...extraPages], [page.data, extraPages]);

  /**
   * "Load more", not page numbers.
   *
   * This is the visible cost of the keyset cursor chosen in 6.2, and it is worth being
   * straight about: a cursor cannot jump to page 7, because it encodes "after this row"
   * rather than "skip 300 rows". What it buys is that rows never repeat or vanish while
   * somebody reads - which on an audit log, where the whole point is being able to trust you
   * saw everything, is the better half of the trade.
   */
  const loadMore = useCallback(async () => {
    const cursor = extraPages.length > 0 ? lastCursorRef.current : page.data?.nextCursor;
    if (cursor === undefined || cursor === null) return;
    setLoadingMore(true);
    setMoreError(undefined);
    try {
      const next = await api.audit.list({ ...query, cursor });
      setExtraPages((current) => [...current, ...next.entries]);
      lastCursorRef.current = next.nextCursor;
      hasMoreRef.current = next.hasMore;
    } catch (caught) {
      setMoreError(caught instanceof Error ? caught.message : 'Could not load more rows.');
    } finally {
      setLoadingMore(false);
    }
  }, [extraPages.length, page.data, query]);

  const lastCursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(false);
  const hasMore = extraPages.length > 0 ? hasMoreRef.current : (page.data?.hasMore ?? false);

  const activeCount = Object.values(applied).filter((value) => value !== '').length;

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink-50">Audit</h1>
        <p className="mt-1 text-sm text-ink-400">
          Every tool call, newest first.{' '}
          {page.data?.scope === 'self' ? (
            <>
              You are seeing <strong className="font-medium text-ink-300">your own</strong> calls — an
              admin sees everyone&rsquo;s.
            </>
          ) : (
            <>You are an admin, so this is every user&rsquo;s activity.</>
          )}
        </p>
      </header>

      <Summary buckets={summary.data} />

      <FilterBar
        filters={filters}
        onChange={setFilters}
        onClear={() => setFilters(EMPTY)}
        activeCount={activeCount}
        busy={page.refreshing}
        isAdmin={session?.role === 'admin'}
      />

      {page.loading ? (
        <TableSkeleton />
      ) : page.data === undefined ? (
        <div className="rounded-lg border border-bad-600/40 bg-bad-600/10 p-6">
          <p className="break-words text-sm text-ink-300">{page.error ?? 'Could not load the audit log.'}</p>
          <Button className="mt-4" onClick={() => void page.reload()}>
            Try again
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <Empty hasFilters={activeCount > 0} onClear={() => setFilters(EMPTY)} />
      ) : (
        <>
          <Table entries={entries} onFilter={(patch) => setFilters((current) => ({ ...current, ...patch }))} />

          <div className="mt-4 flex items-center gap-3">
            {hasMore ? (
              <Button onClick={() => void loadMore()} busy={loadingMore}>
                Load 50 more
              </Button>
            ) : (
              <span className="text-xs text-ink-600">
                That is everything{activeCount > 0 ? ' matching these filters' : ''}.
              </span>
            )}
            <span className="tabular text-xs text-ink-600">{entries.length} shown</span>
            {moreError === undefined ? undefined : (
              <span className="text-xs text-bad-500">{moreError}</span>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The outcome summary.
 *
 * Above the filters on purpose. The filters are only useful to somebody who already knows
 * what to look for, and this is the thing that tells them - "6 unreachable, p95 10.5s" is
 * what makes you click a filter. Same reasoning that put the endpoint in 6.2 beyond the
 * step's requirements.
 */
function Summary({ buckets }: { buckets: AuditSummaryBucket[] | undefined }) {
  if (buckets === undefined || buckets.length === 0) return undefined;
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  return (
    <div className="mb-5 flex flex-wrap gap-2">
      <span className="tabular rounded-md border border-ink-800 bg-ink-900/40 px-2.5 py-1 text-xs text-ink-400">
        {total.toLocaleString()} calls
      </span>
      {buckets.map((bucket) => (
        <span
          key={`${bucket.outcome}-${bucket.errorCode ?? 'none'}`}
          className={clsx(
            'tabular rounded-md border px-2.5 py-1 text-xs',
            OUTCOME_STYLE[bucket.outcome] ?? 'border-ink-700 text-ink-300',
          )}
        >
          {bucket.count.toLocaleString()} {bucket.errorCode ?? bucket.outcome}
          {/* p95 only where it means something. On 'ok' it is the latency people quote; on a
              failure bucket it is how long the failure took to give up, which is the more
              interesting number and the one that showed the circuit breaker working. */}
          {bucket.p95Ms === null ? undefined : (
            <span className="ml-1.5 text-ink-500">p95 {formatDuration(bucket.p95Ms)}</span>
          )}
        </span>
      ))}
    </div>
  );
}

function FilterBar({
  filters,
  onChange,
  onClear,
  activeCount,
  busy,
  isAdmin,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  onClear: () => void;
  activeCount: number;
  busy: boolean;
  isAdmin: boolean;
}) {
  const set = <K extends keyof Filters>(key: K, value: string) => onChange({ ...filters, [key]: value });

  return (
    <div className="mb-4 rounded-lg border border-ink-800 bg-ink-900/40 p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* The user filter is admin-only, because a member's view is scoped to themselves
            server-side regardless - offering the box would be offering a control that
            cannot do anything, which is worse than not offering it. */}
        {isAdmin ? <Text id="f-user" label="User" value={filters.user} onChange={(v) => set('user', v)} placeholder="admin@urumi.local" /> : undefined}
        <Text id="f-server" label="Server" value={filters.server} onChange={(v) => set('server', v)} placeholder="woo" />
        <Text id="f-tool" label="Tool" value={filters.tool} onChange={(v) => set('tool', v)} placeholder="woo__list_products" />
        <Select
          id="f-outcome"
          label="Outcome"
          value={filters.outcome}
          onChange={(v) => set('outcome', v)}
          options={[
            ['', 'Any'],
            ['ok', 'ok'],
            ['error', 'error'],
            ['denied', 'denied'],
            ['timeout', 'timeout'],
          ]}
        />
        <Select
          id="f-code"
          label="Error code"
          value={filters.errorCode}
          onChange={(v) => set('errorCode', v)}
          options={[
            ['', 'Any'],
            ['unknown_tool', 'unknown_tool'],
            ['server_disabled', 'server_disabled'],
            ['permission_denied', 'permission_denied'],
            ['upstream_unreachable', 'upstream_unreachable'],
            ['upstream_timeout', 'upstream_timeout'],
            ['credential_error', 'credential_error'],
            ['upstream_error', 'upstream_error'],
            ['server_removed', 'server_removed'],
            ['internal_error', 'internal_error'],
          ]}
        />
        <Select
          id="f-actor"
          label="Came from"
          value={filters.actor}
          onChange={(v) => set('actor', v)}
          options={[
            ['', 'Any'],
            ['external', 'external client'],
            ['chat', 'chat agent'],
          ]}
        />
        <Text id="f-from" label="From" type="datetime-local" value={filters.from} onChange={(v) => set('from', v)} />
        <Text id="f-to" label="To" type="datetime-local" value={filters.to} onChange={(v) => set('to', v)} />
      </div>

      <div className="mt-3 flex items-center gap-3">
        <Button size="sm" onClick={onClear} disabled={activeCount === 0}>
          Clear {activeCount === 0 ? 'filters' : `${activeCount} filter${activeCount === 1 ? '' : 's'}`}
        </Button>
        {/* Text, not a spinner: this fires on a debounce the user did not explicitly
            trigger, and a spinner appearing by itself is motion they did not cause. */}
        {busy ? <span className="text-xs text-ink-600">searching…</span> : undefined}
      </div>
    </div>
  );
}

function Table({
  entries,
  onFilter,
}: {
  entries: AuditEntry[];
  onFilter: (patch: Partial<Filters>) => void;
}) {
  return (
    // A real <table>, not a grid of divs. Screen readers announce row and column
    // relationships from it, and an audit log is exactly the kind of dense tabular data
    // where that matters.
    <div className="overflow-x-auto rounded-lg border border-ink-800">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-ink-800 bg-ink-900/60 text-xs uppercase tracking-wide text-ink-500">
            <th scope="col" className="px-3 py-2 font-medium">When</th>
            <th scope="col" className="px-3 py-2 font-medium">Who</th>
            <th scope="col" className="px-3 py-2 font-medium">Tool</th>
            <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Duration</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <Row key={entry.id} entry={entry} onFilter={onFilter} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ entry, onFilter }: { entry: AuditEntry; onFilter: (patch: Partial<Filters>) => void }) {
  return (
    <tr className="border-b border-ink-800/60 align-top last:border-0">
      <td className="whitespace-nowrap px-3 py-2 text-xs text-ink-400">
        {/* Relative above, absolute below. "4m ago" answers "is this recent", the timestamp
            answers "which call was this" - and on an audit log somebody will eventually need
            to correlate with a log line, so the exact instant has to be present. */}
        <span className="block">{relativeTime(entry.startedAt)}</span>
        <span className="tabular block text-ink-600">{new Date(entry.startedAt).toLocaleTimeString()}</span>
      </td>

      <td className="px-3 py-2 text-xs">
        {/*
          The "links" the step asks for: clicking a value filters by it.

          There is no per-user or per-server page to navigate to, so a hyperlink would be a
          lie about where it goes. Filtering is what somebody actually wants when they see an
          interesting value in a table - and it keeps them on the row they were reading.
        */}
        {entry.userEmail === null ? (
          <span className="text-ink-600">(deleted user)</span>
        ) : (
          <FilterLink
            label={entry.userEmail}
            title={`Show only ${entry.userEmail}`}
            onClick={() => onFilter({ user: entry.userEmail ?? '' })}
          />
        )}
        <span className="mt-0.5 block text-ink-600">
          {entry.actor === 'chat' ? 'via chat agent' : 'external client'}
        </span>
      </td>

      <td className="min-w-0 px-3 py-2 text-xs">
        <FilterLink
          label={entry.toolName}
          title={`Show only ${entry.toolName}`}
          onClick={() => onFilter({ tool: entry.toolName })}
          mono
        />
        {entry.serverSlug === null ? (
          <span className="mt-0.5 block text-ink-600">(server removed)</span>
        ) : (
          <span className="mt-0.5 block">
            <FilterLink
              label={entry.serverSlug}
              title={`Show only ${entry.serverSlug}`}
              onClick={() => onFilter({ server: entry.serverSlug ?? '' })}
              muted
            />
          </span>
        )}
      </td>

      <td className="px-3 py-2">
        <span
          className={clsx(
            'inline-block rounded border px-1.5 py-0.5 text-xs font-medium',
            OUTCOME_STYLE[entry.outcome] ?? 'border-ink-700 text-ink-300',
          )}
        >
          {entry.outcome}
        </span>
        {entry.errorCode === null ? undefined : (
          <button
            type="button"
            onClick={() => onFilter({ errorCode: entry.errorCode ?? '' })}
            className="mt-0.5 block font-mono text-[11px] text-ink-500 underline-offset-2 hover:underline"
            title={`Show only ${entry.errorCode}`}
          >
            {entry.errorCode}
          </button>
        )}
        {entry.errorMessage === null ? undefined : (
          // Clamped to three lines. An upstream's message is forwarded verbatim by design
          // and the column caps it at 2,000 characters, so one verbose failure would
          // otherwise make a single row taller than the screen.
          <p className="mt-1 line-clamp-3 max-w-md break-words text-[11px] leading-relaxed text-ink-500">
            {entry.errorMessage}
          </p>
        )}
      </td>

      <td className="tabular whitespace-nowrap px-3 py-2 text-right text-xs text-ink-300">
        {formatDuration(entry.durationMs)}
      </td>
    </tr>
  );
}

/** A value that filters by itself when clicked. */
function FilterLink({
  label,
  title,
  onClick,
  mono = false,
  muted = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  mono?: boolean;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={clsx(
        'max-w-[22ch] truncate text-left underline-offset-2 hover:underline',
        mono && 'font-mono',
        muted ? 'text-ink-500' : 'text-brand-400',
      )}
    >
      {label}
    </button>
  );
}

/**
 * Durations, in the unit that makes them comparable at a glance.
 *
 * A column of raw milliseconds makes 2 and 10504 look similar in width and completely
 * unalike in meaning. Switching unit at a second keeps the digit count small, and combined
 * with tabular figures the column stays scannable - which is how the circuit breaker is
 * visible in this table at all: 10.5s, 10.5s, 10.5s, then 2ms.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(2)}s`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function Text({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'datetime-local';
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-400">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) placeholder:text-ink-600 focus:border-brand-500 sm:text-sm"
      />
    </div>
  );
}

function Select({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-400">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-md border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-base text-ink-100 transition-[border-color] duration-(--duration-press) ease-(--ease-out) focus:border-brand-500 sm:text-sm"
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-800">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        // No pulse, for the same reason as the Servers page: the shape says "loading".
        <div key={index} className="h-12 border-b border-ink-800/60 last:border-0" />
      ))}
    </div>
  );
}

function Empty({ hasFilters, onClear }: { hasFilters: boolean; onClear: () => void }) {
  return (
    <div className="rounded-lg border border-dashed border-ink-700 p-8 text-center">
      <p className="text-sm text-ink-300">
        {hasFilters ? 'No calls match these filters.' : 'No tool calls have been made yet.'}
      </p>
      <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-ink-500">
        {hasFilters
          ? 'The log is append-only, so a filter returning nothing means nothing matched — not that something was removed.'
          : 'Connect an MCP client to /mcp with an API key and call a tool; every call lands here, attributed to the key’s owner.'}
      </p>
      {hasFilters ? (
        <Button className="mt-4" onClick={onClear}>
          Clear filters
        </Button>
      ) : undefined}
    </div>
  );
}
