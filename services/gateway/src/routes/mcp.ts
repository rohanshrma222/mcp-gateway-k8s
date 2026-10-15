/**
 * `POST /mcp` - the single endpoint external MCP clients connect to.
 *
 * The brief's definition of done is that Claude Code and MCP Inspector connect with **only
 * a URL and an API key**: no browser, no cookie, no OAuth dance. That is why this route
 * shares nothing with the dashboard's session middleware beyond the shape of its result.
 *
 * Stateless Streamable HTTP, exactly as woo-mcp is, and for the same reason: a fresh
 * `Server` and transport per request with no session id, so any replica can answer any
 * request. No sticky sessions at the ingress, no shared session store, and the replica
 * count is a number in a values file. The expensive things - the database pool, the
 * upstream connections, the metrics registry - live in the enclosing closure, so
 * per-request construction is cheap.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { FastifyInstance, FastifyPluginOptions } from 'fastify';
import type { ApiKeyPrincipal } from '../auth/apiKeys.js';
import type { Db } from '../db.js';
import type { Logger } from '../logger.js';
import type { Metrics } from '../metrics.js';
import { buildGatewayServer } from '../mcp/server.js';
import type { ClientPool } from '../mcp/pool.js';

export interface McpRouteDeps {
  db: Db;
  logger: Logger;
  metrics: Metrics;
  pool: ClientPool;
  encryptionKey: string;
  requireApiKey: (request: never, reply: never) => Promise<void>;
}

export function mcpRoutes(deps: McpRouteDeps) {
  return async function register(
    app: FastifyInstance,
    _opts: FastifyPluginOptions,
  ): Promise<void> {
    /**
     * Content type negotiation is handled by Fastify's parser, which is why this route
     * needs no body-size handling of its own: the app-level `bodyLimit` of 1 MiB already
     * applies, and a `tools/call` body is a few hundred bytes.
     */
    app.post('/mcp', { preHandler: deps.requireApiKey as never }, async (request, reply) => {
      const principal = request.apiKeyPrincipal as ApiKeyPrincipal;

      const { server, records } = buildGatewayServer({
        db: deps.db,
        logger: deps.logger,
        metrics: deps.metrics,
        pool: deps.pool,
        encryptionKey: deps.encryptionKey,
        principal,
        requestId: String(request.id),
      });

      // sessionIdGenerator is OMITTED rather than set to undefined - the same distinction
      // as in woo-mcp. The SDK documents both as stateless, but the option is declared
      // `sessionIdGenerator?: () => string`, and under exactOptionalPropertyTypes passing
      // an explicit undefined to an optional property is an error. Omitting it is the same
      // behaviour and type-clean.
      const transport = new StreamableHTTPServerTransport({});

      /**
       * Closed when the response ends, including when a client disconnects mid-stream.
       *
       * Without this every request leaks a transport and its listeners - invisible at
       * first, then an out-of-memory restart under real traffic. The audit rows that 6.1
       * will write are collected in `records` by then, so closing here loses nothing.
       */
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();

        // Logged at debug so a call that produced no record - a malformed envelope, a
        // method we do not implement - is still visible when looking for one.
        if (records.length === 0) {
          deps.logger.debug(
            { requestId: request.id, userId: principal.userId },
            'mcp request produced no tool-call records',
          );
        }
      });

      // Cast at the SDK boundary. `StreamableHTTPServerTransport` declares
      // `onclose?: (() => void) | undefined` while the `Transport` interface declares
      // `onclose?: () => void`, so under exactOptionalPropertyTypes the SDK's own class
      // does not satisfy the SDK's own interface. Relaxing the flag for this service would
      // be the easy fix and would also stop it catching the mistakes it has caught here.
      await server.connect(transport as unknown as Transport);

      // Fastify has already parsed the body; handing it over avoids the transport trying
      // to read a stream that is finished, which would hang until the request timeout.
      await transport.handleRequest(request.raw, reply.raw, request.body);

      // Tells Fastify the response is being written directly to the raw socket, so it does
      // not try to send its own. Without it Fastify waits for a return value and the
      // request eventually times out despite the transport having answered.
      return reply;
    });

    /**
     * GET and DELETE are what a Streamable HTTP client uses to resume a stream or end a
     * session. This server is stateless - any replica answers any request - so there is no
     * stream to resume and no session to delete. They are genuinely unsupported rather
     * than unimplemented, and 405 with `Allow` says which.
     */
    for (const method of ['get', 'delete'] as const) {
      app[method]('/mcp', { preHandler: deps.requireApiKey as never }, async (_request, reply) =>
        reply.code(405).header('allow', 'POST').send({
          error: 'only POST is supported: this endpoint is a stateless Streamable HTTP server',
        }),
      );
    }
  };
}
