/**
 * Authentication routes: log in, log out, and "who am I".
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import {
  clearSessionCookie,
  requireRole,
  sessionCookieOptions,
  type Principal,
} from '../auth/middleware.js';
import { getDummyHash, verifyPassword } from '../auth/passwords.js';
import { SESSION_COOKIE, sessionTtlSeconds, signSession, type Role } from '../auth/tokens.js';

const loginBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

export interface AuthRouteDeps {
  db: Db;
  jwtSecret: string;
  cookieSecure: boolean;
  requireAuth: (request: never, reply: never) => Promise<void>;
}

export function authRoutes(deps: AuthRouteDeps) {
  return async function register(
    app: FastifyInstance,
    _opts: FastifyPluginOptions,
  ): Promise<void> {
    /**
     * POST /api/auth/login
     *
     * Three things are deliberately identical for every kind of failure - the status code,
     * the message, and the time taken. Any one of them differing turns this endpoint into
     * an oracle that tells an attacker which email addresses have accounts, which is the
     * first step of a credential-stuffing campaign and is worth more than it sounds.
     */
    app.post('/api/auth/login', async (request, reply) => {
      const parsed = loginBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'email and password are required' });
      }

      const { email, password } = parsed.data;

      // lower(email) matches the functional unique index on users, so the lookup uses the
      // index rather than scanning, and the behaviour agrees with the constraint: if the
      // database considers two casings the same account, so must login.
      const result = await deps.db.query<{
        id: string;
        email: string;
        role: Role;
        password_hash: string;
        disabled_at: Date | null;
      }>(
        `SELECT id, email, role, password_hash, disabled_at
           FROM users
          WHERE lower(email) = lower($1)`,
        [email],
      );

      const row = result.rows[0];

      /**
       * No user, or a disabled one: still perform a verification, against a hash of a
       * value nobody knows.
       *
       * Returning early here would make a missing account measurably faster than a wrong
       * password - argon2id costs ~50ms by design - and that difference is readable over
       * the network regardless of how carefully the message is kept the same. So the work
       * happens either way.
       *
       * Disabled accounts take this path too, so "your account is disabled" is never
       * disclosed to an unauthenticated caller. An admin can see it in the dashboard; a
       * stranger cannot distinguish it from a wrong password.
       */
      const hashToCheck = row !== undefined && row.disabled_at === null ? row.password_hash : getDummyHash();
      const ok = await verifyPassword(hashToCheck, password);

      if (!ok || row === undefined || row.disabled_at !== null) {
        // Logged with the attempted address, because repeated failures against one
        // address are worth seeing. The password is never logged - the logger's redaction
        // list covers the field name, and it is not passed here in any case.
        request.log.warn({ email, outcome: 'rejected' }, 'login failed');
        return reply.code(401).send({ error: 'invalid email or password' });
      }

      const token = await signSession(deps.jwtSecret, {
        userId: row.id,
        email: row.email,
        role: row.role,
      });

      const ttl = sessionTtlSeconds();
      void reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions({ secure: deps.cookieSecure }, ttl));

      request.log.info({ userId: row.id, role: row.role }, 'login succeeded');

      // The token is NOT in the body. It is set as an httpOnly cookie and nothing else,
      // because returning it would let dashboard JavaScript read and store it - which
      // throws away the entire point of httpOnly.
      return reply.send({
        user: { id: row.id, email: row.email, role: row.role },
        expiresInSeconds: ttl,
      });
    });

    /**
     * POST /api/auth/logout
     *
     * Clears the cookie, and that is all it can do - which is the honest limitation of a
     * stateless token. A copy of the JWT taken before logout stays cryptographically
     * valid until it expires; there is no server-side list to delete it from. Two things
     * make that acceptable: the eight-hour TTL, and the fact that every authenticated
     * request re-reads the user row, so disabling the account stops the token immediately
     * even though logging out does not.
     *
     * A session table would fix it properly and is the obvious next step if this were
     * handling anything more sensitive. It is recorded as a known gap rather than glossed.
     *
     * POST rather than GET, so it cannot be triggered by an <img> tag or a prefetch.
     */
    app.post('/api/auth/logout', async (request, reply) => {
      clearSessionCookie(reply, deps.cookieSecure);
      return reply.send({ ok: true, requestId: request.id });
    });

    /**
     * GET /api/auth/me
     *
     * The dashboard calls this on load to decide what to render. It returns the role the
     * *database* currently holds, not the role in the cookie, because requireAuth resolves
     * the principal from the row - so a demoted admin sees a member's UI on their next
     * page load rather than after their session expires.
     */
    app.get(
      '/api/auth/me',
      { preHandler: deps.requireAuth as never },
      async (request, reply) => {
        const principal = request.principal as Principal;
        return reply.send({ user: principal });
      },
    );

    /**
     * GET /api/users - admin only.
     *
     * The team list behind the dashboard's Members page. It exists in this step rather
     * than in 4.4 for one reason: `requireRole` is a deliverable of step 4.3, and a role
     * guard with no route using it is an untested guard. Adding the first real consumer
     * here is what makes the authorisation layer demonstrable rather than asserted.
     *
     * Note the guard order in `preHandler`: requireAuth populates request.principal, then
     * requireRole reads it. Reversed, the role check would run against an undefined
     * principal - which fails closed with a 401, but by accident rather than by design,
     * which is why requireRole logs loudly if it ever finds no principal.
     *
     * password_hash is not selected. Not redacted afterwards, not filtered in the mapping
     * - never read out of the database at all, so no later refactor of this response can
     * leak it.
     */
    app.get(
      '/api/users',
      { preHandler: [deps.requireAuth as never, requireRole('admin') as never] },
      async (request, reply) => {
        const result = await deps.db.query<{
          id: string;
          email: string;
          role: Role;
          created_at: Date;
          disabled_at: Date | null;
        }>(
          `SELECT id, email, role, created_at, disabled_at
             FROM users
            ORDER BY created_at`,
        );

        return reply.send({
          users: result.rows.map((row) => ({
            id: row.id,
            email: row.email,
            role: row.role,
            createdAt: row.created_at,
            // A boolean rather than the timestamp, because the dashboard renders a state
            // and the exact moment an account was disabled is an audit-log question.
            disabled: row.disabled_at !== null,
          })),
          requestId: request.id,
        });
      },
    );
  };
}
