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
}

/** A tool, as the aggregator exposes it. */
export interface AggregatedTool {
  name: string;
  title?: string;
  description?: string;
  serverSlug: string;
  serverName: string;
  upstreamToolName: string;
}

/** An API key. The secret appears exactly once, in the issue response. */
export interface ApiKey {
  id: string;
  keyId: string;
  name: string;
  ownerEmail: string;
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
