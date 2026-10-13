/**
 * Authentication and role guards for the dashboard's REST surface.
 *
 * API-key authentication for `/mcp` is a separate path and arrives in 4.4. They are kept
 * apart deliberately: a browser session and a machine credential have different lifetimes,
 * different revocation stories and different threat models, and one function that accepted
 * either would be one `if` away from letting a session cookie authenticate an MCP call.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { SESSION_COOKIE, verifySession, type Role, type SessionClaims } from './tokens.js';

/** The authenticated subject, resolved from the database rather than from the token. */
export interface Principal {
  userId: string;
  email: string;
  role: Role;
}

// Fastify's request object is extended rather than threading a parameter through every
// handler. Declared here so the type is visible wherever `request.principal` is used.
declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

export interface AuthDeps {
  db: Db;
  jwtSecret: string;
  cookieSecure: boolean;
}

/**
 * Resolves the session cookie to a principal, or replies 401.
 *
 * The important part is the database read, and it is what makes a stateless JWT
 * acceptable here without a session table.
 *
 * A signed token is valid until it expires and there is no server-side list to remove it
 * from - so if authorisation trusted the token's own claims, then disabling an account
 * would do nothing until the token expired (up to eight hours), and a role *demotion*
 * would do nothing either: a user demoted from admin to member would keep admin rights for
 * the life of their current cookie. Both are unacceptable for an access-control system.
 *
 * So the token is used only to identify *who is claiming to be whom*; the role and the
 * account's status are read from `users` on every request. The cost is one indexed primary
 * key lookup, which the request needs anyway for audit attribution. The benefit is that
 * disabling or demoting a user takes effect on their very next request.
 */
export function makeRequireAuth({ db, jwtSecret, cookieSecure }: AuthDeps) {
  return async function requireAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = request.cookies[SESSION_COOKIE];

    if (token === undefined || token.length === 0) {
      await reply.code(401).send({ error: 'authentication required', requestId: request.id });
      return;
    }

    const claims = await verifySession(jwtSecret, token);
    if (claims === undefined) {
      // Clear the cookie on a bad token. Without this a browser holding an expired
      // session re-sends it on every request forever, and the user sees 401s with no way
      // to recover short of clearing site data by hand.
      clearSessionCookie(reply, cookieSecure);
      await reply.code(401).send({ error: 'invalid or expired session', requestId: request.id });
      return;
    }

    const principal = await loadPrincipal(db, claims);
    if (principal === undefined) {
      clearSessionCookie(reply, cookieSecure);
      await reply.code(401).send({ error: 'account is no longer active', requestId: request.id });
      return;
    }

    request.principal = principal;
  };
}

/**
 * Reads the live user row. Returns undefined if the account is gone or disabled.
 *
 * `disabled_at IS NULL` is in the WHERE clause rather than checked afterwards, so a
 * disabled user produces no row at all - there is no intermediate state where the code
 * holds a disabled user's details and relies on a later branch to reject them.
 */
async function loadPrincipal(db: Db, claims: SessionClaims): Promise<Principal | undefined> {
  const result = await db.query<{ id: string; email: string; role: Role }>(
    'SELECT id, email, role FROM users WHERE id = $1 AND disabled_at IS NULL',
    [claims.userId],
  );

  const row = result.rows[0];
  if (row === undefined) return undefined;

  // Note the role comes from `row`, never from the token. See the comment above.
  return { userId: row.id, email: row.email, role: row.role };
}

/**
 * Role guard. Runs after requireAuth in the same hook chain.
 *
 * 403 rather than 404 for an authenticated user who lacks the role. Hiding the existence
 * of admin routes behind a 404 is sometimes argued for, but it is not defence - the routes
 * are in the dashboard bundle anyone can read - and it makes a legitimate permissions
 * problem indistinguishable from a broken link for whoever has to support it.
 */
export function requireRole(...allowed: Role[]) {
  return async function roleGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const principal = request.principal;

    if (principal === undefined) {
      // Only reachable if a route registered requireRole without requireAuth, which is a
      // wiring mistake. Failing closed with a 401 rather than throwing keeps the mistake
      // from presenting as a 500 that someone might "fix" by removing the guard.
      request.log.error('requireRole ran without requireAuth; refusing the request');
      await reply.code(401).send({ error: 'authentication required', requestId: request.id });
      return;
    }

    if (!allowed.includes(principal.role)) {
      // Logged, because a member repeatedly hitting admin routes is worth seeing - it is
      // either a broken UI or someone probing.
      request.log.warn(
        { userId: principal.userId, role: principal.role, required: allowed },
        'role check denied',
      );
      await reply.code(403).send({ error: 'insufficient permissions', requestId: request.id });
      return;
    }
  };
}

export interface CookieOptions {
  secure: boolean;
}

/**
 * Cookie attributes, and each one is doing a job.
 *
 *   httpOnly  JavaScript cannot read it, so an XSS bug in the dashboard cannot exfiltrate
 *             the session. This is the single most valuable attribute here and it is the
 *             reason the token is in a cookie at all rather than in localStorage, which
 *             any injected script can read.
 *   sameSite  'strict': the cookie is not sent on cross-site requests, which is what makes
 *             CSRF structurally impossible rather than something a token has to defend
 *             against. Affordable because the dashboard and the API are the same origin;
 *             'lax' would be needed only for cross-site navigation flows this has none of.
 *   secure    HTTPS only. False locally because the kind cluster serves plain HTTP, true
 *             in production - which is exactly the kind of difference values-prod.yaml
 *             exists to express.
 *   path      '/' so one cookie covers the dashboard and the API.
 */
export function sessionCookieOptions(
  { secure }: CookieOptions,
  maxAgeSeconds: number,
): Record<string, unknown> {
  return {
    httpOnly: true,
    sameSite: 'strict' as const,
    secure,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  // The same attributes it was set with, minus maxAge.
  //
  // A browser matches a cookie for replacement on name, domain and path only, so passing
  // just `path` does clear it - that was the first version here, and it worked. It was
  // still wrong to leave: the emitted header read `SameSite=Lax` where the session cookie
  // is `Strict`, because @fastify/cookie filled in its own defaults for whatever was
  // omitted. Relying on attributes being excluded from the match is relying on a detail
  // that is not ours, and the mismatch is the kind of thing that makes a future
  // "why does logout not work in this browser" very hard to read.
  void reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'strict',
    secure,
    path: '/',
  });
}
