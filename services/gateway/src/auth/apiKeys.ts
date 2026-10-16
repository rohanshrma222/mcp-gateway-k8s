/**
 * API keys: the credential a machine presents, as opposed to the cookie a browser carries.
 *
 * Kept entirely separate from the session code in auth/tokens.ts, deliberately. A browser
 * session and a machine credential have different lifetimes, different revocation stories
 * and different threat models, and one resolver that accepted either would be one `if`
 * away from letting a session cookie authenticate an MCP call - or a long-lived API key
 * drive the dashboard's admin routes.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from '../db.js';
import type { Role } from './tokens.js';

/**
 * The key format: `urumi_<keyId>_<secret>`.
 *
 * Three parts, each earning its place:
 *
 *   urumi_   A fixed prefix. This exists for secret scanners - GitGuardian, GitHub's own
 *            push protection - which match on recognisable shapes. A key that looks like
 *            any other random string is one that nobody will notice in a commit. We were
 *            on the receiving end of exactly that kind of alert in this project, and the
 *            lesson was that a distinctive prefix is a feature, not a leak.
 *
 *   keyId    The public half. Safe to log, safe to display, safe to put in an audit row.
 *            It is what the dashboard lists and what revocation targets, so the secret
 *            never has to be handled again after issue.
 *
 *   secret   32 bytes of CSPRNG output. Only its sha256 is stored.
 *
 * Underscore as the separator rather than a dot or a colon, because it survives being
 * double-clicked as one word in a terminal and in a browser, which is how these are
 * actually copied.
 */
const PREFIX = 'urumi';
const KEY_ID_BYTES = 8; // 16 hex characters - enough to be unique, short enough to read
const SECRET_BYTES = 32; // 256 bits; see hashSecret for why this is not argon2id

export interface IssuedKey {
  keyId: string;
  /** The full `urumi_..._...` string. Returned to the caller ONCE and never stored. */
  plaintext: string;
  secretSha256: string;
}

export function generateKey(): IssuedKey {
  const keyId = randomBytes(KEY_ID_BYTES).toString('hex');
  // base64url, not base64: the key travels in an Authorization header and gets pasted into
  // YAML, JSON and shell commands. `+`, `/` and `=` all need escaping somewhere in that
  // list, and a credential that breaks when quoted wrongly produces a support question
  // rather than an error.
  const secret = randomBytes(SECRET_BYTES).toString('base64url');

  return {
    keyId,
    plaintext: `${PREFIX}_${keyId}_${secret}`,
    secretSha256: hashSecret(secret),
  };
}

/**
 * sha256, NOT argon2id - and this is the inverse of the decision in auth/passwords.ts.
 *
 * A password is low-entropy and human-chosen, so the slow, memory-hard hash exists to make
 * each guess expensive. This secret is 32 bytes of CSPRNG output: there is nothing to
 * guess, and brute force is arithmetic rather than a threat model. What a slow hash would
 * buy instead is a ~25ms delay plus 19 MiB of memory on the hot path of **every single
 * tool call**, which is a denial of service inflicted on ourselves and, with enough
 * concurrent calls, an OOM kill.
 *
 * So the hash here is doing one job only: making the stored form useless to someone who
 * reads the table. sha256 does that for a high-entropy input.
 */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export interface ParsedKey {
  keyId: string;
  secret: string;
}

/**
 * Splits a presented key, or returns undefined.
 *
 * `splitKeyParts` uses a bounded split rather than `split('_')`, because the secret is
 * base64url and base64url does not contain underscores - but relying on that is relying on
 * an encoding detail. Taking the first two segments and treating the remainder as the
 * secret means a future encoding change cannot silently truncate a credential.
 */
export function parseKey(presented: string): ParsedKey | undefined {
  const first = presented.indexOf('_');
  if (first < 0) return undefined;
  if (presented.slice(0, first) !== PREFIX) return undefined;

  const second = presented.indexOf('_', first + 1);
  if (second < 0) return undefined;

  const keyId = presented.slice(first + 1, second);
  const secret = presented.slice(second + 1);

  if (keyId.length === 0 || secret.length === 0) return undefined;
  // The key id is generated as hex, so anything else is not one of ours. Checked before it
  // reaches a query, so a malformed id is rejected by shape rather than by a database
  // round trip - which also keeps the lookup's timing uniform for garbage input.
  if (!/^[0-9a-f]+$/.test(keyId)) return undefined;

  return { keyId, secret };
}

/**
 * What kind of key this is, and therefore which actor the audit log records.
 *
 * Read from the database rather than taken from the request, which is the whole point of
 * migration 007: a client cannot mint a key, so it cannot choose its own actor. See that
 * migration for why a header would have been wrong.
 */
export type ApiKeyKind = 'standard' | 'chat';

export interface ApiKeyPrincipal {
  userId: string;
  email: string;
  role: Role;
  apiKeyId: string;
  keyId: string;
  kind: ApiKeyKind;
}

export type ResolveFailure = 'malformed' | 'unknown' | 'revoked' | 'user-disabled';

export type ResolveResult =
  | { ok: true; principal: ApiKeyPrincipal }
  | { ok: false; reason: ResolveFailure };

/**
 * Resolves a presented key to a principal.
 *
 * The lookup is by `key_id` and the secret is then compared as a hash, rather than
 * querying on the hash directly. Both work; this way is chosen because the key id is the
 * thing the rest of the system needs to talk about - it goes in log lines and audit rows -
 * and because it keeps "which key" and "is it valid" as separate questions, so a log can
 * say "key 3f2a… was revoked" without ever having held the secret.
 *
 * Note the single query joining `users`: the key's validity and the owner's status are one
 * question, not two. A revoked key and a key belonging to a disabled user must both fail,
 * and asking separately leaves room for a branch that checks one and forgets the other.
 */
export async function resolveApiKey(db: Db, presented: string): Promise<ResolveResult> {
  const parsed = parseKey(presented);
  if (parsed === undefined) return { ok: false, reason: 'malformed' };

  const result = await db.query<{
    id: string;
    key_id: string;
    secret_sha256: string;
    revoked_at: Date | null;
    user_id: string;
    email: string;
    role: Role;
    kind: string;
    user_disabled_at: Date | null;
  }>(
    `SELECT k.id, k.key_id, k.secret_sha256, k.revoked_at, k.kind,
            u.id AS user_id, u.email, u.role, u.disabled_at AS user_disabled_at
       FROM api_keys k
       JOIN users u ON u.id = k.user_id
      WHERE k.key_id = $1`,
    [parsed.keyId],
  );

  const row = result.rows[0];
  if (row === undefined) return { ok: false, reason: 'unknown' };

  // Constant-time comparison.
  //
  // These are sha256 hex digests of a 256-bit random secret, so a timing oracle here is a
  // weak attack - an attacker would be recovering a hash they cannot invert. It is still
  // the correct primitive, it costs nothing, and the alternative is a `===` that a future
  // reader has to reason about. `timingSafeEqual` THROWS on length mismatch, so the length
  // is checked first rather than letting a malformed row crash the resolver.
  const expected = Buffer.from(row.secret_sha256, 'utf8');
  const actual = Buffer.from(hashSecret(parsed.secret), 'utf8');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    // Reported as 'unknown', not 'wrong-secret'. A caller holding a valid key id and a bad
    // secret learns only that the pair is invalid - the response must not confirm that the
    // id half was real.
    return { ok: false, reason: 'unknown' };
  }

  // Order matters for the message, not for the outcome: both fail. Revocation is checked
  // first because it is the more specific and more actionable fact for the caller.
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.user_disabled_at !== null) return { ok: false, reason: 'user-disabled' };

  return {
    ok: true,
    principal: {
      userId: row.user_id,
      email: row.email,
      // From the row, never from anything the caller sent. Same rule as the session
      // middleware: a demotion or a disable takes effect on the next request.
      role: row.role,
      apiKeyId: row.id,
      keyId: row.key_id,
      /**
       * Defaulted defensively although the column is NOT NULL with a default, because this
       * mapping runs on every single /mcp call and an unexpected value here would make the
       * audit actor wrong rather than loudly broken. 'standard' is the safe reading: it
       * claims less.
       */
      kind: row.kind === 'chat' ? 'chat' : 'standard',
    },
  };
}

/**
 * Records that a key was used, at most once a minute.
 *
 * `last_used_at` is a convenience for the dashboard ("last seen 3 minutes ago"), not an
 * audit record - the audit log is the audit record. Writing it on every call would add a
 * row update to the hot path of every tool call purely for that convenience, and under
 * concurrent calls from one key those updates contend on the same row.
 *
 * So the throttle is in the WHERE clause: one statement, no preceding read, and a
 * concurrent caller that loses the race simply updates nothing. Deliberately fire and
 * forget at the call site - a failure here must never fail the request it is describing.
 */
export async function touchKey(db: Db, apiKeyId: string): Promise<void> {
  await db.query(
    `UPDATE api_keys
        SET last_used_at = now()
      WHERE id = $1
        AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [apiKeyId],
  );
}
