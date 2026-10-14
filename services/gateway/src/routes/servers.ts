/**
 * The upstream registry: which MCP servers this gateway fronts.
 *
 * Admin only, every route. The URL of an internal service and the fact that a credential
 * exists are both administrative information, and a member has no story that needs them -
 * members reach tools through `/mcp`, where the registry is an implementation detail.
 *
 * The central rule: **the credential is write-only over the API.** It can be set and
 * replaced, and it is never returned in any shape. Responses carry `hasCredential` as a
 * boolean. That is enforced by never selecting the ciphertext columns in a read path
 * rather than by filtering them out of a response, so no future change to a response shape
 * can leak one.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import { z } from 'zod';
import type { Principal } from '../auth/middleware.js';
import { encryptCredential } from '../crypto/credentials.js';
import { checkUrl, describeRejection } from '../security/ssrf.js';
import { UpstreamUnavailableError, type ClientPool } from '../mcp/pool.js';
import { CredentialError, loadUpstream } from '../mcp/upstreams.js';
import type { Db } from '../db.js';

/**
 * The slug pattern is duplicated from the CHECK constraint in migration 002, deliberately.
 *
 * The database is the last line and must refuse bad data whatever reaches it; the API
 * refuses it first so the caller gets a readable message naming the field instead of a
 * constraint-violation 500. Two layers saying the same thing is not duplication to remove -
 * it is defence in depth with different audiences.
 */
const SLUG = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const authType = z.enum(['none', 'bearer', 'header']);

const createBody = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(SLUG, 'slug must be lowercase letters, digits and hyphens, not starting or ending with a hyphen'),
  url: z.string().url().max(2048),
  authType: authType.default('none'),
  // Only meaningful for authType 'header'; cross-checked below.
  authHeader: z.string().min(1).max(100).optional(),
  credential: z.string().min(1).max(4096).optional(),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
});

const updateBody = z
  .object({
    name: z.string().min(1).max(200).optional(),
    url: z.string().url().max(2048).optional(),
    authType: authType.optional(),
    authHeader: z.string().min(1).max(100).nullable().optional(),
    credential: z.string().min(1).max(4096).optional(),
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(120_000).optional(),
  })
  // An empty PATCH is a caller mistake, not a no-op to absorb silently.
  .refine((body) => Object.keys(body).length > 0, 'at least one field must be given');

// The slug is deliberately absent from updateBody. It is the prefix in every tool name
// this server exposes (`woo__list_products`), so renaming it silently rewrites the tool
// names every client has already discovered and any permission rule written against them.
// Changing it is a delete-and-recreate, which is honest about the consequence.

const idParam = z.object({ id: z.string().uuid() });

/**
 * The three invariants migration 002 enforces, checked here with readable messages.
 *
 * These are genuinely awkward on a PATCH, which is why they are one function: the
 * constraints apply to the row's *resulting* state, not to the fields that happened to be
 * sent. So a PATCH that changes only `authType` can violate a rule about `authHeader`, and
 * the only way to be correct is to compute the whole resulting state first.
 */
interface ResultingState {
  authType: 'none' | 'bearer' | 'header';
  authHeader: string | null;
  hasCredential: boolean;
}

function validateAuthShape(state: ResultingState): string | undefined {
  if (state.authType === 'header' && state.authHeader === null) {
    return 'authHeader is required when authType is "header"';
  }
  if (state.authType !== 'header' && state.authHeader !== null) {
    return 'authHeader is only valid when authType is "header"';
  }
  if (state.authType !== 'none' && !state.hasCredential) {
    return `a credential is required when authType is "${state.authType}"`;
  }
  if (state.authType === 'none' && state.hasCredential) {
    return 'authType "none" cannot carry a credential; remove it or choose bearer/header';
  }
  return undefined;
}

export interface ServerRouteDeps {
  db: Db;
  encryptionKey: string;
  /** Hosts that may be registered at all. Mandatory and default-deny. */
  upstreamAllowlist: string[];
  /** The subset additionally permitted to resolve into private space. */
  upstreamPrivateHosts: string[];
  /** This replica’s MCP client pool. See mcp/pool.ts. */
  pool: ClientPool;
  requireAuth: (request: never, reply: never) => Promise<void>;
  requireAdmin: (request: never, reply: never) => Promise<void>;
}

/** The columns every read path selects. Note the three credential columns are absent. */
const SAFE_COLUMNS = `id, slug, name, url, auth_type, auth_header, enabled, timeout_ms,
                      status, last_error, last_probed_at, created_at, updated_at,
                      (credential_ciphertext IS NOT NULL) AS has_credential`;

interface SafeRow {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: 'none' | 'bearer' | 'header';
  auth_header: string | null;
  enabled: boolean;
  timeout_ms: number;
  status: string;
  last_error: string | null;
  last_probed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  has_credential: boolean;
}

function present(row: SafeRow): Record<string, unknown> {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    authType: row.auth_type,
    authHeader: row.auth_header,
    enabled: row.enabled,
    timeoutMs: row.timeout_ms,
    status: row.status,
    // The human-readable reason the brief asks the dashboard to show. "Unreachable" with
    // no reason is the thing it is asking us not to do.
    lastError: row.last_error,
    lastProbedAt: row.last_probed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // A boolean, never a value. This is the whole write-only property in one field.
    hasCredential: row.has_credential,
  };
}

export function serverRoutes(deps: ServerRouteDeps) {
  return async function register(
    app: FastifyInstance,
    _opts: FastifyPluginOptions,
  ): Promise<void> {
    const admin = {
      preHandler: [deps.requireAuth as never, deps.requireAdmin as never],
    };

    /**
     * POST /api/servers - register an upstream.
     *
     * The id is generated here rather than by the database's DEFAULT, because the
     * credential is encrypted with that id as additional authenticated data - so the id
     * has to exist before the ciphertext does. See crypto/credentials.ts for why that
     * binding is worth the small awkwardness.
     */
    app.post('/api/servers', admin, async (request, reply) => {
      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid upstream definition',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const body = parsed.data;
      const shapeError = validateAuthShape({
        authType: body.authType,
        authHeader: body.authHeader ?? null,
        hasCredential: body.credential !== undefined,
      });
      if (shapeError !== undefined) {
        return reply.code(400).send({ error: shapeError });
      }

      // The SSRF guard. Runs before anything is written, so a rejected URL never reaches
      // the database and never gets a credential encrypted for it.
      const guard = await checkUrl(body.url, {
          allowlist: deps.upstreamAllowlist,
          privateHosts: deps.upstreamPrivateHosts,
        });
      if (!guard.ok) {
        request.log.warn(
          { url: body.url, reason: guard.reason.kind },
          'upstream registration refused by the SSRF guard',
        );
        return reply.code(400).send({
          error: `this URL is not allowed as an upstream: ${describeRejection(guard.reason)}`,
          reason: guard.reason.kind,
        });
      }

      const id = randomUUID();
      const encrypted =
        body.credential === undefined
          ? undefined
          : encryptCredential(deps.encryptionKey, id, body.credential);

      try {
        const result = await deps.db.query<SafeRow>(
          `INSERT INTO mcp_servers
             (id, slug, name, url, auth_type, auth_header, enabled, timeout_ms,
              credential_ciphertext, credential_nonce, credential_tag)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           RETURNING ${SAFE_COLUMNS}`,
          [
            id,
            body.slug,
            body.name,
            body.url,
            body.authType,
            body.authHeader ?? null,
            body.enabled,
            body.timeoutMs,
            encrypted?.ciphertext ?? null,
            encrypted?.nonce ?? null,
            encrypted?.tag ?? null,
          ],
        );

        const row = result.rows[0];
        if (row === undefined) throw new Error('insert returned no row');

        // The slug and id are logged; the credential never is. `credential` is also on the
        // logger's redaction path list, so even an accidental body dump cannot print it.
        request.log.info(
          { serverId: id, slug: body.slug, authType: body.authType, hasCredential: encrypted !== undefined },
          'upstream registered',
        );

        return reply.code(201).send({ server: present(row) });
      } catch (error) {
        // 23505 is unique_violation. Translated rather than left to the generic error
        // handler, because "a server with this slug already exists" is actionable and a
        // 500 is not - and because the slug is the one field a caller chooses freely.
        if (isUniqueViolation(error)) {
          return reply.code(409).send({ error: `an upstream with slug "${body.slug}" already exists` });
        }
        throw error;
      }
    });

    /** GET /api/servers - list. Credential columns are not selected at all. */
    app.get('/api/servers', admin, async (request, reply) => {
      const result = await deps.db.query<SafeRow>(
        `SELECT ${SAFE_COLUMNS} FROM mcp_servers ORDER BY created_at`,
      );
      return reply.send({
        servers: result.rows.map(present),
        requestId: request.id,
      });
    });

    /** GET /api/servers/:id - one upstream. */
    app.get('/api/servers/:id', admin, async (request, reply) => {
      const parsed = idParam.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'a server id is required' });

      const result = await deps.db.query<SafeRow>(
        `SELECT ${SAFE_COLUMNS} FROM mcp_servers WHERE id = $1`,
        [parsed.data.id],
      );
      const row = result.rows[0];
      if (row === undefined) return reply.code(404).send({ error: 'no such upstream' });

      return reply.send({ server: present(row) });
    });

    /**
     * PATCH /api/servers/:id - partial update.
     *
     * Read-then-write, because the auth-shape invariants apply to the row's resulting
     * state rather than to the fields that happened to be sent: a PATCH changing only
     * `authType` can violate a rule about `authHeader`. The read and the write are not in
     * one transaction, and that is a deliberate call - two admins editing the same
     * upstream in the same second is not a scenario worth a transaction here, and the
     * database's own CHECK constraints are the backstop if it ever happened, so the worst
     * case is a rejected write rather than an invalid row.
     *
     * Sending `credential` replaces it. There is no way to *read* it, in this handler or
     * anywhere else.
     */
    app.patch('/api/servers/:id', admin, async (request, reply) => {
      const idParsed = idParam.safeParse(request.params);
      if (!idParsed.success) return reply.code(400).send({ error: 'a server id is required' });

      /**
       * A slug rename is refused explicitly, before the schema runs.
       *
       * zod strips unknown keys, so `{"slug":"renamed"}` would otherwise arrive as `{}`
       * and be rejected as "at least one field must be given" - technically a refusal,
       * but it answers a question nobody asked and leaves the caller thinking the request
       * was malformed rather than that the field is immutable.
       */
      if (typeof request.body === 'object' && request.body !== null && 'slug' in request.body) {
        return reply.code(400).send({
          error:
            'slug cannot be changed: it is the prefix in every tool name this upstream exposes, so renaming it would rewrite the names clients have already discovered and any permission rule written against them. Remove the upstream and register it again.',
        });
      }

      const parsed = updateBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          error: 'invalid update',
          issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
        });
      }

      const id = idParsed.data.id;
      const body = parsed.data;

      const current = await deps.db.query<{
        auth_type: 'none' | 'bearer' | 'header';
        auth_header: string | null;
        has_credential: boolean;
      }>(
        `SELECT auth_type, auth_header, (credential_ciphertext IS NOT NULL) AS has_credential
           FROM mcp_servers WHERE id = $1`,
        [id],
      );
      const existing = current.rows[0];
      if (existing === undefined) return reply.code(404).send({ error: 'no such upstream' });

      const nextAuthType = body.authType ?? existing.auth_type;
      // `authHeader: null` explicitly clears it, while omitting the field leaves it alone -
      // which is why the schema allows null and `?? undefined` is not used here.
      const nextAuthHeader =
        body.authHeader !== undefined ? body.authHeader : existing.auth_header;

      /**
       * Switching to `none` drops the credential, rather than refusing the update.
       *
       * The alternative - demanding the caller clear it separately - makes a two-step
       * dance out of something with one obvious meaning, and leaves an encrypted
       * credential sitting in a row that no longer uses it. Dropping it is also the
       * safer direction: the failure mode is "you have to paste the token again", not
       * "a credential outlived its purpose".
       */
      const clearCredential = nextAuthType === 'none';
      const nextHasCredential = clearCredential
        ? false
        : body.credential !== undefined || existing.has_credential;

      const shapeError = validateAuthShape({
        authType: nextAuthType,
        authHeader: nextAuthHeader,
        hasCredential: nextHasCredential,
      });
      if (shapeError !== undefined) return reply.code(400).send({ error: shapeError });

      // The guard runs on PATCH too, and it has to: an upstream registered with a
      // harmless URL and then edited to point at 169.254.169.254 is the same attack with
      // one extra request. Only when the URL is actually changing, so an unrelated PATCH
      // does not pay a DNS resolution.
      if (body.url !== undefined) {
        const guard = await checkUrl(body.url, {
          allowlist: deps.upstreamAllowlist,
          privateHosts: deps.upstreamPrivateHosts,
        });
        if (!guard.ok) {
          request.log.warn(
            { serverId: id, url: body.url, reason: guard.reason.kind },
            'upstream update refused by the SSRF guard',
          );
          return reply.code(400).send({
            error: `this URL is not allowed as an upstream: ${describeRejection(guard.reason)}`,
            reason: guard.reason.kind,
          });
        }
      }

      const encrypted =
        body.credential !== undefined && !clearCredential
          ? encryptCredential(deps.encryptionKey, id, body.credential)
          : undefined;

      const result = await deps.db.query<SafeRow>(
        `UPDATE mcp_servers
            SET name       = COALESCE($2, name),
                url        = COALESCE($3, url),
                auth_type  = $4,
                auth_header = $5,
                enabled    = COALESCE($6, enabled),
                timeout_ms = COALESCE($7, timeout_ms),
                credential_ciphertext = CASE WHEN $8 THEN NULL WHEN $9::bytea IS NOT NULL THEN $9::bytea  ELSE credential_ciphertext END,
                credential_nonce      = CASE WHEN $8 THEN NULL WHEN $10::bytea IS NOT NULL THEN $10::bytea ELSE credential_nonce END,
                credential_tag        = CASE WHEN $8 THEN NULL WHEN $11::bytea IS NOT NULL THEN $11::bytea ELSE credential_tag END,
                updated_at = now()
          WHERE id = $1
        RETURNING ${SAFE_COLUMNS}`,
        [
          id,
          body.name ?? null,
          body.url ?? null,
          nextAuthType,
          nextAuthHeader,
          body.enabled ?? null,
          body.timeoutMs ?? null,
          clearCredential,
          encrypted?.ciphertext ?? null,
          encrypted?.nonce ?? null,
          encrypted?.tag ?? null,
        ],
      );

      const row = result.rows[0];
      if (row === undefined) return reply.code(404).send({ error: 'no such upstream' });

      request.log.info(
        {
          serverId: id,
          fields: Object.keys(body).filter((k) => k !== 'credential'),
          // Logged as a fact, not a value: "a credential was replaced" is useful in an
          // operations log, the credential itself is not.
          credentialReplaced: encrypted !== undefined,
          credentialCleared: clearCredential && existing.has_credential,
        },
        'upstream updated',
      );

      return reply.send({ server: present(row) });
    });

    /**
     * DELETE /api/servers/:id - a real delete.
     *
     * Unlike users and API keys, which are soft-deleted, an upstream is genuinely removed -
     * the dashboard's "remove server" story means remove. This is safe only because the
     * audit log was built for it: its foreign keys are ON DELETE SET NULL and it stores
     * `server_slug` as text at insert time, so the history of everything done through this
     * upstream survives its removal. That property was verified when the schema was built,
     * which is why this can be a DELETE rather than another `disabled_at`.
     *
     * `mcp_tools` rows cascade, which is correct: a cached tool list for a server that no
     * longer exists is not history, it is stale data.
     */
    app.delete('/api/servers/:id', admin, async (request, reply) => {
      const parsed = idParam.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'a server id is required' });

      const result = await deps.db.query<{ slug: string }>(
        'DELETE FROM mcp_servers WHERE id = $1 RETURNING slug',
        [parsed.data.id],
      );
      const row = result.rows[0];
      if (row === undefined) return reply.code(404).send({ error: 'no such upstream' });

      const principal = request.principal as Principal;
      request.log.warn(
        { serverId: parsed.data.id, slug: row.slug, removedBy: principal.userId },
        'upstream removed',
      );

      return reply.send({ ok: true, slug: row.slug, requestId: request.id });
    });

    /**
     * POST /api/servers/:id/test - connect to this upstream now and report what happened.
     *
     * The admin-facing "test connection" action, and the first caller of the MCP client
     * pool. It exists in this step rather than later for the same reason `requireRole`
     * got a route in 4.3: a component with no caller is a component nobody has tested,
     * and the pool is where credential decryption, SSRF re-validation and reconnect
     * backoff all actually happen.
     *
     * It is NOT the health prober. That is 5.2 and runs on a timer, persisting status to
     * `mcp_servers` for every replica and the dashboard to read. This is the on-demand
     * version an admin wants the moment they paste a URL, and it answers about THIS
     * replica's pool, which is the honest scope - each replica keeps its own connections.
     *
     * The tool names are returned unprefixed, exactly as the upstream reports them.
     * Prefixing and collision handling are 5.3; showing the raw names here is what lets
     * an admin confirm they registered the server they meant to.
     */
    app.post('/api/servers/:id/test', admin, async (request, reply) => {
      const parsed = idParam.safeParse(request.params);
      if (!parsed.success) return reply.code(400).send({ error: 'a server id is required' });

      let loaded;
      try {
        loaded = await loadUpstream(deps.db, deps.encryptionKey, parsed.data.id);
      } catch (error) {
        /**
         * A credential that will not decrypt is a 200 with a failure inside, not a 500.
         *
         * The request succeeded - we looked, and the answer is "this upstream is
         * unusable, here is why". A 500 would say the gateway is broken, which sends an
         * operator to the wrong logs. Same distinction as woo-mcp's isError results.
         */
        if (error instanceof CredentialError) {
          return reply.send({
            status: 'unreachable',
            reason: error.message,
            toolCount: 0,
            requestId: request.id,
          });
        }
        throw error;
      }

      if (loaded === undefined) return reply.code(404).send({ error: 'no such upstream' });

      if (!loaded.enabled) {
        // Reported rather than attempted. Connecting to a disabled upstream would be
        // doing the thing the admin switched off, and "disabled" is a different answer
        // from "unreachable" - one is a decision, the other is a fault.
        return reply.send({
          status: 'disabled',
          reason: 'this upstream is disabled; enable it before testing',
          toolCount: 0,
          requestId: request.id,
        });
      }

      try {
        // pool.use rather than pool.get: the pool owns the failure accounting, so a
        // call that fails on an established connection drops it and starts the backoff.
        // Using get() here was the first version, and it left a dead upstream reporting
        // "connected" forever while every call paid the full timeout.
        const listed = await deps.pool.use(loaded.target, (client) =>
          client.listTools({}, { timeout: loaded.target.timeoutMs }),
        );

        request.log.info(
          { slug: loaded.target.slug, toolCount: listed.tools.length },
          'upstream test succeeded',
        );

        return reply.send({
          status: 'connected',
          toolCount: listed.tools.length,
          tools: listed.tools.map((tool) => tool.name),
          requestId: request.id,
        });
      } catch (error) {
        const reason =
          error instanceof UpstreamUnavailableError
            ? error.reason
            : error instanceof Error
              ? error.message.slice(0, 200)
              : String(error).slice(0, 200);

        // Also a 200: the test ran and its result is "no". The reason is the thing the
        // brief asks the dashboard to display instead of a bare "Unreachable".
        return reply.send({
          status: deps.pool.entry(parsed.data.id).status,
          reason,
          toolCount: 0,
          requestId: request.id,
        });
      }
    });
  };
}

/** Postgres unique_violation. Narrowed rather than cast, since the error is unknown. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === '23505'
  );
}
