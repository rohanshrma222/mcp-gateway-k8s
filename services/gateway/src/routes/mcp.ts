/**
 * `POST /mcp` - the single endpoint external MCP clients connect to.
 *
 * In this step the **authentication** is complete and real: a Bearer API key is resolved
 * to a principal, revocation and account status are enforced, and the request is logged
 * and attributed. What is NOT here yet is the MCP protocol surface - the client pool,
 * `tools/list` aggregation with prefixed names, and `tools/call` routing - which is stage
 * 5. Until then this endpoint is honest about it rather than pretending.
 *
 * Mounting the guard now, on the real path, is the point. The resolver is a security
 * boundary, and a security boundary with no route using it is one nobody has tested. This
 * way revocation, disabled accounts and malformed keys are all demonstrable today, against
 * the same URL the brief's definition of done requires an external client to use.
 *
 * Deliberately NOT implemented here: an `initialize` reply. Answering the handshake while
 * having no tools and no `tools/call` would let a client connect successfully and then
 * fail confusingly on first use. Refusing the method outright means a client fails at the
 * handshake with a message naming the reason, which is the more useful failure.
 */
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { ApiKeyPrincipal } from '../auth/apiKeys.js';

export interface McpRouteDeps {
  requireApiKey: (request: never, reply: never) => Promise<void>;
}

/** JSON-RPC 2.0 reserved code for an unimplemented method. */
const METHOD_NOT_FOUND = -32601;

export function mcpRoutes(deps: McpRouteDeps) {
  return async function register(
    app: FastifyInstance,
    _opts: FastifyPluginOptions,
  ): Promise<void> {
    app.post('/mcp', { preHandler: deps.requireApiKey as never }, async (request, reply) => {
      const principal = request.apiKeyPrincipal as ApiKeyPrincipal;

      // Attribution is already working: every call through this endpoint is tied to a real
      // user and a specific key, which is what the audit log in 6.1 will write rows from.
      // Proving that now means stage 6 is wiring up a value that already exists rather
      // than inventing one.
      request.log.info(
        { userId: principal.userId, keyId: principal.keyId, method: readMethod(request.body) },
        'authenticated MCP request',
      );

      return reply.code(501).send({
        jsonrpc: '2.0',
        error: {
          code: METHOD_NOT_FOUND,
          message:
            'the gateway MCP endpoint is not serving tools yet: upstream registration is step 4.5 and tool aggregation is stage 5',
          data: {
            // Echoed back so a caller can see that authentication succeeded and the
            // refusal is about capability, not credentials. Without this the 501 is
            // indistinguishable from a misconfiguration of their key.
            authenticated: true,
            user: principal.email,
            keyId: principal.keyId,
          },
        },
        id: readId(request.body),
      });
    });

    // GET and DELETE on /mcp are what a Streamable HTTP client uses to resume a stream or
    // end a session. The gateway's MCP server will be stateless, for the same reason
    // woo-mcp's is - any replica must be able to answer any request, with no sticky
    // sessions and no shared session store - so these stay genuinely unsupported rather
    // than unimplemented. 405 with `Allow` says which it is.
    for (const method of ['get', 'delete'] as const) {
      app[method]('/mcp', { preHandler: deps.requireApiKey as never }, async (_request, reply) =>
        reply.code(405).header('allow', 'POST').send({
          error: 'only POST is supported: this endpoint is a stateless Streamable HTTP server',
        }),
      );
    }
  };
}

/**
 * Reads `method` and `id` from an untrusted body without assuming it is an object.
 *
 * The body is whatever the caller sent - it may be a string, null, or an array. Indexing
 * into it blindly is how a log line becomes a 500, so these narrow first and fall back to
 * a placeholder. `id: null` is the correct JSON-RPC value when the request's id could not
 * be determined.
 */
function readMethod(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'method' in body) {
    const { method } = body as { method: unknown };
    if (typeof method === 'string') return method;
  }
  return '(unknown)';
}

function readId(body: unknown): string | number | null {
  if (typeof body === 'object' && body !== null && 'id' in body) {
    const { id } = body as { id: unknown };
    if (typeof id === 'string' || typeof id === 'number') return id;
  }
  return null;
}
