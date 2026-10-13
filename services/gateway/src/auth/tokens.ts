/**
 * Session tokens: a signed JWT carried in an httpOnly cookie.
 *
 * `jose` rather than `jsonwebtoken`, for one specific reason: `jose`'s verify requires the
 * caller to state the acceptable algorithms, so the classic JWT vulnerability - a token
 * arriving with `alg: none`, or an HMAC token verified against what the server thinks is
 * an RSA public key - is not expressible. A library that infers the algorithm from the
 * token being verified is trusting the attacker's own input to decide how to check it.
 *
 * HS256 (symmetric) rather than RS256 (asymmetric). Asymmetric earns its cost when
 * something other than the signer needs to verify - a separate service, a client. Here
 * the gateway is the only issuer and the only verifier, so a second key pair would be
 * machinery with no reader.
 */
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/** Matches `users.role`, which is CHECK-constrained to exactly these two values. */
export type Role = 'admin' | 'member';

export interface SessionClaims {
  userId: string;
  email: string;
  role: Role;
}

const ISSUER = 'urumi-gateway';
const AUDIENCE = 'urumi-dashboard';

/**
 * Eight hours: long enough for a working day without re-login, short enough that a
 * stolen cookie is not a permanent credential.
 *
 * This number matters more than it looks, because of what a stateless JWT cannot do. A
 * signed token is valid until it expires; there is no server-side list to delete it from,
 * so `logout` can only clear the cookie, and a token already copied elsewhere keeps
 * working. The expiry IS the revocation mechanism, which is why it is hours rather than
 * weeks.
 *
 * The important mitigation is in the request path rather than here: every authenticated
 * request re-reads the user from the database and rejects a row that is disabled. So
 * disabling an account takes effect on the next request rather than at token expiry, even
 * though the token itself remains cryptographically valid. See middleware.ts - that
 * database read is the reason this design is acceptable without a session table.
 */
const TTL_SECONDS = 8 * 60 * 60;

export const SESSION_COOKIE = 'urumi_session';

export function sessionTtlSeconds(): number {
  return TTL_SECONDS;
}

export async function signSession(secret: string, claims: SessionClaims): Promise<string> {
  const key = new TextEncoder().encode(secret);

  return new SignJWT({ email: claims.email, role: claims.role })
    .setProtectedHeader({ alg: 'HS256' })
    // The user id goes in `sub`, the registered claim for it, rather than a custom field.
    .setSubject(claims.userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(key);
}

/**
 * Verifies a token and returns its claims, or undefined.
 *
 * Returns undefined for every failure - expired, wrong signature, wrong issuer, malformed
 * - rather than distinguishing them to the caller. The caller's response is identical in
 * every case (401, clear the cookie), and a route that could tell "expired" from "bad
 * signature" would eventually report the difference to someone who should not have it.
 */
export async function verifySession(
  secret: string,
  token: string,
): Promise<SessionClaims | undefined> {
  const key = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, key, {
      // Stated explicitly. This is the line that makes an `alg: none` or
      // algorithm-confusion token unverifiable rather than merely unlikely.
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    return toClaims(payload);
  } catch {
    return undefined;
  }
}

/**
 * Narrows an untrusted payload.
 *
 * A verified signature proves the token was issued by us; it proves nothing about the
 * shape of the claims, because a token signed before a code change can carry anything the
 * old version put there. So the fields are checked rather than cast - the alternative is
 * `role` arriving as undefined and a role check comparing undefined to 'admin', which
 * fails safe today and is one refactor away from not doing.
 */
function toClaims(payload: JWTPayload): SessionClaims | undefined {
  const { sub, email, role } = payload;

  if (typeof sub !== 'string' || sub.length === 0) return undefined;
  if (typeof email !== 'string' || email.length === 0) return undefined;
  if (role !== 'admin' && role !== 'member') return undefined;

  return { userId: sub, email, role };
}
