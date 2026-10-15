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
 * they can reach - it is their own capability list. What a member may *call* is the
 * per-tool permission layer in stage 9, and when that arrives this list is filtered by it
 * so a member never sees a tool they would be refused. Today there is no permission layer,
 * so it is the full list and this note is here so the gap is not mistaken for a decision.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { listAggregatedTools } from '../mcp/aggregator.js';
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
      const tools = await listAggregatedTools(deps.db);

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
