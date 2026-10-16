/**
 * The Servers page: what upstreams exist, whether they are healthy, and why not.
 *
 * This is the page the observability work of stages 5 and 6 exists to feed. Three separate
 * bugs were fixed to stop raw wire text like `MCP error -32001` reaching a user, and the
 * reason column here is where that becomes visible rather than a claim in a commit message.
 */
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import clsx from 'clsx';
import { api, ApiError } from '../api/client.js';
import type { AggregatedTool, UpstreamServer } from '../api/types.js';
import { useResource } from '../hooks/useResource.js';
import { Button } from '../components/Button.js';
import { Dialog } from '../components/Dialog.js';
import { StatusChip, StatusReason, relativeTime } from '../components/StatusChip.js';
import { EmptyState, ErrorState, LoadingRows, StaleBanner } from '../components/states.js';
import { ServerForm } from '../components/ServerForm.js';

/**
 * Ten seconds, against the prober's fifteen.
 *
 * Deliberately not the same number. Polling at the prober's interval means the page and the
 * prober drift in and out of phase, so a status change takes anywhere from 0 to 15 seconds
 * to appear and the lag looks random. Polling faster bounds it: a change is on screen
 * within ten seconds, always. Faster still would be wasted - the underlying value cannot
 * change more often than the prober writes it.
 */
const POLL_MS = 10_000;

export function Servers() {
  const servers = useResource<UpstreamServer[]>(() => api.servers.list(), { intervalMs: POLL_MS });
  // Tools are fetched once, not polled: the catalogue changes when an upstream is added or
  // its tool list changes, both of which already trigger a reload here.
  const tools = useResource<AggregatedTool[]>(() => api.tools.list());

  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<UpstreamServer | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<UpstreamServer | undefined>(undefined);
  const [busyId, setBusyId] = useState<string | undefined>(undefined);

  const toolsBySlug = useMemo(() => {
    const map = new Map<string, AggregatedTool[]>();
    for (const tool of tools.data ?? []) {
      const list = map.get(tool.server) ?? [];
      list.push(tool);
      map.set(tool.server, list);
    }
    return map;
  }, [tools.data]);

  const refresh = useCallback(async () => {
    await Promise.all([servers.reload(), tools.reload()]);
  }, [servers, tools]);

  /**
   * One wrapper for every action, so the toast and the refresh cannot be forgotten.
   *
   * The same structural argument as `pool.use()` in 5.1 and the audit write point in 6.1:
   * if correctness depends on each call site remembering to report a result and reload, the
   * shape is wrong. Here "correctness" is that the user always learns what happened.
   */
  const act = useCallback(
    async (id: string, label: string, operation: () => Promise<unknown>) => {
      setBusyId(id);
      try {
        await operation();
        await refresh();
        toast.success(label);
      } catch (caught) {
        // The gateway's own sentence. Every route in this project returns a readable
        // `error`, and replacing it with "Action failed" would discard that work at the
        // only place a user sees it.
        toast.error(caught instanceof ApiError ? caught.message : `${label} failed`);
      } finally {
        setBusyId(undefined);
      }
    },
    [refresh],
  );

  if (servers.loading) return <LoadingRows rows={3} height="h-20" />;

  // An error with no data at all is the only case that replaces the page. Once there is
  // data, a failed refresh shows a banner and keeps the last known state - see useResource.
  if (servers.data === undefined) {
    // `subject` is what makes the 403 branch readable: a member reaching this URL is told
    // what the page is for and who may see it, rather than being offered a retry that
    // cannot succeed.
    return (
      <ErrorState
        error={servers.failure ?? servers.error}
        title="Could not load servers"
        subject="upstream servers"
        onRetry={() => void servers.reload()}
      />
    );
  }

  return (
    <section>
      <header className="mb-6 flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight text-ink-50">Servers</h1>
          <p className="mt-1 text-sm text-ink-400">
            {servers.data.length} upstream{servers.data.length === 1 ? '' : 's'} ·{' '}
            {tools.data?.length ?? 0} tools exposed through one endpoint
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* The refreshing indicator is text, not a spinner on the button: a spinner that
              appears every ten seconds by itself is motion the user did not cause. */}
          {servers.refreshing ? <span className="text-xs text-ink-600">updating…</span> : undefined}
          <Button intent="primary" onClick={() => setAdding(true)}>
            Add server
          </Button>
        </div>
      </header>

      {/* A stale-data banner rather than replacing the table. The last known statuses are
          more useful than an error page when the gateway blips for one poll. */}
      {servers.error !== undefined && servers.data.length > 0 ? <StaleBanner error={servers.error} /> : undefined}

      {servers.data.length === 0 ? (
        <Empty onAdd={() => setAdding(true)} />
      ) : (
        <ul className="space-y-2">
          {servers.data.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              tools={toolsBySlug.get(server.slug) ?? []}
              toolsLoading={tools.loading}
              expanded={expanded === server.id}
              busy={busyId === server.id}
              onToggle={() => setExpanded((current) => (current === server.id ? undefined : server.id))}
              onEdit={() => setEditing(server)}
              onRemove={() => setConfirmRemove(server)}
              onTest={() =>
                void act(server.id, `${server.slug} answered`, async () => {
                  const result = await api.servers.test(server.id);
                  /**
                   * A failed test is a 200 with a reason, deliberately - 5.1 decided that
                   * "I tried and the connection was refused" is a successful test rather
                   * than a server error. So the failure is thrown here to route it into the
                   * error toast.
                   *
                   * The condition reads `status !== 'connected'`. The first version read
                   * `!result.ok`, against a field that does not exist on this response - so
                   * it was true every time and a SUCCESSFUL test showed an error toast.
                   * Caught by calling the endpoint rather than by reading this file.
                   */
                  if (result.status !== 'connected') {
                    throw new ApiError(200, result.reason ?? 'the upstream did not answer');
                  }
                  // The tool count goes in the toast, because "it answered" is less useful
                  // than "it answered and offered five tools" - the second tells you the
                  // handshake AND the tool list worked.
                  toast.message(`${server.slug}: ${result.toolCount} tool${result.toolCount === 1 ? '' : 's'}`);
                })
              }
              onToggleEnabled={() =>
                void act(
                  server.id,
                  server.enabled ? `Disabled ${server.slug}` : `Enabled ${server.slug}`,
                  () => api.servers.update(server.id, { enabled: !server.enabled }),
                )
              }
            />
          ))}
        </ul>
      )}

      <Dialog
        open={adding}
        onClose={() => setAdding(false)}
        title="Add an upstream server"
        description="The gateway will connect to it and start advertising its tools under a prefix."
      >
        <ServerForm
          mode="create"
          onCancel={() => setAdding(false)}
          onSubmit={async (values) => {
            await api.servers.create({
              name: values.name,
              slug: values.slug,
              url: values.url,
              authType: values.authType,
              ...(values.authHeader === '' ? {} : { authHeader: values.authHeader }),
              ...(values.credential === '' ? {} : { credential: values.credential }),
              timeoutMs: values.timeoutMs,
            });
            setAdding(false);
            await refresh();
            toast.success(`Registered ${values.slug}`);
          }}
        />
      </Dialog>

      <Dialog
        open={editing !== undefined}
        onClose={() => setEditing(undefined)}
        title={editing === undefined ? 'Edit server' : `Edit ${editing.slug}`}
        description="The slug cannot change — it is the prefix on every tool name and on every audit row already written."
      >
        {editing === undefined ? undefined : (
          <ServerForm
            mode="edit"
            server={editing}
            onCancel={() => setEditing(undefined)}
            onSubmit={async (values) => {
              await api.servers.update(editing.id, {
                name: values.name,
                url: values.url,
                authType: values.authType,
                // Sent together with authType, because the gateway validates the RESULTING
                // state: changing the type without the header would be a 400 naming a
                // field this request never contained.
                authHeader: values.authHeader === '' ? null : values.authHeader,
                ...(values.credential === '' ? {} : { credential: values.credential }),
                timeoutMs: values.timeoutMs,
              });
              setEditing(undefined);
              await refresh();
              toast.success(`Updated ${editing.slug}`);
            }}
          />
        )}
      </Dialog>

      <Dialog
        open={confirmRemove !== undefined}
        onClose={() => setConfirmRemove(undefined)}
        title={confirmRemove === undefined ? 'Remove server' : `Remove ${confirmRemove.slug}?`}
        description="Its tools stop being advertised immediately. The audit log keeps every call ever made through it, including the server slug and tool name."
      >
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmRemove(undefined)}>Cancel</Button>
          <Button
            intent="danger"
            onClick={() => {
              const target = confirmRemove;
              if (target === undefined) return;
              setConfirmRemove(undefined);
              void act(target.id, `Removed ${target.slug}`, () => api.servers.remove(target.id));
            }}
          >
            Remove
          </Button>
        </div>
      </Dialog>
    </section>
  );
}

function ServerRow({
  server,
  tools,
  toolsLoading,
  expanded,
  busy,
  onToggle,
  onEdit,
  onRemove,
  onTest,
  onToggleEnabled,
}: {
  server: UpstreamServer;
  tools: AggregatedTool[];
  toolsLoading: boolean;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onTest: () => void;
  onToggleEnabled: () => void;
}) {
  const panelId = `tools-${server.id}`;

  return (
    <li className="rounded-lg border border-ink-800 bg-ink-900/40">
      <div className="flex flex-wrap items-start gap-3 p-3">
        {/*
          A real <button> for the expander, not a clickable div.

          It gets keyboard activation, focus and the right role for free, and
          aria-expanded/aria-controls tell a screen reader that this controls a region and
          whether it is open - which is the entire meaning of the chevron for anyone who
          cannot see it rotate.
        */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-controls={panelId}
          className="flex min-w-0 flex-1 items-start gap-3 rounded text-left"
        >
          <Chevron open={expanded} />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              {/* `truncate` plus `min-w-0` on every ancestor, because a name is free text
                  up to 200 characters and one long word would otherwise widen the card
                  past the viewport. */}
              <span className="truncate font-medium text-ink-100">{server.name}</span>
              <code className="rounded bg-ink-800 px-1.5 py-0.5 text-xs text-ink-400">{server.slug}</code>
              <StatusChip status={server.status} />
              {server.hasCredential ? (
                <span
                  className="text-xs text-ink-500"
                  title="A credential is stored for this server. It cannot be read back - not by this page, and not by any endpoint."
                >
                  🔒 credential attached
                </span>
              ) : undefined}
            </span>
            {/* `break-all` on the URL specifically: it has no spaces, so `break-words`
                would not break it and the row would stretch. */}
            <span className="mt-0.5 block break-all text-xs text-ink-500">{server.url}</span>
            <StatusReason server={server} />
            {/*
              Probe freshness for a HEALTHY server, which StatusReason deliberately does not
              show because it only renders when there is an error.
              
              This is the same concern 6.6 added a metric for: "connected" is a value the
              prober wrote, and it keeps reading "connected" whether that was four seconds
              ago or an hour ago if the prober has stopped. The gauge makes that alertable
              for an operator; this line makes it visible to whoever is looking at the page.
            */}
            {server.status === "connected" && server.lastProbedAt !== null ? (
              <span className="mt-0.5 block text-xs text-ink-600">
                probed {relativeTime(server.lastProbedAt)}
              </span>
            ) : undefined}
          </span>
        </button>

        <div className="flex shrink-0 items-center gap-1.5">
          <span className="tabular hidden text-xs text-ink-600 sm:inline">
            {tools.length} tool{tools.length === 1 ? '' : 's'}
          </span>
          <Button size="sm" onClick={onTest} busy={busy}>
            Test
          </Button>
          <Button size="sm" onClick={onToggleEnabled} busy={busy}>
            {server.enabled ? 'Disable' : 'Enable'}
          </Button>
          <Button size="sm" onClick={onEdit}>
            Edit
          </Button>
          <Button size="sm" intent="ghost" onClick={onRemove} aria-label={`Remove ${server.slug}`}>
            Remove
          </Button>
        </div>
      </div>

      {/* The accordion. See index.css for why grid-template-rows rather than height. */}
      <div id={panelId} className="expandable" data-open={expanded} role="region" aria-label={`Tools from ${server.slug}`}>
        <div>
          <div className="border-t border-ink-800 px-3 py-3">
            {toolsLoading ? (
              <p className="text-xs text-ink-500">Loading tools…</p>
            ) : tools.length === 0 ? (
              <p className="text-xs text-ink-500">
                No tools cached. {server.status === 'connected'
                  ? 'The gateway is connected but this server advertised none.'
                  : 'The gateway has not been able to list them.'}
              </p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {tools.map((tool) => (
                  <li key={tool.name} className="min-w-0 rounded-md bg-ink-900/60 p-2">
                    <code className="block truncate text-xs text-brand-400">{tool.name}</code>
                    {tool.description === undefined ? undefined : (
                      // Clamped to two lines: a tool description is free text from an
                      // upstream we do not control, and one verbose server would otherwise
                      // make this panel pages long.
                      <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-500">
                        {tool.description}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/**
 * The chevron.
 *
 * Rotation only - a transform, so it is composited and costs nothing. 200ms to match the
 * panel it describes: an indicator that finishes before or after the thing it indicates
 * reads as two separate events.
 */
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={clsx(
        'mt-1 size-4 shrink-0 text-ink-500 transition-transform duration-(--duration-panel) ease-(--ease-out)',
        open && 'rotate-90',
      )}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function Empty({ onAdd }: { onAdd: () => void }) {
  return (
    <EmptyState
      title="No upstream servers are registered."
      action={
        <Button intent="primary" onClick={onAdd}>
          Add one manually
        </Button>
      }
    >
      The charts normally pre-register the WooCommerce server, the notes server and the
      reference server on install, so an empty list usually means the seed Job has not run.
    </EmptyState>
  );
}
