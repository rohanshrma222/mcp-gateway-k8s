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
}

export function makeRequireApiKey({ db }: BearerDeps) {
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
