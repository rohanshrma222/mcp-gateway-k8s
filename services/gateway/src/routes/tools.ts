/**
 * `GET /api/tools` - the aggregated tool list, for the dashboard.
 *
 * The same data `tools/list` will serve over MCP in 5.4, in a shape a browser finds
 * convenient: grouped by upstream, with each server's status alongside. The MCP endpoint
 * and this route read the same cache through the same function, so they cannot disagree
 * about what exists - which matters because "the dashboard shows a tool my client cannot
 * see" is a confusing bug to chase.
 *
 * Available to any authenticated user, not just admins. A member needs to know what tools
 * they can reach - it is their own capability list.
 *
 * And "can reach" is the whole point, so this list is filtered by the per-tool permission
 * layer, through the same `decide()` the MCP endpoint uses in mcp/server.ts. The note that
 * used to sit here said the filter would arrive with stage 9 and that the unfiltered list
 * was a gap rather than a decision. Stage 9 arrived; the note did not. The result was a
 * dashboard that showed a member all 21 tools while `tools/list` served them 6, which is
 * exactly the "the dashboard shows a tool my client cannot see" confusion the paragraph
 * above claims this route cannot cause.
 *
 * One function, called from both places, is what makes that claim true rather than
 * aspirational - so the filter here is deliberately not a reimplementation. It matches on
 * `upstreamToolName`, not the namespaced name, because that is what the rules store.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { listAggregatedTools } from '../mcp/aggregator.js';
import { decide, cacheKey } from '../auth/permissions.js';
import type { Principal } from '../auth/middleware.js';
import type { Db } from '../db.js';

export interface ToolRouteDeps {
  db: Db;
  requireAuth: (request: never, reply: never) => Promise<void>;
}

export function toolRoutes(deps: ToolRouteDeps) {
  return async function register(
    app: FastifyInstance,
    _opts: FastifyPluginOptions,
  ): Promise<void> {
    app.get('/api/tools', { preHandler: deps.requireAuth as never }, async (request, reply) => {
      const all = await listAggregatedTools(deps.db);
      const principal = request.principal as Principal;

      // One batch query for the whole list, the same shape mcp/server.ts uses: a per-tool
      // round trip here would make the dashboard's cost grow with the catalogue.
      const decisions = await decide(
        deps.db,
        { userId: principal.userId, role: principal.role },
        all.map((tool) => ({ serverId: tool.serverId, toolName: tool.upstreamToolName })),
      );

      const tools = all.filter(
        (tool) => decisions.get(cacheKey(tool.serverId, tool.upstreamToolName))?.allowed === true,
      );

      // Also return each upstream's status, so the dashboard can render a tool next to the
      // health of the server behind it. Without this the UI would show a tool list with no
      // indication that half of it currently cannot be called - which is precisely the
      // "Unreachable with no reason" problem the brief asks us to avoid, one level up.
      const servers = await deps.db.query<{
        id: string;
        slug: string;
        name: string;
        status: string;
        last_error: string | null;
        last_probed_at: Date | null;
      }>(
        `SELECT id, slug, name, status, last_error, last_probed_at
           FROM mcp_servers WHERE enabled = true ORDER BY slug`,
      );

      return reply.send({
        // Flat list first, because that is what an MCP client sees and what the chat agent
        // will work from. The grouping below is a convenience for rendering, not a second
        // source of truth.
        tools: tools.map((tool) => ({
          name: tool.name,
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
          server: tool.serverSlug,
          upstreamName: tool.upstreamToolName,
          lastSeenAt: tool.lastSeenAt,
        })),
        servers: servers.rows.map((server) => ({
          slug: server.slug,
          name: server.name,
          status: server.status,
          lastError: server.last_error,
          lastProbedAt: server.last_probed_at,
          toolCount: tools.filter((tool) => tool.serverId === server.id).length,
        })),
        requestId: request.id,
      });
    });
  };
}
