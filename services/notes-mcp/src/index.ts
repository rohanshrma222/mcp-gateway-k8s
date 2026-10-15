/**
 * Entry point: POST /mcp, GET /healthz, GET /readyz.
 *
 * Same shape as woo-mcp - plain node:http, stateless transport per request - and
 * deliberately so: two of our own upstreams behaving identically at the HTTP layer means
 * the gateway's client pool is exercising one contract rather than two, and anything the
 * gateway gets wrong shows up against both rather than looking like a quirk of one.
 *
 * The one real difference is `/readyz`. See below.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createMcpServer } from './mcp/server.js';
import { NotesStore } from './store.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.NOTES_SLUG);
const store = new NotesStore(config.NOTES_DB_PATH, logger);

/** 1 MiB. A tools/call body is a few hundred bytes; anything near this is abuse. */
const MAX_BODY_BYTES = 1_048_576;

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    // Checked while streaming, not after. Buffering first and validating afterwards is
    // how a body-size limit becomes the memory exhaustion it was meant to prevent.
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (total === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    logger.warn({ requestId, err: String(error) }, 'rejected malformed MCP request body');
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'parse error: body must be JSON within 1 MiB' },
      id: null,
    });
    return;
  }

  const mcp = createMcpServer({
    store,
    logger: logger.child({ requestId }),
    instanceSlug: config.NOTES_SLUG,
  });
  // sessionIdGenerator OMITTED, not set to undefined - the same distinction as woo-mcp.
  // Under exactOptionalPropertyTypes, passing an explicit undefined to an optional
  // property is an error; omitting it is the same behaviour and type-correct.
  const transport = new StreamableHTTPServerTransport({});

  // Closed on response end, including a mid-stream client disconnect. Without this every
  // request leaks a transport and its listeners - invisible at first, then an
  // out-of-memory restart under real traffic.
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });

  // Cast at the SDK boundary, for the reason spelled out in woo-mcp's index.ts: the SDK's
  // transport class does not satisfy the SDK's own Transport interface under
  // exactOptionalPropertyTypes. One narrow cast beats relaxing the flag for the service.
  await mcp.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res, body);
}

const server = createServer((req, res) => {
  const requestId = req.headers['x-request-id']?.toString() ?? randomUUID();
  res.setHeader('x-request-id', requestId);

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Liveness: can this process answer at all? Checks nothing else, so a storage problem
  // cannot cause a restart loop that destroys the evidence of it.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok', service: 'notes-mcp', instance: config.NOTES_SLUG });
    return;
  }

  /**
   * Readiness, and here this service differs from woo-mcp on purpose.
   *
   * woo-mcp's `/readyz` deliberately does NOT check WordPress: a dead store must degrade
   * one server's tools, not remove the pod that could have explained why. This one DOES
   * check its database, and returns 503 when it cannot read it.
   *
   * The rule that produces both answers is the one from 4.2: **a dependency belongs in
   * readiness when it is the component's own state.** WordPress is another service that
   * woo-mcp talks to. This SQLite file is not a dependency of notes-mcp, it IS notes-mcp
   * - every tool here is a read or a write of it. A pod that cannot reach it has nothing
   * to serve, so leaving its Service is exactly right.
   *
   * Synchronous, because node:sqlite is a synchronous API. A trivial count against the
   * real file is microseconds, so no timeout ceiling is needed here - the thing woo-mcp
   * needed its 1500ms race for was a network call, and there is no network here.
   */
  if (req.method === 'GET' && url.pathname === '/readyz') {
    try {
      const check = store.check();
      sendJson(res, 200, { status: 'ok', database: 'readable', notes: check.notes });
    } catch (error) {
      logger.error({ requestId, err: String(error) }, 'notes database unreadable');
      sendJson(res, 503, { status: 'unready', reason: 'notes database unreadable' });
    }
    return;
  }

  if (url.pathname === '/mcp') {
    if (req.method !== 'POST') {
      // Stateless mode has no stream to resume and no session to delete, so GET and
      // DELETE are genuinely unsupported rather than unimplemented.
      res.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    void handleMcp(req, res, requestId).catch((error: unknown) => {
      logger.error({ requestId, err: error }, 'unhandled error serving /mcp');
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'internal error' },
          id: null,
        });
      } else {
        res.end();
      }
    });
    return;
  }

  sendJson(res, 404, { error: 'not found', paths: ['/mcp', '/healthz', '/readyz'] });
});

server.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, instance: config.NOTES_SLUG, dbPath: config.NOTES_DB_PATH },
    'notes-mcp listening',
  );
});

/**
 * Kubernetes sends SIGTERM and waits for terminationGracePeriodSeconds before SIGKILL.
 *
 * Closing the listener lets in-flight calls finish, and the database is closed only
 * afterwards - in that order, because closing SQLite while a tool call is mid-write is
 * how a WAL ends up needing recovery on the next start. The 10s backstop covers a
 * connection that never closes.
 */
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
