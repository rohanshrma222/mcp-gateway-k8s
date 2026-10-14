/**
 * Reading upstream rows, including the one place in the codebase that reads a credential.
 *
 * Kept separate from `routes/servers.ts` deliberately. That file's every query omits the
 * three credential columns, so the write-only property of the API is a property of its
 * SQL rather than of its response mapping. This file is the single exception, and keeping
 * it in its own module means the exception is one grep away rather than hidden in a
 * handler - and `routes/servers.ts` cannot accidentally grow a read path that returns one.
 */
import { decryptCredential } from '../crypto/credentials.js';
import type { Db } from '../db.js';

export type AuthType = 'none' | 'bearer' | 'header';

/** An upstream, ready to connect to. The credential is already decrypted. */
export interface UpstreamTarget {
  id: string;
  slug: string;
  name: string;
  url: string;
  timeoutMs: number;
  /**
   * The header to send, already assembled, or undefined for `authType: none`.
   *
   * Assembled here rather than passed as a raw secret plus a type, so the only thing that
   * leaves this module is the finished header - a caller cannot accidentally log "the
   * credential" because it never holds one under that name. The object is deliberately
   * not stored anywhere; the pool puts it straight into the transport's `requestInit`.
   */
  authHeader?: { name: string; value: string };
}

/** Thrown when a row's credential cannot be decrypted. See the note in loadUpstream. */
export class CredentialError extends Error {
  constructor(
    readonly slug: string,
    cause: unknown,
  ) {
    super(
      `the stored credential for upstream "${slug}" could not be decrypted; it was probably encrypted under a different ENCRYPTION_KEY`,
    );
    this.name = 'CredentialError';
    this.cause = cause;
  }
}

interface Row {
  id: string;
  slug: string;
  name: string;
  url: string;
  auth_type: AuthType;
  auth_header: string | null;
  timeout_ms: number;
  credential_ciphertext: Buffer | null;
  credential_nonce: Buffer | null;
  credential_tag: Buffer | null;
}

const COLUMNS = `id, slug, name, url, auth_type, auth_header, timeout_ms,
                 credential_ciphertext, credential_nonce, credential_tag`;

/** Every enabled upstream. Disabled ones are excluded in SQL, not filtered afterwards. */
export async function loadEnabledUpstreams(
  db: Db,
  encryptionKey: string,
): Promise<UpstreamTarget[]> {
  const result = await db.query<Row>(
    `SELECT ${COLUMNS} FROM mcp_servers WHERE enabled = true ORDER BY slug`,
  );
  return result.rows.map((row) => toTarget(row, encryptionKey));
}

/**
 * One upstream by id, enabled or not.
 *
 * `enabled` is deliberately not in the WHERE clause here: the caller is resolving a tool
 * call that already named this server, and "this upstream is disabled" is a different and
 * more useful answer than "no such upstream". The caller checks the flag and says so.
 */
export async function loadUpstream(
  db: Db,
  encryptionKey: string,
  id: string,
): Promise<{ target: UpstreamTarget; enabled: boolean } | undefined> {
  const result = await db.query<Row & { enabled: boolean }>(
    `SELECT ${COLUMNS}, enabled FROM mcp_servers WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return { target: toTarget(row, encryptionKey), enabled: row.enabled };
}

function toTarget(row: Row, encryptionKey: string): UpstreamTarget {
  const base = {
    id: row.id,
    slug: row.slug,
    name: row.name,
    url: row.url,
    timeoutMs: row.timeout_ms,
  };

  if (row.auth_type === 'none') return base;

  // The database's own CHECK constraint guarantees these are present when auth_type is
  // not 'none' (mcp_servers_credential_whole, mcp_servers_auth_needs_credential). The
  // check is repeated rather than asserted because a row written by a future migration,
  // or restored from a partial backup, should produce a named error rather than a
  // TypeError three frames deeper.
  if (
    row.credential_ciphertext === null ||
    row.credential_nonce === null ||
    row.credential_tag === null
  ) {
    throw new CredentialError(row.slug, new Error('credential columns are incomplete'));
  }

  let secret: string;
  try {
    /**
     * The first and only reader of `decryptCredential`.
     *
     * The server id is the additional authenticated data, so a ciphertext that was copied
     * from another row fails here rather than decrypting to someone else's token. See
     * crypto/credentials.ts for why that binding exists.
     *
     * A throw is wrapped in CredentialError rather than propagated, because the realistic
     * causes - an operator rotated ENCRYPTION_KEY, or a partial restore - deserve a
     * message naming the upstream. A raw GCM failure reads as "Unsupported state or
     * unable to authenticate data", which tells an operator nothing about which upstream
     * to look at.
     */
    secret = decryptCredential(encryptionKey, row.id, {
      ciphertext: row.credential_ciphertext,
      nonce: row.credential_nonce,
      tag: row.credential_tag,
    });
  } catch (error) {
    throw new CredentialError(row.slug, error);
  }

  return {
    ...base,
    authHeader:
      row.auth_type === 'bearer'
        ? { name: 'Authorization', value: `Bearer ${secret}` }
        : // auth_type 'header' - the name is guaranteed non-null by
          // mcp_servers_header_name_present, and defaulted here for the same
          // belt-and-braces reason as above.
          { name: row.auth_header ?? 'Authorization', value: secret },
  };
}
