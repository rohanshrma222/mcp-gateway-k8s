/**
 * The shapes the gateway's API actually returns.
 *
 * Hand-written rather than generated, and that is a real trade worth naming: generated
 * types cannot drift from the server, while these can. The reason for hand-writing them is
 * that the alternative - an OpenAPI document plus a generator - means maintaining a schema
 * the gateway does not otherwise need, in a project whose API surface is eleven endpoints
 * read by exactly one client. The guard against drift is that every field here appears in
 * a route handler in `services/gateway/src/routes/`, and both move in the same commit.
 *
 * What these deliberately do NOT include is anything the API does not return. There is no
 * `credential` on a server and no `secret` on a key, because those columns are never in a
 * response - 4.5 and 4.4 made that true at the SQL level. A type that described them would
 * be describing a leak that does not exist.
 */

export type Role = 'admin' | 'member';

/** Who is logged in. From `GET /api/auth/me`. */
export interface Session {
  id: string;
  email: string;
  role: Role;
}

/** An upstream MCP server, as the admin API returns it. */
export interface UpstreamServer {
  id: string;
  slug: string;
  name: string;
  url: string;
  authType: 'none' | 'bearer' | 'header';
  /** The header name, when authType is "header". Null otherwise. */
  authHeader: string | null;
  /**
   * Whether a credential is stored - never the credential itself.
   *
   * This boolean is the whole point of the write-only design: the dashboard can show a
   * padlock and an "attached" state without the secret ever leaving the gateway's
   * process. There is no endpoint that could populate a credential field, which is what
   * makes "write-only" a property rather than a promise.
   */
  hasCredential: boolean;
  enabled: boolean;
  status: 'unknown' | 'connected' | 'unreachable' | 'disabled';
  lastError: string | null;
  lastProbedAt: string | null;
  timeoutMs: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * A tool, as the aggregator exposes it.
 *
 * The field is `server`, not `serverSlug` - corrected after reading an actual response
 * rather than the route handler. The first version of this interface invented
 * `serverSlug`/`serverName`/`upstreamToolName` from the shape of the database row, and the
 * Servers page grouped every tool under `undefined` as a result: 21 tools, zero shown. That
 * is the cost of hand-written types, paid on the first screen that used them, and it is why
 * every field below was checked against a live response.
 */
export interface AggregatedTool {
  name: string;
  title?: string;
  description?: string;
  /** The server's slug. */
  server: string;
  /** What the upstream calls this tool, without the prefix. */
  upstreamName: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  lastSeenAt: string;
}

/**
 * The per-server block `GET /api/tools` returns alongside the tools.
 *
 * Worth having typed even though the Servers page derives its counts by grouping: it is the
 * cheaper source for "how many tools does each server advertise", and 7.3's pages may want
 * it without loading every tool.
 */
export interface ToolsByServer {
  slug: string;
  name: string;
  status: string;
  lastError: string | null;
  lastProbedAt: string | null;
  toolCount: number;
}

/**
 * The result of asking the gateway to connect right now.
 *
 * `status`, not `ok`. The first version of this type guessed `{ ok: boolean }`, and the
 * Servers page read `!result.ok` to decide whether to show an error - which was true for
 * every response, because the field does not exist. So a **successful** test would have
 * reported a failure toast. Found by calling the endpoint; it could not have been found by
 * reading the page.
 */
export interface ServerTestResult {
  status: 'connected' | 'unreachable';
  toolCount: number;
  /** The upstream's own tool names, on success. */
  tools?: string[];
  /** A readable sentence, on failure. */
  reason?: string;
  requestId: string;
}

/**
 * A member of the team.
 *
 * `disabled` is a boolean rather than the timestamp the column holds - the API converts it,
 * because the dashboard renders a state and "when exactly was this account disabled" is an
 * audit-log question rather than a list-row one.
 */
export interface Member {
  id: string;
  email: string;
  role: Role;
  createdAt: string;
  disabled: boolean;
}

/**
 * The invite response. `initialPassword` is the only place it will ever appear.
 *
 * Typed as required rather than optional on purpose: if the server ever stopped returning
 * it, a page that renders "copy this password" would show `undefined` and the admin would
 * send somebody an account they cannot sign into. A required field means that becomes a
 * compile error the moment the type is corrected, rather than a confusing support thread.
 */
export interface InvitedMember {
  user: Member;
  initialPassword: string;
}

/** An API key. The secret appears exactly once, in the issue response. */
export interface ApiKey {
  id: string;
  keyId: string;
  name: string;
  /**
   * The owner, present only for an admin.
   *
   * Optional because the API omits it for a non-admin - correctly, since every key in a
   * member's list is theirs and the field would be noise. Declaring it required was a type
   * claiming a field the response does not always carry, which is the same class of mistake
   * as 7.2's three shape bugs. Caught by a test asserting on it and getting undefined.
   */
  ownerEmail?: string;
  /** Mirrors `revokedAt !== null`; the API sends both. */
  revoked: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface IssuedApiKey {
  id: string;
  /** The plaintext, returned once and stored nowhere. See `auth/apiKeys.ts`. */
  key: string;
}

/** One audit row. Matches the SELECT in `routes/audit.ts`. */
export interface AuditEntry {
  id: string;
  userEmail: string | null;
  /** Null once the referenced user is deleted - the row outlives them by design. */
  userId: string | null;
  serverSlug: string | null;
  serverId: string | null;
  toolName: string;
  startedAt: string;
  durationMs: number;
  outcome: 'ok' | 'error' | 'denied' | 'timeout';
  errorCode: string | null;
  errorMessage: string | null;
  actor: 'chat' | 'external';
  requestId: string | null;
}

export interface AuditPage {
  entries: AuditEntry[];
  hasMore: boolean;
  /** Opaque. Passed back verbatim; never parsed here. See decision 2.80. */
  nextCursor: string | null;
  scope: 'all' | 'self';
}

export interface AuditSummaryBucket {
  outcome: string;
  errorCode: string | null;
  count: number;
  p95Ms: number | null;
}
