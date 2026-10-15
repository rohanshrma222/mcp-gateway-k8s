/**
 * The aggregator: one tool list assembled from every enabled upstream.
 *
 * The whole point of this file is one property, and it is the brief's own definition of
 * done: **`tools/list` is answered from the database, never by calling upstreams.** So a
 * dead upstream cannot make discovery slow, and it cannot make discovery fail. The
 * prober's cache is what makes that possible; this is what reads it.
 *
 * The alternative - fanning out to every upstream on each `tools/list` - fails in the two
 * ways that matter most. It is as slow as the slowest upstream, so one struggling server
 * degrades every client's startup. And when an upstream is simply down, the fan-out has to
 * choose between failing the whole call and silently omitting that server's tools; the
 * first breaks discovery entirely, the second makes tools vanish with no explanation.
 * Reading a cache has neither problem: the tools are listed, and a call to one gets a
 * precise error.
 */
import type { Db } from '../db.js';

/** One tool as the gateway exposes it. Shaped to go straight into an MCP tools/list reply. */
export interface AggregatedTool {
  /** The prefixed name, e.g. `woo__list_products`. */
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  /** Not part of the MCP shape - used by the dashboard and by the call path. */
  serverId: string;
  serverSlug: string;
  serverName: string;
  upstreamToolName: string;
  lastSeenAt: Date;
}

interface ToolRow {
  prefixed_name: string;
  name: string;
  title: string | null;
  description: string | null;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  last_seen_at: Date;
  server_id: string;
  server_slug: string;
  server_name: string;
}

/**
 * `enabled = true` is in the JOIN, not applied afterwards.
 *
 * Disabling an upstream has to make its tools disappear from `tools/list` - the brief's
 * definition of done requires exactly that, and it is the difference between "disabled" and
 * "unreachable". But the prober deliberately *keeps* the cached rows for a disabled server,
 * so re-enabling it is instant rather than waiting for a probe cycle. So the filter belongs
 * at read time: the cache remembers, the query decides.
 *
 * `status` is deliberately NOT filtered on. An unreachable upstream's tools stay listed,
 * which is the whole reason the cache is kept through an outage - a client sees the tool and
 * gets a precise error on call, instead of watching it silently vanish.
 */
const SELECT_TOOLS = `
  SELECT t.prefixed_name, t.name, t.title, t.description, t.input_schema, t.annotations,
         t.last_seen_at, s.id AS server_id, s.slug AS server_slug, s.name AS server_name
    FROM mcp_tools t
    JOIN mcp_servers s ON s.id = t.server_id
   WHERE s.enabled = true`;

function toTool(row: ToolRow): AggregatedTool {
  return {
    name: row.prefixed_name,
    // Conditional spreads rather than `title: row.title ?? undefined`, because under
    // exactOptionalPropertyTypes an explicit undefined is not the same as an absent key -
    // and an MCP reply should omit a field it has no value for rather than send null.
    ...(row.title === null ? {} : { title: row.title }),
    ...(row.description === null ? {} : { description: row.description }),
    inputSchema: row.input_schema,
    ...(Object.keys(row.annotations).length === 0 ? {} : { annotations: row.annotations }),
    serverId: row.server_id,
    serverSlug: row.server_slug,
    serverName: row.server_name,
    upstreamToolName: row.name,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Every tool from every enabled upstream, ordered so the list is stable.
 *
 * Stable ordering matters more than it looks: an LLM's choice is influenced by the order it
 * reads tools in, so a list that reshuffled between calls would make the agent's behaviour
 * non-reproducible for no reason. Ordering by the exposed name also groups each server's
 * tools together, since the name begins with the slug.
 */
export async function listAggregatedTools(db: Db): Promise<AggregatedTool[]> {
  const result = await db.query<ToolRow>(`${SELECT_TOOLS} ORDER BY t.prefixed_name`);
  return result.rows.map(toTool);
}

export type ResolveToolFailure =
  | { kind: 'unknown-tool' }
  | { kind: 'server-disabled'; slug: string };

export type ResolvedTool =
  | { ok: true; tool: AggregatedTool }
  | { ok: false; reason: ResolveToolFailure };

/**
 * Resolves an exposed name back to its upstream and original tool name.
 *
 * Looked up by the stored `prefixed_name` rather than by parsing the name apart, and that is
 * deliberate: a clamped name's visible tool half is truncated, so parsing would produce a
 * name the upstream has never heard of. The database holds the authoritative mapping -
 * `prefixed_name` is UNIQUE - so one indexed lookup is both correct and cheaper than being
 * clever.
 *
 * The disabled case is distinguished from the unknown case even though both refuse the call.
 * "That server is switched off" and "no such tool" are different problems with different
 * fixes, and a caller who just watched a tool disappear from `tools/list` deserves the first
 * answer rather than being told their tool name is wrong.
 */
export async function resolveTool(db: Db, exposedName: string): Promise<ResolvedTool> {
  const result = await db.query<ToolRow & { enabled: boolean }>(
    `SELECT t.prefixed_name, t.name, t.title, t.description, t.input_schema, t.annotations,
            t.last_seen_at, s.id AS server_id, s.slug AS server_slug, s.name AS server_name,
            s.enabled
       FROM mcp_tools t
       JOIN mcp_servers s ON s.id = t.server_id
      WHERE t.prefixed_name = $1`,
    [exposedName],
  );

  const row = result.rows[0];
  if (row === undefined) return { ok: false, reason: { kind: 'unknown-tool' } };
  if (!row.enabled) {
    return { ok: false, reason: { kind: 'server-disabled', slug: row.server_slug } };
  }

  return { ok: true, tool: toTool(row) };
}

/** Per-upstream counts, for the dashboard's expandable server rows. */
export async function countToolsByServer(db: Db): Promise<Map<string, number>> {
  const result = await db.query<{ server_id: string; n: string }>(
    'SELECT server_id, count(*)::text AS n FROM mcp_tools GROUP BY server_id',
  );
  return new Map(result.rows.map((row) => [row.server_id, Number(row.n)]));
}
