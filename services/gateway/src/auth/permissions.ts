/**
 * Who may call which tool.
 *
 * **One decision function, used by both the list path and the call path.** That is the
 * single most important property in this file, and the reason it is written as a batch
 * `decide()` rather than a convenient `isAllowed()` plus a separate filter: if the two paths
 * evaluated permissions independently they could disagree, and both directions of
 * disagreement are bad. A tool that is visible but uncallable looks like a broken gateway. A
 * tool that is hidden but callable is a security hole that testing through the UI will never
 * find, because the UI never asks for it.
 *
 * So `tools/list` filters with `decide()` over every tool, and `tools/call` calls `decide()`
 * with exactly one tool. Same query, same precedence, same default.
 *
 * ## The model
 *
 * A rule in `tool_permissions` (migration 004) names a **subject** - either a role or a
 * single user, never both, enforced by a CHECK constraint - and a **scope**:
 *
 *   | `server_id` | `tool_name` | means                          |
 *   | ----------- | ----------- | ------------------------------ |
 *   | NULL        | NULL        | every tool on every server     |
 *   | set         | NULL        | every tool on that server      |
 *   | set         | set         | that one tool                  |
 *
 * (`tool_name` without `server_id` is rejected by the schema, because a bare tool name is
 * ambiguous - this system deliberately has two tools called `list_products`.)
 *
 * ## Precedence: specificity first, then subject
 *
 *   1. user + server + tool
 *   2. role + server + tool
 *   3. user + server
 *   4. role + server
 *   5. user, everything
 *   6. role, everything
 *   7. no rule matched  ->  **deny**
 *
 * The alternative - putting the subject first, so any user-level rule beats any role-level
 * rule - was rejected, and the example that settles it: with `user=alice -> allow
 * everything` and `role=member + woo__create_product -> deny`, subject-first lets Alice
 * create products. A targeted deny on one dangerous tool should not be undone by a broad
 * convenience grant. Specificity-first reads as "the narrowest rule about the thing you are
 * doing wins, and between two equally narrow rules the one naming you personally wins",
 * which is both safer and easier to explain to the person affected by it.
 *
 * ## Default deny
 *
 * No matching rule means refused. The cost is real and worth stating: register a new
 * upstream and **nobody can call it** until a rule exists, which will surprise someone. The
 * seeded policy grants admins everything, so in practice the person who just registered it
 * can use it immediately and extending it to members is a deliberate act.
 *
 * That is the right default for the opposite reason to the usual one. It is not that
 * default-allow is theoretically unsafe; it is that upstreams here are registered **at
 * runtime** by an admin through an API. A default-allow system would make every member able
 * to call every tool of a server nobody has reviewed, the moment it is added, including
 * whatever write operations it happens to expose.
 */
import type { Db } from '../db.js';
import type { Role } from './tokens.js';

export interface PermissionSubject {
  userId: string;
  role: Role;
}

/** What `decide` is asked about: a tool identified the way the call path identifies it. */
export interface ToolRef {
  serverId: string;
  /** The upstream's own name, not the prefixed one - the server is already identified. */
  toolName: string;
}

export interface Decision {
  allowed: boolean;
  /**
   * Which rule decided, for the audit trail and for an explainable refusal.
   *
   * `undefined` means no rule matched and the default applied, which is a materially
   * different thing to report than "a rule denied you" - the fix for one is "ask for
   * access" and for the other "ask why you were denied".
   */
  ruleId: string | undefined;
  /** Human-readable scope of the deciding rule, e.g. `role=member on woo/create_product`. */
  reason: string;
}

interface DecisionRow {
  server_id: string;
  tool_name: string;
  effect: 'allow' | 'deny' | null;
  rule_id: string | null;
  rule_role: string | null;
  rule_user_id: string | null;
  rule_server_id: string | null;
  rule_tool_name: string | null;
  server_slug: string | null;
}

/**
 * Decide a batch of tools in one round trip.
 *
 * The precedence lives in the `ORDER BY` of a LATERAL subquery, evaluated per tool. Doing
 * it in SQL rather than fetching all rules and sorting in TypeScript is not premature
 * optimisation: `tools/list` is on the hot path of every MCP client connection, and this
 * keeps it one query regardless of how many rules exist. It also means the precedence
 * cannot be implemented twice.
 */
export async function decide(
  db: Db,
  subject: PermissionSubject,
  tools: readonly ToolRef[],
): Promise<Map<string, Decision>> {
  const result = new Map<string, Decision>();
  if (tools.length === 0) return result;

  const serverIds = tools.map((tool) => tool.serverId);
  const toolNames = tools.map((tool) => tool.toolName);

  const { rows } = await db.query<DecisionRow>(
    /**
     * `unnest` with two parallel arrays, so the candidate list is a bind parameter rather
     * than interpolated SQL. One prepared statement whatever the tool count, and nothing
     * caller-derived reaches the query text - tool names come from upstreams we do not
     * control, so that matters here specifically.
     */
    `WITH candidates AS (
       SELECT u.server_id, u.tool_name
         FROM unnest($1::uuid[], $2::text[]) AS u(server_id, tool_name)
     )
     SELECT c.server_id,
            c.tool_name,
            p.effect,
            p.id            AS rule_id,
            p.role          AS rule_role,
            p.user_id       AS rule_user_id,
            p.server_id     AS rule_server_id,
            p.tool_name     AS rule_tool_name,
            s.slug          AS server_slug
       FROM candidates c
       LEFT JOIN mcp_servers s ON s.id = c.server_id
       LEFT JOIN LATERAL (
         SELECT tp.id, tp.effect, tp.role, tp.user_id, tp.server_id, tp.tool_name
           FROM tool_permissions tp
          WHERE (tp.user_id = $3 OR tp.role = $4)
            AND (tp.server_id IS NULL OR tp.server_id = c.server_id)
            AND (tp.tool_name IS NULL OR tp.tool_name = c.tool_name)
          ORDER BY
            -- Specificity first: a rule about this one tool beats one about the server,
            -- which beats one about everything.
            (tp.tool_name IS NOT NULL) DESC,
            (tp.server_id IS NOT NULL) DESC,
            -- Then subject: at equal specificity, a rule naming this user beats one naming
            -- their role. See the header for why this ordering and not the reverse.
            (tp.user_id IS NOT NULL) DESC
          LIMIT 1
       ) p ON TRUE`,
    [serverIds, toolNames, subject.userId, subject.role],
  );

  for (const row of rows) {
    const key = cacheKey(row.server_id, row.tool_name);
    if (row.effect === null) {
      result.set(key, {
        allowed: false,
        ruleId: undefined,
        reason: 'no permission rule matches',
      });
      continue;
    }

    result.set(key, {
      allowed: row.effect === 'allow',
      ruleId: row.rule_id ?? undefined,
      reason: describeRule(row),
    });
  }

  /**
   * Anything the query did not answer for is denied.
   *
   * It should not happen - the LEFT JOINs guarantee one row per candidate - but the
   * consequence of a missing entry is that a caller reads `undefined` and has to decide
   * what that means. Filling the gap here means every caller gets a Decision, and the
   * fail-closed direction is the only acceptable one for a permission check.
   */
  for (const tool of tools) {
    const key = cacheKey(tool.serverId, tool.toolName);
    if (!result.has(key)) {
      result.set(key, {
        allowed: false,
        ruleId: undefined,
        reason: 'the permission query returned no decision for this tool',
      });
    }
  }

  return result;
}

/**
 * Decide one tool. A thin wrapper over `decide` rather than its own query, so the call path
 * and the list path cannot drift - see the note at the top of the file.
 */
export async function decideOne(
  db: Db,
  subject: PermissionSubject,
  tool: ToolRef,
): Promise<Decision> {
  const decisions = await decide(db, subject, [tool]);
  return (
    decisions.get(cacheKey(tool.serverId, tool.toolName)) ?? {
      allowed: false,
      ruleId: undefined,
      reason: 'no decision was produced',
    }
  );
}

export function cacheKey(serverId: string, toolName: string): string {
  // A separator that cannot appear in a uuid, so two different pairs cannot collide on the
  // same key. Tool names can contain almost anything, which is why the uuid comes first.
  return `${serverId}\u0000${toolName}`;
}

function describeRule(row: DecisionRow): string {
  const subject = row.rule_user_id !== null ? 'you specifically' : `role=${row.rule_role ?? '?'}`;
  const scope =
    row.rule_tool_name !== null
      ? `${row.server_slug ?? '?'}/${row.rule_tool_name}`
      : row.rule_server_id !== null
        ? `every tool on ${row.server_slug ?? '?'}`
        : 'every tool';
  return `${row.effect === 'allow' ? 'allowed' : 'denied'} by a rule for ${subject} covering ${scope}`;
}
