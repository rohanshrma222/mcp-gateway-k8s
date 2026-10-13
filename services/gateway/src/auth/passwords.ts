/**
 * Password hashing: argon2id.
 *
 * Why argon2id rather than bcrypt or a plain SHA: a password is low-entropy and
 * human-chosen, so the only defence against an attacker who has stolen the table is
 * making each guess expensive. argon2id is deliberately expensive in *memory* as well as
 * time, which is what makes it resistant to GPU and ASIC attacks - the thing bcrypt is
 * weakest against, because bcrypt's memory footprint is small enough to fit thousands of
 * parallel instances on one card.
 *
 * The `id` variant specifically: argon2d is faster but leaks timing information through
 * memory access patterns, argon2i resists that but is weaker against time-memory
 * tradeoffs, and argon2id is the hybrid the RFC recommends for password storage.
 *
 * This is NOT the hash used for API keys - see auth/apiKeys.ts in 4.4. An API key secret
 * is 32 bytes of CSPRNG output, so there is nothing to brute-force, and a deliberately
 * slow hash on the hot path of every MCP call would be a self-inflicted denial of
 * service. Different threat, different tool.
 */
import { hash, verify, type Options } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id`, written as its value.
 *
 * The library declares `Algorithm` as an ambient `const enum`, which cannot be referenced
 * under `verbatimModuleSyntax` - a const enum is erased at compile time and has no runtime
 * export to import. The alternatives were relaxing that compiler flag for this service or
 * naming the value here. The flag has already caught three real bugs in this codebase, so
 * it stays, and the constant is spelled out with the mapping recorded: Argon2d = 0,
 * Argon2i = 1, Argon2id = 2.
 *
 * Stated explicitly rather than relying on the library's default, even though its default
 * happens to be Argon2id. A security parameter that is correct by accident of a
 * dependency's default is one minor version away from being wrong silently.
 */
const ARGON2ID = 2;

/**
 * Cost parameters, and the memory figure is the one with a deployment consequence.
 *
 * 19 MiB / 2 passes / 1 lane is the OWASP minimum recommendation for argon2id. The reason
 * it is not higher: this cost is paid per concurrent hash, in the gateway's own memory,
 * and the container limit is 512Mi. Ten simultaneous logins at 64 MiB would be 640 MiB and
 * an OOM kill - which turns a login burst into an outage, and an attacker who knows the
 * parameters can cause it on purpose. So the ceiling here is not "how slow can we
 * tolerate" but "how much memory can N concurrent logins be allowed to claim".
 *
 * That makes login rate limiting (9.2) a load-bearing partner to this setting rather than
 * a nice-to-have, and it is recorded as such in the threat model.
 */
const PARAMS: Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // KiB, so 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Hashes a password. The returned string is self-describing - it carries the algorithm,
 * the parameters and the salt - which is what lets the parameters be raised later without
 * invalidating existing hashes: `verify` reads them from the stored value rather than
 * assuming the current ones. The salt is generated per call by the library; there is no
 * global salt to leak or to get wrong.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, PARAMS);
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing on a malformed hash. A row whose hash cannot be
 * parsed - truncated by a bad migration, written by a different algorithm - must fail
 * closed as "wrong password", not propagate an exception that a caller might mistake for
 * a server fault and handle differently.
 */
export async function verifyPassword(storedHash: string, plaintext: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, PARAMS);
  } catch {
    return false;
  }
}

/**
 * A pre-computed hash of a value nobody knows, used to equalise login timing.
 *
 * The attack this closes: if the login route returns immediately when an email is not
 * found, and spends ~50ms hashing when it is, then response time alone reveals which
 * addresses have accounts. That is a user-enumeration oracle, and it works regardless of
 * how carefully the error *message* is kept identical.
 *
 * So the login route verifies against this when no user matches, paying the same cost as
 * a real failed attempt. Computed once at startup rather than per request, because
 * generating it per request would add a second, different timing signal.
 *
 * It is deliberately unguessable: the point is only that the verification work happens,
 * and no input can ever match it.
 */
let dummyHash: string | undefined;

export async function initDummyHash(): Promise<void> {
  const { randomBytes } = await import('node:crypto');
  dummyHash = await hashPassword(randomBytes(32).toString('hex'));
}

export function getDummyHash(): string {
  if (dummyHash === undefined) {
    // A programming error, not a runtime condition: initDummyHash() is called during
    // startup. Failing loudly beats silently skipping the timing equalisation, which
    // would reintroduce the enumeration oracle with no visible symptom.
    throw new Error('initDummyHash() must be awaited during startup');
  }
  return dummyHash;
}
