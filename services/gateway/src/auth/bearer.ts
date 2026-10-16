/**
 * The Bearer resolver: authenticates a machine caller on `/mcp`.
 *
 * This is the door Claude Code and MCP Inspector come through, and the brief's definition
 * of done requires that they connect with **only a URL and an API key** - no browser, no
 * cookie, no OAuth dance. So this path shares nothing with the session middleware beyond
 * the shape of its result.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.js';
import { resolveApiKey, touchKey, type ApiKeyPrincipal, type ResolveFailure } from './apiKeys.js';
import type { RateLimiter } from './rateLimit.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by requireApiKey. Distinct from `principal`, which is the browser session. */
    apiKeyPrincipal?: ApiKeyPrincipal;
  }
}

/**
 * How much each failure tells the caller.
 *
 * These messages are deliberately *more* informative than the login route's, and the
 * reason is the different threat. Login is an unauthenticated endpoint where any detail
 * helps an attacker enumerate accounts. Here the caller already holds something that looks
 * like one of our keys, and the realistic reader is an engineer whose tool stopped working
 * - for whom "unknown or invalid API key" and "this API key has been revoked" are
 * genuinely different problems with different fixes.
 *
 * The line not crossed: a valid key id with a wrong secret reports 'unknown', never
 * "wrong secret", so the response cannot confirm that half of a guessed key was right.
 */
const FAILURE_MESSAGES: Record<ResolveFailure, string> = {
  malformed: 'malformed API key: expected the form urumi_<keyId>_<secret>',
  unknown: 'unknown or invalid API key',
  revoked: 'this API key has been revoked',
  'user-disabled': 'the account this API key belongs to is disabled',
  /**
   * Chat keys are the only keys that expire today, and an expired one means the chat
   * request that minted it died before it could clean up - a rollout, an OOM, an eviction.
   *
   * Worded for the realistic reader. A human will almost never see this: the dashboard
   * mints a chat key, uses it and revokes it within about a second, so the only way to
   * present an expired key is to have captured one. Somebody doing that is either
   * debugging or probing, and either way "it expired, mint a new one" is both true and
   * useless to an attacker.
   */
  expired: 'this API key has expired; ephemeral chat keys are valid only for the request that created them',
};

export interface BearerDeps {
  db: Db;
  /**
   * Absent when rate limiting is turned off (9.2).
   *
   * Optional rather than a limiter with an infinite bucket, so that disabling it costs
   * nothing at runtime - no row, no statement, no table growth. A "limiter" that still
   * writes to Postgres on every call while permitting everything would be the worst of
   * both.
   */
  rateLimiter?: RateLimiter | undefined;
}

export function makeRequireApiKey({ db, rateLimiter }: BearerDeps) {
  return async function requireApiKey(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;

    if (header === undefined) {
      // WWW-Authenticate is not decoration: it is how an MCP client knows the endpoint
      // wants a bearer token rather than being broken. Without it a client sees a bare 401
      // and the user has to guess.
      await reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="urumi-gateway"')
        .send({ error: 'an API key is required', requestId: request.id });
      return;
    }

    // Case-insensitive scheme, because RFC 7235 says the scheme is case-insensitive and
    // clients genuinely differ - `bearer`, `Bearer`, `BEARER` all appear in the wild.
    // Rejecting on case would be a correct-looking bug that only some clients hit.
    const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
    if (match?.[1] === undefined) {
      await reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="urumi-gateway"')
        .send({ error: 'expected an Authorization: Bearer <key> header', requestId: request.id });
      return;
    }

    const result = await resolveApiKey(db, match[1]);

    if (!result.ok) {
      // The key id is logged when we have one, the secret never. The logger's redaction
      // list covers `authorization` by path, so even an accidental `{ req }` dump cannot
      // print the header.
      request.log.warn({ reason: result.reason }, 'API key rejected');
      await reply
        .code(401)
        .header('www-authenticate', 'Bearer realm="urumi-gateway"')
        .send({ error: FAILURE_MESSAGES[result.reason], requestId: request.id });
      return;
    }

    request.apiKeyPrincipal = result.principal;

    /**
     * The rate limit (9.2), AFTER the key has resolved and before anything is done.
     *
     * After, because the bucket is per key and an unauthenticated request has no key to
     * charge - limiting before resolution would mean limiting by IP, and every request
     * here arrives from the ingress controller, so every client would share one bucket.
     * That is a real constraint rather than a preference: inside a cluster the source
     * address is the proxy.
     *
     * It does mean an invalid key costs a database read and is not itself rate limited,
     * which is a named gap. A flood of garbage keys would do resolution work per request;
     * mitigating that needs an IP-level limit at the ingress, which is where it belongs.
     */
    if (rateLimiter !== undefined) {
      const verdict = await rateLimiter.consume(result.principal.apiKeyId);
      const { limit } = rateLimiter.describe();

      /**
       * The headers go on BOTH outcomes, not only the refusal.
       *
       * A client that can see its remaining allowance on every response can pace itself
       * and never be refused; one told only at the moment of refusal can only back off
       * after the fact. These are the de-facto names - not standardised, but what every
       * HTTP client library and every engineer already looks for.
       */
      /**
       * Set on `reply.raw`, NOT via `reply.header()` — a real bug this nearly shipped with.
       *
       * The /mcp route hands the socket to the MCP transport:
       * `transport.handleRequest(request.raw, reply.raw, body)`. That writes the status line
       * and the headers itself, so anything registered on Fastify's `reply` is never flushed
       * on the SUCCESS path. The 429 below was unaffected, because it goes out through
       * `reply.code().send()` — which is exactly why the bug was invisible in the obvious
       * test: the headers appeared precisely when a request was refused and vanished when it
       * was allowed, so they were missing from every response that exists to let a client
       * pace itself and present only on the one where it is already too late.
       *
       * Guarded on `headersSent`, because setting a header after the socket has been written
       * throws — and a preHandler that throws would turn a rate-limit header into a failed
       * request.
       */
      if (!reply.raw.headersSent) {
        reply.raw.setHeader('x-ratelimit-limit', String(limit));
        reply.raw.setHeader('x-ratelimit-remaining', String(verdict.remaining));
      }

      if (!verdict.allowed) {
        request.log.warn(
          {
            keyId: result.principal.keyId,
            userId: result.principal.userId,
            retryAfterSeconds: verdict.retryAfterSeconds,
          },
          'request refused by the per-key rate limit',
        );

        /**
         * 429 with `Retry-After` in seconds.
         *
         * Seconds rather than an HTTP-date, because both are legal and a delta is what a
         * client can act on without a correct clock - and a clock skew would make a date
         * either ignored or waited on far too long.
         *
         * No `WWW-Authenticate` here, unlike the 401s above: the credential is fine and
         * re-authenticating would not help. Sending it would tell a client to do exactly
         * the wrong thing.
         */
        await reply
          .code(429)
          .header('retry-after', String(verdict.retryAfterSeconds))
          .send({
            error: `rate limit exceeded: this API key may make ${limit} requests per minute. Retry in ${verdict.retryAfterSeconds}s.`,
            retryAfterSeconds: verdict.retryAfterSeconds,
            requestId: request.id,
          });
        return;
      }
    }

    /**
     * Fire and forget, with the rejection swallowed into a log line.
     *
     * `last_used_at` is a dashboard convenience; the audit log is the record of what
     * happened. So this must never delay the request and must never fail it - a database
     * hiccup while updating a "last seen" timestamp turning a working tool call into a 500
     * would be absurd. `void` plus an explicit catch, because an unhandled rejection would
     * reach the process-level handler and exit the gateway.
     */
    void touchKey(db, result.principal.apiKeyId).catch((error: unknown) => {
      request.log.debug({ err: error }, 'failed to update api key last_used_at');
    });
  };
}
