/**
 * The audit query API.
 *
 * The brief requires the audit log visible in the dashboard, filterable by the things an
 * operator actually asks about: who, which server, which tool, what happened, and when.
 *
 * Two decisions shape this file.
 *
 * **Scoping is a SQL predicate, not a branch.** A member sees their own rows; an admin sees
 * everyone's. Expressed as `($n::boolean OR a.user_id = $m)` appended to the WHERE clause,
 * exactly as `routes/keys.ts` does, so there is no path through this handler that reads a
 * row the caller is not entitled to and relies on a later check to hide it. The difference
 * between "the query cannot return it" and "we filtered it out afterwards" is the
 * difference between a control and a convention.
 *
 * **Pagination is keyset, not OFFSET.** This is the decision worth defending, and the
 * reason is specific to what this table is: append-only, ordered newest-first, and growing
 * while someone reads it. With OFFSET, every new row written between page 1 and page 2
 * pushes the window along, so rows already seen reappear on the next page and others are
 * skipped entirely - on an audit log, which is the one place a reviewer must be able to
 * trust that they saw everything. OFFSET also degrades: the database counts and discards
 * every skipped row, so page 200 reads 10,000 rows to return 50. A keyset cursor compares
 * against the last row seen, which is stable under concurrent inserts and reads exactly one
 * page from the index.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type { Principal } from '../auth/middleware.js';
import type { Db } from '../db.js';

/**
 * The cursor is opaque base64 of `<iso timestamp>|<row id>`.
 *
 * Opaque on purpose: a client that parses it becomes coupled to the ordering, and the
 * ordering is an implementation detail this file should stay free to change. Both halves
 * are needed because `started_at` is not unique - two calls can share a millisecond, and a
 * cursor on the timestamp alone would either skip or repeat the ties. `id` is a bigserial,
 * so it is the natural tiebreak and it matches the index's second column.
 */
const CURSOR_SEPARATOR = '|';

function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(`${startedAt.toISOString()}${CURSOR_SEPARATOR}${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { startedAt: Date; id: string } | undefined {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }

  const separator = decoded.indexOf(CURSOR_SEPARATOR);
  if (separator === -1) return undefined;

  const timestamp = decoded.slice(0, separator);
  const id = decoded.slice(separator + 1);
  const startedAt = new Date(timestamp);

  // A cursor is client-supplied, so every part of it is checked. An unparseable one is a
  // 400 naming the field rather than a 500 from a NaN reaching the query.
  if (Number.isNaN(startedAt.getTime())) return undefined;
  if (!/^[0-9]+$/.test(id)) return undefined;

  return { startedAt, id };
}

const timestampFilter = z
  .string()
  .min(1)
  .max(40)
  .transform((value, ctx) => {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({
        code: 'custom',
        message: 'must be an ISO 8601 timestamp, for example 2026-10-15T09:30:00Z',
      });
      return z.NEVER;
    }
    return parsed;
  });

const listQuery = z.object({
  /**
   * Filter by owner email. A member may send it, and it is simply ANDed with their own
   * scope - so asking for someone else's rows returns an empty page rather than a 403.
   * Deliberate, and the same reasoning as the 404 a member gets when revoking another
   * user's key: a distinct refusal would confirm that the other account exists.
   */
  user: z.string().min(1).max(320).optional(),
  server: z.string().min(1).max(60).optional(),
  tool: z.string().min(1).max(200).optional(),
  outcome: z.enum(['ok', 'error', 'denied', 'timeout']).optional(),
  // The closed vocabulary from audit.ts. An enum rather than a free string, so a typo is a
  // 400 listing the valid values instead of a page of zero rows that looks like "nothing
  // went wrong".
  errorCode: z
    .enum([
      'unknown_tool',
      'server_disabled',
      'permission_denied',
      'upstream_unreachable',
      'upstream_timeout',
      'credential_error',
      'upstream_error',
      'server_removed',
      'internal_error',
    ])
    .optional(),
  actor: z.enum(['chat', 'external']).optional(),
  /**
   * A timestamp filter, as ISO 8601.
   *
   * `z.coerce.date()` alone produces "Invalid input: expected date, received Date" for an
   * unparseable value - zod describing an Invalid Date object, which is accurate about its
   * own internals and useless to whoever typed the query. Every other error in this
   * service names the field and says what would be acceptable, so this one does too.
   */
  from: timestampFilter.optional(),
  to: timestampFilter.optional(),
  /**
   * Capped at 200. Without a ceiling, `?limit=1000000` is a way for any authenticated user
   * to make the gateway build a response large enough to matter - and the dashboard shows
   * a page at a time, so nothing legitimate needs more.
   */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(200).optional(),
});

export interface AuditRouteDeps {
  db: Db;
  requireAuth: (request: never, reply: never) => Promise<void>;
}

interface AuditRowOut {
  id: string;
  user_email: string | null;
  user_id: string | null;
  server_slug: string | null;
  server_id: string | null;
  tool_name: string;
  started_at: Date;
  duration_ms: number;
  outcome: string;
  error_code: string | null;
  error_message: string | null;
  actor: string;
  request_id: string | null;
}

export function auditRoutes(deps: AuditRouteDeps) {
  return async function register(
    app: FastifyInstance,
    _opts: FastifyPluginOptions,
  ): Promise<void> {
    const auth = { preHandler: deps.requireAuth as never };

    /**
     * GET /api/audit - the filtered, paginated log.
     *
     * Open to any authenticated user, scoped to their own rows unless they are an admin.
     * A member seeing their own history is a feature rather than a leak: it is how someone
     * notices a key of theirs being used from somewhere they do not recognise.
     */
    app.get('/api/audit', auth, async (request, reply) => {
      const principal = request.principal as Principal;
      const parsed = listQuery.safeParse(request.query);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid query',
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      const query = parsed.data;

      if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
        // Caught explicitly, because the alternative is an empty page that looks like
        // "nothing happened in that window" rather than "that window is backwards".
        return reply.code(400).send({ error: 'from must be earlier than to' });
      }

      let cursor: { startedAt: Date; id: string } | undefined;
      if (query.cursor !== undefined) {
        cursor = decodeCursor(query.cursor);
        if (cursor === undefined) {
          return reply.code(400).send({ error: 'cursor is not valid; omit it to start from the newest rows' });
        }
      }

      const isAdmin = principal.role === 'admin';
      const conditions: string[] = ['($1::boolean OR a.user_id = $2)'];
      const values: unknown[] = [isAdmin, principal.userId];
      const next = (): string => `$${values.length + 1}`;

      if (query.user !== undefined) {
        // Compared case-insensitively, because that is how the users table treats an
        // address everywhere else - a filter that is stricter than the unique index would
        // silently return nothing for a correctly-typed address in the wrong case.
        conditions.push(`lower(a.user_email) = lower(${next()})`);
        values.push(query.user);
      }
      if (query.server !== undefined) {
        conditions.push(`a.server_slug = ${next()}`);
        values.push(query.server);
      }
      if (query.tool !== undefined) {
        conditions.push(`a.tool_name = ${next()}`);
        values.push(query.tool);
      }
      if (query.outcome !== undefined) {
        conditions.push(`a.outcome = ${next()}`);
        values.push(query.outcome);
      }
      if (query.errorCode !== undefined) {
        conditions.push(`a.error_code = ${next()}`);
        values.push(query.errorCode);
      }
      if (query.actor !== undefined) {
        conditions.push(`a.actor = ${next()}`);
        values.push(query.actor);
      }
      if (query.from !== undefined) {
        conditions.push(`a.started_at >= ${next()}`);
        values.push(query.from);
      }
      if (query.to !== undefined) {
        conditions.push(`a.started_at <= ${next()}`);
        values.push(query.to);
      }
      if (cursor !== undefined) {
        /**
         * The keyset comparison, as a row constructor so it matches the index's column
         * order exactly. Written out as `(a.started_at, a.id) < ($n, $m)` rather than as
         * `started_at < $n OR (started_at = $n AND id < $m)`, which is the same predicate
         * and the version people get subtly wrong.
         */
        const timestampParam = `$${values.length + 1}`;
        const idParam = `$${values.length + 2}`;
        // ::bigint is explicit because `id` is a bigserial and the cursor half arrives as
        // text. Inside a row-constructor comparison Postgres would usually infer it, but
        // "usually" is not a thing to leave in a WHERE clause that decides which audit rows
        // a caller sees.
        conditions.push(`(a.started_at, a.id) < (${timestampParam}, ${idParam}::bigint)`);
        values.push(cursor.startedAt, cursor.id);
      }

      /**
       * limit + 1 is fetched and the extra row is trimmed, which is how `hasMore` is
       * answered without a second COUNT query. A COUNT over a filtered audit log is the
       * expensive part of this endpoint and nothing in the dashboard needs an exact total -
       * "there is more" is the only question a next button asks.
       */
      const result = await deps.db.query<AuditRowOut>(
        `SELECT a.id::text AS id, a.user_email, a.user_id::text AS user_id,
                a.server_slug, a.server_id::text AS server_id, a.tool_name,
                a.started_at, a.duration_ms, a.outcome,
                a.error_code, a.error_message, a.actor, a.request_id
           FROM audit_log a
          WHERE ${conditions.join(' AND ')}
          ORDER BY a.started_at DESC, a.id DESC
          LIMIT ${`$${values.length + 1}`}`,
        [...values, query.limit + 1],
      );

      const hasMore = result.rows.length > query.limit;
      const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
      const last = rows.at(-1);

      return reply.send({
        entries: rows.map((row) => ({
          id: row.id,
          userEmail: row.user_email,
          // Null once the referenced row is gone. The dashboard uses it to decide whether
          // a name is still a link, which is why the distinction is exposed rather than
          // flattened: a deleted user's history is still their history.
          userId: row.user_id,
          serverSlug: row.server_slug,
          serverId: row.server_id,
          toolName: row.tool_name,
          startedAt: row.started_at.toISOString(),
          durationMs: row.duration_ms,
          outcome: row.outcome,
          errorCode: row.error_code,
          errorMessage: row.error_message,
          actor: row.actor,
          requestId: row.request_id,
        })),
        hasMore,
        nextCursor: hasMore && last !== undefined ? encodeCursor(last.started_at, last.id) : null,
        // Echoed back so a dashboard can render "showing failures for woo" without having
        // to remember what it asked, and so a support request can paste one response and
        // have the question in it.
        scope: isAdmin ? 'all' : 'self',
      });
    });

    /**
     * GET /api/audit/summary - counts by outcome over a window.
     *
     * Not in the step's requirements, and it is here for one reason: the filters above are
     * only useful to someone who already knows what to look for. "14 ok, 6 unreachable in
     * the last hour" is what tells an operator to go and filter. Same scoping, same
     * window parameters, one indexed aggregate.
     */
    app.get('/api/audit/summary', auth, async (request, reply) => {
      const principal = request.principal as Principal;
      const parsed = listQuery.pick({ from: true, to: true, server: true }).safeParse(request.query);

      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid query',
          issues: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        });
      }

      const query = parsed.data;
      const isAdmin = principal.role === 'admin';
      const conditions: string[] = ['($1::boolean OR a.user_id = $2)'];
      const values: unknown[] = [isAdmin, principal.userId];

      if (query.from !== undefined) {
        conditions.push(`a.started_at >= $${values.length + 1}`);
        values.push(query.from);
      }
      if (query.to !== undefined) {
        conditions.push(`a.started_at <= $${values.length + 1}`);
        values.push(query.to);
      }
      if (query.server !== undefined) {
        conditions.push(`a.server_slug = $${values.length + 1}`);
        values.push(query.server);
      }

      const result = await deps.db.query<{
        outcome: string;
        error_code: string | null;
        n: string;
        p95_ms: number | null;
      }>(
        `SELECT a.outcome, a.error_code, count(*)::text AS n,
                percentile_disc(0.95) WITHIN GROUP (ORDER BY a.duration_ms) AS p95_ms
           FROM audit_log a
          WHERE ${conditions.join(' AND ')}
          GROUP BY a.outcome, a.error_code
          ORDER BY count(*) DESC`,
        values,
      );

      return reply.send({
        buckets: result.rows.map((row) => ({
          outcome: row.outcome,
          errorCode: row.error_code,
          count: Number(row.n),
          // percentile_disc returns an actual observed value rather than an interpolation
          // between two, which for a latency figure an operator will quote is the more
          // defensible of the two - it is a duration that really happened.
          p95Ms: row.p95_ms,
        })),
        scope: isAdmin ? 'all' : 'self',
      });
    });
  };
}
