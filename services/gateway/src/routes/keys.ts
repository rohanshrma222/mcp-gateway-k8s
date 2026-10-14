/**
 * API key management: issue, list, revoke.
 *
 * The ownership rule, applied in SQL rather than in a branch: a member may only see and
 * revoke their own keys; an admin may see and revoke anyone's. It is expressed as a
 * predicate appended to the WHERE clause, so there is no path through these handlers that
 * reads a row the caller is not entitled to and relies on a later check to hide it.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type { Principal } from '../auth/middleware.js';
import { generateKey } from '../auth/apiKeys.js';
import type { Db } from '../db.js';

const issueBody = z.object({
  // A label the owner recognises later: "claude code on my laptop". Required, because an
  // unnamed key in a list of five is a key nobody dares revoke.
  name: z.string().min(1).max(100),
});

const keyIdParam = z.object({
  id: z.string().uuid(),
});

export interface KeyRouteDeps {
  db: Db;
  requireAuth: (request: never, reply: never) => Promise<void>;
}

export function keyRoutes(deps: KeyRouteDeps) {
  return async function register(
    app: FastifyInstance,
    _opts: FastifyPluginOptions,
  ): Promise<void> {
    const auth = { preHandler: deps.requireAuth as never };

    /**
     * POST /api/keys - issue a key.
     *
     * The plaintext is in this response and nowhere else, ever. It is generated here,
     * hashed, the hash is stored, and the plaintext is handed back once. There is no
     * endpoint that can return it again because there is nothing to return it from - which
     * is the property that makes "shown exactly once" true rather than merely intended.
     *
     * Any role may issue a key for themselves. A member needing an API key is the brief's
     * own member story; the constraint on a member is what their key may *do*, which is
     * the per-tool permission layer in stage 9, not whether they may have one.
     */
    app.post('/api/keys', auth, async (request, reply) => {
      const principal = request.principal as Principal;

      const parsed = issueBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a name is required (1-100 characters)' });
      }

      const issued = generateKey();

      await deps.db.query(
        `INSERT INTO api_keys (key_id, user_id, name, secret_sha256)
              VALUES ($1, $2, $3, $4)`,
        [issued.keyId, principal.userId, parsed.data.name, issued.secretSha256],
      );

      // The key id is logged, the plaintext is not. This line is what lets an operator
      // later tie "key 3f2a… was issued" to a moment in time without the audit log
      // having to hold a credential.
      request.log.info(
        { userId: principal.userId, keyId: issued.keyId, name: parsed.data.name },
        'api key issued',
      );

      return reply.code(201).send({
        // Named `key` rather than `token` or `secret`, so the dashboard's copy button and
        // the "you will not see this again" warning sit next to something unambiguous.
        key: issued.plaintext,
        keyId: issued.keyId,
        name: parsed.data.name,
        warning: 'This is the only time this key is shown. Store it now.',
      });
    });

    /**
     * GET /api/keys - list keys.
     *
     * `secret_sha256` is not selected. Not filtered out of the mapping afterwards, not
     * redacted - never read out of the database, so no future edit to this response shape
     * can leak it. Same discipline as `password_hash` in /api/users.
     *
     * A member sees their own; an admin sees everyone's, with the owner's email, because
     * "who holds a key to this gateway" is an administrative question the dashboard has to
     * be able to answer.
     */
    app.get('/api/keys', auth, async (request, reply) => {
      const principal = request.principal as Principal;
      const isAdmin = principal.role === 'admin';

      const result = await deps.db.query<{
        id: string;
        key_id: string;
        name: string;
        owner_email: string;
        created_at: Date;
        last_used_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT k.id, k.key_id, k.name, u.email AS owner_email,
                k.created_at, k.last_used_at, k.revoked_at
           FROM api_keys k
           JOIN users u ON u.id = k.user_id
          WHERE ($2::boolean OR k.user_id = $1)
          ORDER BY k.created_at DESC`,
        [principal.userId, isAdmin],
      );

      return reply.send({
        keys: result.rows.map((row) => ({
          id: row.id,
          // The public half, safe to display. This is what the owner matches against the
          // prefix of the key they pasted into their client.
          keyId: row.key_id,
          name: row.name,
          // Only shown to an admin; for a member every row is their own anyway, so
          // repeating their address on each one is noise.
          ...(isAdmin ? { ownerEmail: row.owner_email } : {}),
          createdAt: row.created_at,
          lastUsedAt: row.last_used_at,
          revoked: row.revoked_at !== null,
          revokedAt: row.revoked_at,
        })),
        requestId: request.id,
      });
    });

    /**
     * DELETE /api/keys/:id - revoke.
     *
     * A timestamp, never a DELETE. The key's id has to stay resolvable for its audit rows
     * to mean anything - deleting the row would leave the history of everything done with
     * that key pointing at nothing. Same reasoning as `users.disabled_at`, and the same
     * reasoning that made the audit log's foreign keys ON DELETE SET NULL.
     *
     * The ownership predicate is in the UPDATE's WHERE clause, so a member attempting
     * another user's key matches zero rows and gets a 404 - identical to a key that does
     * not exist. That is deliberate: a member must not be able to use this endpoint to
     * discover which key ids are real.
     *
     * `revoked_at IS NULL` is also in the WHERE clause, so revoking twice is honest about
     * it rather than silently moving the timestamp - which would rewrite when a key
     * actually stopped working.
     */
    app.delete('/api/keys/:id', auth, async (request, reply) => {
      const principal = request.principal as Principal;

      const parsed = keyIdParam.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'a key id is required' });
      }

      const result = await deps.db.query<{ key_id: string; user_id: string }>(
        `UPDATE api_keys
            SET revoked_at = now()
          WHERE id = $1
            AND revoked_at IS NULL
            AND ($3::boolean OR user_id = $2)
        RETURNING key_id, user_id`,
        [parsed.data.id, principal.userId, principal.role === 'admin'],
      );

      const row = result.rows[0];
      if (row === undefined) {
        return reply.code(404).send({
          error: 'no such active API key',
          requestId: request.id,
        });
      }

      request.log.info(
        { revokedBy: principal.userId, keyId: row.key_id, ownerId: row.user_id },
        'api key revoked',
      );

      return reply.send({ ok: true, keyId: row.key_id, requestId: request.id });
    });
  };
}
