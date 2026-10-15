/**
 * The audit write path.
 *
 * The brief requires every tool call recorded with user, server, tool, timestamp, duration
 * and outcome, visible in the dashboard. `migrations/003_audit_log.sql` holds the schema
 * reasoning; this module is the only thing in the codebase that writes to that table.
 *
 * Two properties are deliberate and worth stating up front.
 *
 * **The write is in-band, awaited before the caller gets its result.** The tempting
 * alternative is fire-and-forget, to keep the insert off the call's latency - and that is
 * what `touchKey` does for an API key's "last used" timestamp. The difference is what the
 * row is for: a missing `last_used_at` is a cosmetic gap, while a missing audit row means
 * an action happened that the system has no record of. A control that can be silently
 * skipped is not a control.
 *
 * **And it costs no availability**, which is the part that makes the choice easy rather
 * than a trade. Every tool call already requires Postgres before it can do anything: the
 * API key is resolved against it, and the prefixed tool name is resolved against it. A
 * gateway that cannot reach Postgres cannot serve a tool call at all, so making the audit
 * row a hard requirement adds no new failure mode - there is no availability here left to
 * protect.
 */
import type { Pool } from 'pg';
import type { Logger } from './logger.js';
import type { Metrics } from './metrics.js';

/**
 * Machine-readable classification of a failure, for the dashboard's filters in 6.2.
 *
 * A closed set rather than the JSON-RPC number or the message text. The number is wire
 * detail nobody should have to look up, and the message is prose that will be reworded -
 * three times in stage 5 alone - which would silently break any filter built on it. These
 * are the categories an operator actually asks about.
 */
export type AuditErrorCode =
  | 'unknown_tool'
  | 'server_disabled'
  | 'permission_denied'
  | 'upstream_unreachable'
  | 'upstream_timeout'
  | 'credential_error'
  | 'upstream_error'
  | 'server_removed'
  | 'internal_error';

export interface AuditRow {
  userId: string;
  apiKeyId: string;
  /** Written as text as well, so the row survives the user being deleted. */
  userEmail: string;
  serverId?: string;
  serverSlug?: string;
  toolName: string;
  startedAt: Date;
  durationMs: number;
  outcome: 'ok' | 'error' | 'denied' | 'timeout';
  errorCode?: AuditErrorCode;
  errorMessage?: string;
  actor: 'chat' | 'external';
  requestId?: string;
}

/**
 * Appends rows to the audit log.
 *
 * One multi-row INSERT rather than a statement per row. A single `tools/call` produces
 * exactly one row today, so this is not an optimisation - it is so that a future batched
 * caller cannot turn one audit write into N round trips without noticing.
 *
 * `started_at` is passed explicitly rather than left to the column's `DEFAULT now()`,
 * because `now()` is the time of the INSERT and this row is written after the call
 * finishes. A 20-second tool call would otherwise be stamped 20 seconds late, and the one
 * question an audit log must answer precisely is *when*.
 *
 * Returns true on success. Deliberately does not throw: the caller decides what a failed
 * audit write means, and `recordCalls` below explains why that decision is "log loudly and
 * still answer the client".
 */
export async function insertAuditRows(
  db: Pool,
  rows: readonly AuditRow[],
): Promise<void> {
  if (rows.length === 0) return;

  const columns = 13;
  const values: unknown[] = [];
  const tuples: string[] = [];

  for (const [index, row] of rows.entries()) {
    const base = index * columns;
    tuples.push(
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ` +
        `$${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12}, $${base + 13})`,
    );
    values.push(
      row.userId,
      row.apiKeyId,
      row.userEmail,
      row.serverId ?? null,
      row.serverSlug ?? null,
      row.toolName,
      row.startedAt,
      row.durationMs,
      row.outcome,
      row.errorCode ?? null,
      // Trimmed. An upstream's error message is forwarded verbatim by design, and nothing
      // bounds what an upstream might return; a column that can hold a megabyte of someone
      // else's stack trace is a way to fill a disk with one loop.
      row.errorMessage === undefined ? null : row.errorMessage.slice(0, 2000),
      row.actor,
      row.requestId ?? null,
    );
  }

  await db.query(
    `INSERT INTO audit_log
       (user_id, api_key_id, user_email, server_id, server_slug, tool_name,
        started_at, duration_ms, outcome, error_code, error_message, actor, request_id)
     VALUES ${tuples.join(', ')}`,
    values,
  );
}

/**
 * Writes the rows a request produced, and decides what a failure means.
 *
 * The decision: **a failed audit write does not fail the call.** That looks like it
 * contradicts the module comment above, so the reasoning matters.
 *
 * By the time this runs, the upstream call has already happened. If it was
 * `woo__create_product`, a product now exists. Failing the response at that point would
 * tell the client its call failed while the side effect stands - and a client that retries
 * creates a second product. Lying about a completed mutation is worse than an unrecorded
 * one, because the client acts on the lie.
 *
 * So the gap is made **loud instead of silent**: an error-level log carrying the whole row,
 * and a dedicated counter that can be alerted on. An audit log with a known, measured gap
 * is honest; one that quietly drops rows is not. Closing the gap properly needs the write
 * to be transactional with the effect, which is impossible when the effect belongs to
 * someone else's system - so this is a real limit of the design, and it is written down in
 * docs/threat-model.md rather than implied.
 */
export async function recordCalls(
  db: Pool,
  logger: Logger,
  metrics: Metrics,
  rows: readonly AuditRow[],
): Promise<void> {
  if (rows.length === 0) return;

  try {
    await insertAuditRows(db, rows);
  } catch (error) {
    metrics.auditWriteFailures.inc({}, rows.length);
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        rows: rows.map((row) => ({
          userEmail: row.userEmail,
          serverSlug: row.serverSlug,
          toolName: row.toolName,
          outcome: row.outcome,
          durationMs: row.durationMs,
          startedAt: row.startedAt.toISOString(),
        })),
      },
      'AUDIT WRITE FAILED - these tool calls happened and are not recorded',
    );
  }
}
