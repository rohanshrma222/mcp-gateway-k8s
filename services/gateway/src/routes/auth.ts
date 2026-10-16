/**
 * Authentication routes: log in, log out, and "who am I".
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import {
  clearSessionCookie,
  requireRole,
  sessionCookieOptions,
  type Principal,
} from '../auth/middleware.js';
import { getDummyHash, hashPassword, verifyPassword } from '../auth/passwords.js';
import { SESSION_COOKIE, sessionTtlSeconds, signSession, type Role } from '../auth/tokens.js';

const loginBody = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

/** Invite body. The password is generated, never supplied. */
const inviteBody = z.object({
  // Trimmed and lowercased, so "Admin@Urumi.local " and "admin@urumi.local" cannot become
  // two accounts. The unique index is on lower(email), so the database would reject the
  // second anyway - this makes the stored value match what the index compares.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(3)
    .max(320)
    .refine((value) => value.includes('@'), 'must be an email address'),
  role: z.enum(['admin', 'member']).default('member'),
});

const patchUserBody = z.object({
  role: z.enum(['admin', 'member']).optional(),
  disabled: z.boolean().optional(),
});

const userIdParam = z.object({ id: z.string().uuid() });

export interface AuthRouteDeps {
  db: Db;
  /**
   * Added in 7.3 for the invite and role-change routes.
   *
   * Those two are the first writes in this file that an operator would want a record of
   * outside the audit log - the audit table is for TOOL calls, deliberately, so a
   * membership change has no row there. A log line with a request id is what ties "who
   * promoted this person" to a point in time.
   */
  logger: Logger;
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

    /**
     * POST /api/users - invite a member. Admin only.
     *
     * **How a new account gets a password**, which is the decision worth defending here.
     * The gateway has no mail transport, so the three honest options were: a signed invite
     * link the admin copies and sends, a password the admin chooses, or a password the
     * server generates and returns exactly once.
     *
     * This is the third, for the same reason API keys work that way (4.4): a generated
     * secret is 32 bytes of CSPRNG output rather than something a human picked under
     * pressure, and returning it once means there is no endpoint that could ever return it
     * again. An admin-chosen password would be the weakest of the three and is the one most
     * systems ship.
     *
     * What this is NOT is a complete invitation flow. A real deployment wants a
     * single-use, expiring link and a forced password change on first sign-in - there is no
     * `must_change_password` column here, so the generated password stays valid until the
     * member changes it, and nothing forces them to. That is a genuine gap and it is
     * written down rather than implied; closing it is a migration and a flag, not a
     * redesign.
     */
    app.post(
      '/api/users',
      { preHandler: [deps.requireAuth as never, requireRole('admin') as never] },
      async (request, reply) => {
        const parsed = inviteBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'invalid request',
            issues: parsed.error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          });
        }

        const { email, role } = parsed.data;

        /**
         * 24 bytes of base64url - about 190 bits.
         *
         * Deliberately not a memorable passphrase. This value is copied once and pasted
         * into a password manager, so being typeable is worth nothing and being
         * unguessable is worth everything. It is hashed with the same argon2id parameters
         * the login route verifies against, by calling the same function, which is the
         * invariant 4.3 established after the WordPress application-password episode: one
         * implementation of one format.
         */
        const initialPassword = randomBytes(24).toString('base64url');
        const passwordHash = await hashPassword(initialPassword);

        try {
          const result = await deps.db.query<{ id: string; created_at: Date }>(
            `INSERT INTO users (email, password_hash, role)
                  VALUES ($1, $2, $3)
               ON CONFLICT (lower(email)) DO NOTHING
                 RETURNING id, created_at`,
            [email, passwordHash, role],
          );

          /**
           * DO NOTHING plus an empty result means the address is taken.
           *
           * Reported as a 409 with the address, which does disclose that an account
           * exists - and that is the right trade here, unlike on the login route. This
           * endpoint is admin-only, and an admin inviting somebody who already has an
           * account needs to be told that rather than left wondering why no password
           * appeared. Login stays deliberately ambiguous because it is unauthenticated.
           */
          if (result.rows.length === 0) {
            return reply.code(409).send({ error: `an account for ${email} already exists` });
          }

          const row = result.rows[0];
          if (row === undefined) throw new Error('insert returned no row');

          deps.logger.info(
            { invitedBy: (request as { principal?: { userId?: string } }).principal?.userId, email, role },
            'member invited',
          );

          return reply.code(201).send({
            user: { id: row.id, email, role, createdAt: row.created_at, disabled: false },
            /**
             * The plaintext, here and nowhere else, ever.
             *
             * Not logged - the logger's redaction list covers `password`, and the log line
             * above carries the email and role only. Not stored: the column holds an
             * argon2id hash. There is no endpoint that can return this again, which is the
             * property that makes "shown once" true rather than merely intended.
             */
            initialPassword,
            requestId: request.id,
          });
        } catch (error) {
          // 23514 is a CHECK violation - the role CHECK on the users table. Surfaced as a
          // 400 rather than a 500, because it means the request was wrong, not the server.
          if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23514') {
            return reply.code(400).send({ error: 'role must be admin or member' });
          }
          throw error;
        }
      },
    );

    /**
     * PATCH /api/users/:id - change a role, or disable an account. Admin only.
     *
     * Two guards here, and they exist because this endpoint can lock everyone out of the
     * system permanently.
     *
     * **An admin cannot demote or disable themselves.** The immediate effect would be
     * losing their own session's authority mid-request - 4.3 made `requireAuth` re-read
     * the user row every request specifically so a change takes effect at once - so the
     * admin would be signed out of admin by their own click, with no undo path. Refused
     * with an explanation rather than performed.
     *
     * **The last enabled admin cannot be demoted or disabled either.** There is no
     * endpoint that creates an admin without already being one, and the seed Job only runs
     * on a Helm install or upgrade - so removing the final admin means nobody can ever
     * administer this deployment again without direct database access. That is a one-click
     * unrecoverable state, which is precisely the kind of thing an interface should refuse.
     *
     * The count and the update run in ONE statement rather than a read-then-write, because
     * two concurrent requests each demoting a different one of the last two admins would
     * both pass a separate check and leave zero. The `EXISTS` subquery is evaluated
     * against the same snapshot as the update.
     */
    app.patch(
      '/api/users/:id',
      { preHandler: [deps.requireAuth as never, requireRole('admin') as never] },
      async (request, reply) => {
        const idParsed = userIdParam.safeParse(request.params);
        if (!idParsed.success) return reply.code(400).send({ error: 'a user id is required' });

        const parsed = patchUserBody.safeParse(request.body);
        if (!parsed.success) {
          return reply.code(400).send({
            error: 'invalid request',
            issues: parsed.error.issues.map((issue) => ({
              field: issue.path.join('.'),
              message: issue.message,
            })),
          });
        }

        const { id } = idParsed.data;
        const patch = parsed.data;
        if (patch.role === undefined && patch.disabled === undefined) {
          return reply.code(400).send({ error: 'nothing to change: send role, disabled, or both' });
        }

        const principal = (request as { principal?: { userId: string } }).principal;
        const actorId = principal?.userId;

        // Self-protection. Checked before touching the database, because the answer does
        // not depend on any row.
        const removesOwnAdmin = patch.role === 'member' || patch.disabled === true;
        if (actorId === id && removesOwnAdmin) {
          return reply.code(409).send({
            error:
              'you cannot remove your own admin access or disable your own account - ask another admin to do it',
          });
        }

        /**
         * The last-admin guard runs inside a transaction that LOCKS the admin rows, and
         * the reason is a correction worth recording.
         *
         * The first version put the check in the UPDATE's own WHERE clause as an EXISTS
         * subquery, on the reasoning that one statement is one atomic evaluation and
         * therefore safe against a read-then-write race. **That was wrong, and testing it
         * proved so.** Two concurrent demotions - admin A demoting B while B demotes A -
         * each evaluate their EXISTS against their own snapshot, each sees the *other*
         * admin still enabled, both pass, both commit. Measured against the live database:
         * two enabled admins in, **zero** out.
         *
         * Being in one statement makes it atomic with respect to ITSELF. It does nothing
         * about a second statement in a second transaction, which is the case the guard
         * exists for - so the guard was decorative in exactly the scenario it was written
         * to prevent.
         *
         * `FOR UPDATE` on the enabled-admin rows is what actually serialises them: the
         * second transaction blocks until the first commits, then re-reads and sees the
         * truth. It has to be a transaction rather than one clever statement, which is the
         * honest shape of the problem.
         *
         * Note the guard is unreachable through a single HTTP request, and that is not a
         * reason to drop it. The caller must be an enabled admin, so if the target is a
         * *different* person the target cannot be the last admin - which leaves only
         * self-demotion, and the self-protection check above catches that first. The race
         * is the one path that reaches it, and it is the path that matters.
         */
        const client = await deps.db.connect();
        type UserRow = { id: string; email: string; role: Role; created_at: Date; disabled_at: Date | null };
        // undefined means "the write did not run", which is a third state distinct from
        // "ran and matched nothing". Modelling it as undefined rather than a
        // definitely-assigned variable plus a non-null assertion keeps the compiler
        // checking the branch instead of being told to trust it.
        let rows: UserRow[] | undefined;
        let blockedByLastAdmin = false;

        try {
          await client.query('BEGIN');

          if (removesOwnAdmin) {
            /**
             * Lock every currently-enabled admin row, then count.
             *
             * The lock is the whole point - the count is only trustworthy because no
             * concurrent transaction can change these rows until this one ends. Locking
             * the set rather than one row is deliberate: the question is "how many admins
             * are there", so every row that could answer it differently has to be held.
             */
            /**
             * Lock EVERY enabled admin row, ordered by id, and exclude the target
             * afterwards in JavaScript.
             *
             * The ordering is the fix for a deadlock that the first locking version
             * produced, and it is worth writing down because the symptom was a *correct
             * outcome by accident*.
             *
             * That version locked `... AND id <> $1` - the admins other than the target.
             * So with two admins demoting each other: A's transaction locked A's row and
             * then wrote B's, while B's locked B's row and then wrote A's. Each held what
             * the other needed. Postgres detected the cycle and killed one, which left
             * exactly one admin standing - the right answer - but delivered as **HTTP 500
             * "Internal Server Error"** instead of the 409 explaining what happened. A
             * guard that works by deadlock detection is not a guard; it is luck with a
             * stack trace.
             *
             * Locking the whole set in a deterministic order means both transactions ask
             * for the same locks in the same sequence, so the second simply waits. When it
             * resumes it re-reads committed state, finds itself the only admin left, and
             * refuses with the message a human can act on.
             *
             * `ORDER BY id` is doing real work here and is not stylistic: without a
             * deterministic order two transactions can still acquire the same rows in
             * different sequences and deadlock again.
             */
            const locked = await client.query<{ id: string }>(
              `SELECT id FROM users
                 WHERE role = 'admin' AND disabled_at IS NULL
                 ORDER BY id
                 FOR UPDATE`,
            );
            // The target does not count towards "is anyone else left".
            const othersRemaining = locked.rows.filter((row) => row.id !== id).length;
            if (othersRemaining === 0) {
              blockedByLastAdmin = true;
            }
          }

          if (blockedByLastAdmin) {
            await client.query('ROLLBACK');
          } else {
            const updated = await client.query<UserRow>(
              `UPDATE users AS u
                   SET role        = COALESCE($2, u.role),
                       disabled_at = CASE
                                       WHEN $3::boolean IS NULL THEN u.disabled_at
                                       WHEN $3::boolean THEN COALESCE(u.disabled_at, now())
                                       ELSE NULL
                                     END
                 WHERE u.id = $1
             RETURNING u.id, u.email, u.role, u.created_at, u.disabled_at`,
              [id, patch.role ?? null, patch.disabled ?? null],
            );
            await client.query('COMMIT');
            rows = updated.rows;
          }
        } catch (error) {
          // Rolled back on any failure, so a thrown error cannot leave a transaction - and
          // therefore the admin-row locks - open on a pooled connection. Without this the
          // next request to get that connection would inherit an aborted transaction and
          // fail for no visible reason.
          await client.query('ROLLBACK').catch(() => undefined);

          /**
           * 40P01 is a deadlock. The ordered lock above is meant to make this
           * unreachable, and this branch exists because "meant to" is not a guarantee
           * worth handing a user a 500 over - that is exactly what the unordered version
           * did. 409 with an invitation to retry is both true and actionable.
           */
          if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '40P01') {
            deps.logger.warn({ userId: id }, 'deadlock while changing a member - lock ordering may have regressed');
            return reply.code(409).send({
              error: 'another change to the admin list happened at the same moment - please try again',
            });
          }

          throw error;
        } finally {
          // Always released. A leaked client is one fewer connection forever, and
          // `poolMax` is 10 per replica.
          client.release();
        }

        if (blockedByLastAdmin) {
          return reply.code(409).send({
            error:
              'this is the last enabled admin - promote somebody else first, or nobody will be able to administer this deployment',
          });
        }



        /**
         * Now unambiguous: the guard answers its own case above with a 409, so an empty
         * result can only mean the row does not exist.
         *
         * The previous version needed a second query here to tell the two apart. Moving
         * the guard into the transaction removed that - the error each caller gets is
         * decided by the branch that knows why, rather than reconstructed afterwards from
         * the absence of a row.
         */
        if (rows === undefined || rows.length === 0) {
          return reply.code(404).send({ error: 'no such user' });
        }

        const row = rows[0];
        if (row === undefined) throw new Error('update returned no row');

        deps.logger.info(
          { changedBy: actorId, userId: id, role: row.role, disabled: row.disabled_at !== null },
          'member changed',
        );

        return reply.send({
          user: {
            id: row.id,
            email: row.email,
            role: row.role,
            createdAt: row.created_at,
            disabled: row.disabled_at !== null,
          },
          requestId: request.id,
        });
      },
    );
  };
}
