/**
 * The key the chat agent holds while it works, and gives back when it is done.
 *
 * **Why the agent needs a key at all**, when it is running inside the very process that
 * would validate it: because the alternative is a second way into the tool-calling path,
 * and a second way in is a second place for the permission check, the rate limit and the
 * audit write to be missed. The brief asks that the chat agent act "as the logged-in user",
 * and the strongest possible form of that claim is that the agent is indistinguishable from
 * an external MCP client - it holds a Bearer key, it speaks Streamable HTTP to `/mcp`, and
 * the server authorises it by looking the key up. Stage 9's per-tool permissions will then
 * apply to chat for free, because there is nothing to apply them to separately.
 *
 * **Why a NEW key rather than the user's own**: not a design preference. The gateway cannot
 * read the user's key. 4.4 stores `sha256(secret)` and nothing else, precisely so that a
 * database dump yields no usable credential, and that decision makes reuse impossible
 * rather than merely unwise. Minting is the only option available, which is a pleasant case
 * of an earlier security choice removing a later temptation.
 *
 * **Why it is revoked rather than left to expire**: a TTL column and a sweeper are 8.4's
 * work. Within one request the agent's lifetime is known exactly - it ends when the
 * response ends - so the key is revoked in a `finally`, which is both tighter than any TTL
 * and the behaviour a TTL would be a fallback for. The gap this leaves is honest and named
 * below: a process killed mid-chat leaves a live key behind, and that is what 8.4 fixes.
 */
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { generateKey } from '../auth/apiKeys.js';

export interface EphemeralKey {
  /** The full `urumi_<keyId>_<secret>` string. Held in memory only. */
  presented: string;
  /** The public half, for log lines. The secret never appears in a log. */
  keyId: string;
  /** The row id, used to revoke it. */
  apiKeyId: string;
}

/**
 * Mint a `kind = 'chat'` key for one chat request.
 */
export async function mintChatKey(
  db: Db,
  userId: string,
  logger: Logger,
): Promise<EphemeralKey> {
  const issued = generateKey();

  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_keys (key_id, user_id, name, secret_sha256, kind)
     VALUES ($1, $2, $3, $4, 'chat')
     RETURNING id`,
    [
      issued.keyId,
      userId,
      /**
       * The name is for a human reading the keys table, and says what it is and that it
       * should not be there for long. It is not load-bearing: `kind` is what the audit
       * actor is derived from, for exactly the reason migration 007 explains - `name` is
       * user-supplied free text everywhere else, so a convention on it would be forgeable.
       */
      'chat session (ephemeral)',
      /**
       * `generateKey` already returns the hash, so nothing here ever holds a hashable
       * secret separately from the plaintext it is about to hand to the agent. Using the
       * value it computed rather than re-hashing also means the chat path cannot drift from
       * the dashboard path on how a key is stored - there is one implementation.
       */
      issued.secretSha256,
    ],
  );

  const row = rows[0];
  if (row === undefined) {
    // An INSERT ... RETURNING that returns nothing cannot happen without an error being
    // thrown first, so this is a type-level guard rather than a real branch - but it is a
    // guard rather than a non-null assertion, by the same reasoning as 7.3's.
    throw new Error('minting a chat key returned no row');
  }

  logger.debug({ userId, keyId: issued.keyId }, 'minted an ephemeral chat key');

  return { presented: issued.plaintext, keyId: issued.keyId, apiKeyId: row.id };
}

/**
 * Revoke it.
 *
 * Never throws. A failed revocation must not turn a completed chat into an error response -
 * the user got their answer, and reporting a failure after the fact would be a lie about
 * the conversation. It is the same judgement as 6.1's audit write, and it gets the same
 * treatment: swallow the failure for the caller, make it loud in the logs, and leave a
 * record that something needs cleaning up. 8.4's sweeper is what actually recovers from it.
 */
export async function revokeChatKey(
  db: Db,
  key: EphemeralKey,
  logger: Logger,
): Promise<void> {
  try {
    const { rowCount } = await db.query(
      // `revoked_at IS NULL` so a second call is a no-op rather than moving the timestamp.
      // The route revokes in a `finally`, and a `finally` can run twice if the surrounding
      // code is ever restructured; idempotence is cheaper than remembering that.
      `UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [key.apiKeyId],
    );

    if (rowCount === 0) {
      logger.warn(
        { keyId: key.keyId },
        'ephemeral chat key was already revoked or missing when the chat ended',
      );
      return;
    }

    logger.debug({ keyId: key.keyId }, 'revoked the ephemeral chat key');
  } catch (caught) {
    /**
     * Logged at `error` with the key id, because this is the one failure here that leaves
     * a live credential in the database. The key id is the public half, so this line is
     * safe to ship to a log aggregator and is also exactly what somebody would need to go
     * and revoke it by hand.
     */
    logger.error(
      { err: caught, keyId: key.keyId, apiKeyId: key.apiKeyId },
      'FAILED to revoke an ephemeral chat key - it remains valid until swept',
    );
  }
}
