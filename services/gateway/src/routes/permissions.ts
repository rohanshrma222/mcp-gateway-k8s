/**
 * `/api/permissions` - the admin surface for the tool permission policy (9.1).
 *
 * Four routes, and the fourth is the one that makes the other three usable:
 *
 *   GET    /api/permissions            every rule, with names resolved
 *   POST   /api/permissions            add a rule
 *   DELETE /api/permissions/:id        remove a rule
 *   GET    /api/permissions/effective  what a given user may actually call
 *
 * **Why `effective` exists.** The precedence is specificity-first - a tool rule beats a
 * server rule beats a blanket rule, with a user rule winning ties against their role - which
 * is defensible and genuinely hard to hold in your head once there are more than about four
 * rules. An admin looking at a list of rules cannot reliably answer "so can Alice create
 * products?", and the usual outcome is that they guess, guess wrong, and either grant too
 * much or file a bug.
 *
 * So the question is answered by the same `decide()` the gateway enforces with. Not a
 * re-implementation for display: a preview that disagreed with enforcement would be worse
 * than no preview, because it would be trusted.
 */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { decide } from '../auth/permissions.js';
import { listAggregatedTools } from '../mcp/aggregator.js';
import { cacheKey } from '../auth/permissions.js';

export interface PermissionRouteDeps {
  db: Db;
  logger: Logger;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  requireAdmin: (request: never, reply: never) => Promise<void>;
}

interface RuleRow {
  id: string;
  role: string | null;
  user_id: string | null;
  user_email: string | null;
  server_id: string | null;
  server_slug: string | null;
  tool_name: string | null;
  effect: 'allow' | 'deny';
  created_at: Date;
}

const createRule = z
  .object({
    /**
     * Exactly one subject, mirroring the CHECK constraint in migration 004.
     *
     * Validated here as well as in the database so the error names the field rather than a
     * constraint. A 400 saying "give either role or userId, not both" is actionable; a 500
     * quoting `tool_permissions_one_subject` is a thing an admin has to ask an engineer
     * about.
     */
    role: z.enum(['admin', 'member']).optional(),
    userId: z.string().uuid().optional(),
    serverId: z.string().uuid().optional(),
    /** The upstream's own tool name, unprefixed. Requires serverId. */
    toolName: z.string().min(1).max(200).optional(),
    effect: z.enum(['allow', 'deny']),
  })
  .refine((rule) => (rule.role === undefined) !== (rule.userId === undefined), {
    message: 'give exactly one of role or userId',
  })
  .refine((rule) => rule.toolName === undefined || rule.serverId !== undefined, {
    // Not a formality: this system deliberately ships two tools called `list_products`, so a
    // bare tool name genuinely does not identify one.
    message: 'a rule naming a tool must also name its server',
  });

const effectiveQuery = z.object({
  userId: z.string().uuid(),
});

export function permissionRoutes(deps: PermissionRouteDeps): FastifyPluginAsync {
  return async function register(app: FastifyInstance): Promise<void> {
    const adminOnly = {
      preHandler: [deps.requireAuth as never, deps.requireAdmin as never],
    };

    app.get('/api/permissions', adminOnly, async () => {
      const { rows } = await deps.db.query<RuleRow>(
        `SELECT p.id, p.role, p.user_id, u.email AS user_email,
                p.server_id, s.slug AS server_slug, p.tool_name, p.effect, p.created_at
           FROM tool_permissions p
           LEFT JOIN users u       ON u.id = p.user_id
           LEFT JOIN mcp_servers s ON s.id = p.server_id
          ORDER BY
            -- Listed in precedence order rather than by creation time, so the list reads
            -- the way the engine evaluates it. A policy list sorted by when somebody
            -- happened to add each rule tells you nothing about which one wins.
            (p.tool_name IS NOT NULL) DESC,
            (p.server_id IS NOT NULL) DESC,
            (p.user_id IS NOT NULL) DESC,
            s.slug NULLS FIRST, p.tool_name NULLS FIRST, p.role NULLS FIRST`,
      );

      return {
        rules: rows.map((row) => ({
          id: row.id,
          role: row.role ?? undefined,
          userId: row.user_id ?? undefined,
          userEmail: row.user_email ?? undefined,
          serverId: row.server_id ?? undefined,
          serverSlug: row.server_slug ?? undefined,
          toolName: row.tool_name ?? undefined,
          effect: row.effect,
          createdAt: row.created_at.toISOString(),
        })),
      };
    });

    app.post('/api/permissions', adminOnly, async (request, reply) => {
      const parsed = createRule.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid rule',
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      const rule = parsed.data;

      try {
        const { rows } = await deps.db.query<{ id: string }>(
          `INSERT INTO tool_permissions (role, user_id, server_id, tool_name, effect)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [
            rule.role ?? null,
            rule.userId ?? null,
            rule.serverId ?? null,
            rule.toolName ?? null,
            rule.effect,
          ],
        );

        const created = rows[0];
        if (created === undefined) throw new Error('inserting a permission rule returned no row');

        deps.logger.info(
          {
            ruleId: created.id,
            actor: request.principal?.email,
            subject: rule.role ?? rule.userId,
            serverId: rule.serverId,
            toolName: rule.toolName,
            effect: rule.effect,
          },
          /**
           * Logged at info with the acting admin, because `audit_log` covers tool CALLS
           * only - a gap named in 7.3 and still open. A policy change is exactly the kind
           * of administrative action that ought to be queryable, and until it is, the log
           * is the only record of who widened access and when.
           */
          'permission rule created',
        );

        return reply.code(201).send({ id: created.id });
      } catch (caught) {
        /**
         * 23505 is a unique violation, which here means a rule already exists at this exact
         * scope - migration 004's unique indexes enforce one rule per (subject, server,
         * tool). Reported as a 409 naming the conflict rather than a 500, because "that rule
         * already exists" is a thing the admin can act on, and the alternative action -
         * silently updating the existing rule's effect - would make a POST quietly change a
         * decision somebody else made.
         */
        if (isUniqueViolation(caught)) {
          return reply.code(409).send({
            error:
              'a rule already exists for that subject and scope; delete it first if you want to change its effect',
          });
        }
        throw caught;
      }
    });

    app.delete('/api/permissions/:id', adminOnly, async (request, reply) => {
      const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
      if (!params.success) return reply.code(400).send({ error: 'invalid rule id' });

      const { rowCount } = await deps.db.query(
        'DELETE FROM tool_permissions WHERE id = $1',
        [params.data.id],
      );

      if (rowCount === 0) return reply.code(404).send({ error: 'no such rule' });

      /**
       * A hard DELETE, unlike users and keys, which are disabled and revoked respectively.
       *
       * The difference is what the row means afterwards. A revoked key id has to stay
       * resolvable because audit rows reference it; a deleted permission rule is referenced
       * by nothing - the audit log records the DECISION, not the rule that produced it. So
       * there is nothing to keep, and a tombstoned policy table would make the precedence
       * list harder to read for no benefit.
       */
      deps.logger.info(
        { ruleId: params.data.id, actor: request.principal?.email },
        'permission rule deleted',
      );

      return reply.code(204).send();
    });

    /**
     * What a user may actually call, computed with the enforcement path's own function.
     */
    app.get('/api/permissions/effective', adminOnly, async (request, reply) => {
      const parsed = effectiveQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'give a userId' });
      }

      const user = await deps.db.query<{ id: string; email: string; role: 'admin' | 'member' }>(
        'SELECT id, email, role FROM users WHERE id = $1',
        [parsed.data.userId],
      );
      const subject = user.rows[0];
      if (subject === undefined) return reply.code(404).send({ error: 'no such user' });

      const tools = await listAggregatedTools(deps.db);
      const decisions = await decide(
        deps.db,
        { userId: subject.id, role: subject.role },
        tools.map((tool) => ({ serverId: tool.serverId, toolName: tool.upstreamToolName })),
      );

      return {
        user: { id: subject.id, email: subject.email, role: subject.role },
        tools: tools.map((tool) => {
          const decision = decisions.get(cacheKey(tool.serverId, tool.upstreamToolName));
          return {
            name: tool.name,
            server: tool.serverSlug,
            allowed: decision?.allowed === true,
            /**
             * The reason travels with the decision, so the UI can say *why* rather than
             * showing a tick nobody can account for. This is the difference between a
             * preview and an explanation.
             */
            reason: decision?.reason ?? 'no decision',
          };
        }),
      };
    });
  };
}

function isUniqueViolation(caught: unknown): boolean {
  return (
    typeof caught === 'object' &&
    caught !== null &&
    'code' in caught &&
    (caught as { code?: unknown }).code === '23505'
  );
}
