/**
 * The Tools page: every tool the gateway advertises, grouped by the server it came from.
 *
 * This page existed as a placeholder until 7.5, and the placeholder was worse than nothing:
 * it said "delivered by step 7.2", which was already finished and had delivered no such
 * thing. A nav link that both roles can see, pointing at a claim that is false. Finding it
 * was the main result of the states audit - the gaps worth fixing were not missing spinners,
 * they were the screens nobody had looked at.
 *
 * It is visible to members as well as admins, deliberately. A member cannot see the Servers
 * page - that is admin-only - so this is the only place they can find out what their API key
 * can actually call. Stage 9's permission layer will filter this list per user, at which
 * point it stops being "what exists" and becomes "what you may use"; the note in the header
 * says so rather than letting the meaning change silently.
 */
import { useMemo } from 'react';
import { api } from '../api/client.js';
import type { AggregatedTool } from '../api/types.js';
import { useResource } from '../hooks/useResource.js';
import { EmptyState, ErrorState, LoadingRows } from '../components/states.js';
import { useSession } from '../auth/session.js';

export function Tools() {
  const { session } = useSession();
  const tools = useResource<AggregatedTool[]>(() => api.tools.list());

  const byServer = useMemo(() => {
    const map = new Map<string, AggregatedTool[]>();
    for (const tool of tools.data ?? []) {
      const list = map.get(tool.server) ?? [];
      list.push(tool);
      map.set(tool.server, list);
    }
    // Sorted by server slug so the order is stable between loads. Without it the grouping
    // follows whatever order the API returned, which is stable today and not promised.
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [tools.data]);

  if (tools.loading) return <LoadingRows rows={3} height="h-24" />;

  if (tools.data === undefined) {
    return (
      <ErrorState
        error={tools.error}
        title="Could not load tools"
        subject="the tool catalogue"
        onRetry={() => void tools.reload()}
      />
    );
  }

  return (
    <section>
      <header className="mb-6">
        <h1 className="text-lg font-semibold tracking-tight text-ink-50">Tools</h1>
        <p className="mt-1 max-w-prose text-sm text-ink-400">
          {tools.data.length} tool{tools.data.length === 1 ? '' : 's'} from {byServer.length} server
          {byServer.length === 1 ? '' : 's'}, all reachable through one endpoint. Names are
          prefixed <code className="rounded bg-ink-900 px-1 py-0.5 text-xs text-ink-300">server__tool</code>{' '}
          so two servers offering the same tool stay distinguishable.
        </p>
        {session?.role === 'member' ? (
          <p className="mt-2 max-w-prose text-xs leading-relaxed text-ink-500">
            This is everything the gateway currently exposes. Per-tool permissions arrive in a
            later step, after which this list shows only what your key may call.
          </p>
        ) : undefined}
      </header>

      {tools.data.length === 0 ? (
        <EmptyState title="No tools are being advertised.">
          The gateway serves this list from its cache, so an empty list means no upstream has
          ever been reached — not that they are momentarily down. Check the Servers page for
          the reason each one gives.
        </EmptyState>
      ) : (
        <div className="space-y-6">
          {byServer.map(([server, list]) => (
            <div key={server}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-200">
                <code className="rounded bg-ink-800 px-1.5 py-0.5 text-xs text-ink-300">{server}</code>
                <span className="text-xs font-normal text-ink-600">
                  {list.length} tool{list.length === 1 ? '' : 's'}
                </span>
              </h2>
              <ul className="grid gap-2 sm:grid-cols-2">
                {list.map((tool) => (
                  <li key={tool.name} className="min-w-0 rounded-lg border border-ink-800 bg-ink-900/40 p-3">
                    {/* break-all on the name: a prefixed name can be 60 characters with no
                        spaces, and the clamp has to break mid-word or the card stretches. */}
                    <code className="block break-all text-xs text-brand-400">{tool.name}</code>
                    {tool.title === undefined ? undefined : (
                      <p className="mt-1 truncate text-xs font-medium text-ink-300">{tool.title}</p>
                    )}
                    {tool.description === undefined ? undefined : (
                      // Three lines. A description is free text from an upstream we do not
                      // control - everything-mcp's are short, but nothing guarantees that.
                      <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-ink-500">
                        {tool.description}
                      </p>
                    )}
                    <p className="mt-1.5 text-[11px] text-ink-600">
                      {/* The upstream's own name for it, which is what appears in that
                          server's logs - useful when correlating with an upstream you also
                          operate. */}
                      upstream calls it <code className="text-ink-500">{tool.upstreamName}</code>
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
