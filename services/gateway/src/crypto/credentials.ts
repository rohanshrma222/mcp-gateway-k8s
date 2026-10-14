/**
 * Upstream credential encryption: AES-256-GCM.
 *
 * This is the only secret in the database that has to come back out in usable form. A
 * password is hashed because nothing ever needs the original; an API key secret is hashed
 * for the same reason. But an upstream's bearer token has to be *sent* to that upstream on
 * every call, so it must be reversible - which makes it the one place in this system where
 * encryption rather than hashing is correct, and the one place where losing the key means
 * losing the data.
 *
 * GCM rather than CBC, and the reason is authentication. CBC gives confidentiality only:
 * an attacker who can write to the database can flip bits in the ciphertext and the
 * decryption still "succeeds", producing different plaintext. GCM is authenticated
 * encryption - a modified ciphertext, nonce or tag fails to decrypt rather than silently
 * yielding attacker-influenced bytes. For a credential that gets put into an Authorization
 * header, that difference matters.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * 96 bits, which is what GCM is specified for and what every implementation optimises
 * around. A longer nonce is hashed down internally, a shorter one is simply weaker, and
 * neither buys anything.
 */
const NONCE_BYTES = 12;

/** 128 bits, the full GCM tag. Truncating it weakens forgery resistance for no gain. */
const TAG_BYTES = 16;

export interface EncryptedCredential {
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

/**
 * Turns the configured hex key into bytes.
 *
 * `ENCRYPTION_KEY` is validated as exactly 64 lowercase hex characters by the config
 * schema, so this cannot receive anything else - but the length is asserted again here
 * because a 31-byte key would make `createCipheriv` throw from inside a request handler
 * rather than at startup, and the error would name a crypto function rather than the
 * configuration that caused it.
 */
function keyBytes(hexKey: string): Buffer {
  const key = Buffer.from(hexKey, 'hex');
  if (key.length !== 32) {
    throw new Error(`ENCRYPTION_KEY must decode to 32 bytes for AES-256, got ${key.length}`);
  }
  return key;
}

/**
 * Encrypts a credential, binding it to one specific server row.
 *
 * `serverId` is used as additional authenticated data (AAD), and this is the part worth
 * explaining because it is easy to leave out and genuinely useful.
 *
 * AAD is not encrypted - it is covered by the authentication tag. So a ciphertext produced
 * for server A cannot be decrypted while claiming to belong to server B: the tag check
 * fails. Without it, someone with write access to the database could copy the three
 * credential columns from a low-value upstream onto a high-value one, or swap two
 * upstreams' credentials, and every decryption would succeed. The AAD makes a credential
 * blob meaningless outside the row it was created for.
 *
 * This is why the server's uuid is generated in application code rather than letting
 * Postgres's DEFAULT gen_random_uuid() produce it: the id has to exist *before* the
 * credential is encrypted.
 *
 * A fresh random nonce per call, never a counter and never reused. Nonce reuse under one
 * key is the catastrophic failure mode for GCM - it leaks the XOR of the two plaintexts
 * and, worse, allows an attacker to recover the authentication subkey and forge tags. 96
 * random bits per encryption, with at most a handful of upstreams, makes a collision
 * negligible; the alternative, a counter, would need durable state that survives restarts
 * and replicas, which is exactly the kind of thing that silently resets.
 */
export function encryptCredential(
  hexKey: string,
  serverId: string,
  plaintext: string,
): EncryptedCredential {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBytes(hexKey), nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(Buffer.from(serverId, 'utf8'));

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return { ciphertext, nonce, tag: cipher.getAuthTag() };
}

/**
 * Decrypts a credential for one specific server.
 *
 * Throws on any tampering - wrong key, modified ciphertext, swapped nonce, or a blob
 * belonging to a different server. The caller must treat a throw as "this upstream's
 * credential is unusable" and surface that as a server-level failure rather than letting
 * it become a 500, because the realistic causes are an operator rotating the encryption
 * key or restoring a partial backup, and both deserve a message naming the upstream.
 */
export function decryptCredential(
  hexKey: string,
  serverId: string,
  encrypted: EncryptedCredential,
): string {
  const decipher = createDecipheriv('aes-256-gcm', keyBytes(hexKey), encrypted.nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(Buffer.from(serverId, 'utf8'));
  // Must be set before final(): final() is what verifies the tag and throws if it does
  // not match. Forgetting this is how people accidentally build unauthenticated GCM.
  decipher.setAuthTag(encrypted.tag);

  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString('utf8');
}
