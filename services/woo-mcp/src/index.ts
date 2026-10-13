/**
 * Entry point: an HTTP server exposing POST /mcp, GET /healthz and GET /readyz.
 *
 * Plain node:http rather than a framework. Three routes and one body parser do not earn
 * a dependency, and the MCP transport wants the raw IncomingMessage/ServerResponse
 * anyway, so a framework would mostly be something to unwrap.
 */
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { loadConfig } from './config.js';
import { CredentialFile } from './credentials.js';
import { createLogger } from './logger.js';
import { createMcpServer } from './mcp/server.js';
import { WooClient } from './woo/client.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, config.STORE_SLUG);
const credential = new CredentialFile(config.WC_PASSWORD_FILE);

const woo = new WooClient({
  baseUrl: config.WC_BASE_URL,
  storeHost: config.WC_STORE_HOST,
  username: config.WC_USERNAME,
  credential,
  timeoutMs: config.WC_TIMEOUT_MS,
  maxRetries: config.WC_MAX_RETRIES,
  probeTimeoutMs: config.WC_PROBE_TIMEOUT_MS,
  logger,
});

/** 1 MiB. A tools/call body is a few hundred bytes; anything near this is abuse. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Hard ceiling on the diagnostic store probe inside /readyz, independent of the client's
 * own budget.
 *
 * 1500ms against the chart's explicit readiness `timeoutSeconds: 3`. Note that the chart
 * has to set that explicitly: the kubelet's default is **1 second**, which is both easy
 * to miss and too tight for a handler that touches anything at all over the network.
 */
const READYZ_PROBE_CEILING_MS = 1_500;

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

/**
 * One MCP server and transport per request, with no session id generator.
 *
 * This is the stateless Streamable HTTP shape, and it is the single most consequential
 * choice in this service. The alternative - session mode, which the SDK also supports and
 * which most examples show - keeps per-session state in one process's memory. That is
 * fine until there are two replicas, at which point every client needs to land on the
 * same one, which means either sticky sessions at the ingress or a shared session store.
 * Both are infrastructure bought to solve a problem created by the choice.
 *
 * Stateless means any replica can answer any request, so scaling is just a replica count.
 * What it costs: no server-initiated notifications to a specific session. Nothing here
 * needs them.
 *
 * Creating a server per request is cheap because everything expensive - the HTTP client,
 * the cached credential, the connection pool - is shared through the closure above.
 */
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

  const mcp = createMcpServer({ woo, logger: logger.child({ requestId }), storeSlug: config.STORE_SLUG });
  // sessionIdGenerator is OMITTED, not set to undefined. The SDK documents both as
  // stateless, but the option is declared `sessionIdGenerator?: () => string`, and under
  // exactOptionalPropertyTypes passing an explicit undefined to an optional property is
  // an error. Omitting it is the same behaviour and type-correct.
  const transport = new StreamableHTTPServerTransport({});

  // Closed on response end, including when the client disconnects mid-stream. Without
  // this, every request would leak a transport and its listeners - invisible at first and
  // then an out-of-memory restart under any real traffic.
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });

  // Cast at the SDK boundary. StreamableHTTPServerTransport declares
  // `onclose?: (() => void) | undefined` while the Transport interface declares
  // `onclose?: () => void`, and under exactOptionalPropertyTypes those are not the same
  // type - so the SDK's own class does not satisfy the SDK's own interface. Relaxing the
  // compiler flag for this whole service would be the easy fix and would also stop it
  // catching the mistake in my code it was turned on for. One narrow cast is the smaller
  // concession.
  await mcp.connect(transport as unknown as Transport);
  await transport.handleRequest(req, res, body);
}

const server = createServer((req, res) => {
  const requestId = req.headers['x-request-id']?.toString() ?? randomUUID();
  res.setHeader('x-request-id', requestId);

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // Liveness: is this process able to answer at all? Deliberately checks nothing else.
  // A liveness probe that touched WordPress would restart this container whenever the
  // store blipped, which fixes nothing and loses the one process that could have reported
  // the problem.
  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok', service: 'woo-mcp', store: config.STORE_SLUG });
    return;
  }

  // Readiness: can this process serve a tool call? That means configuration parsed and
  // the credential file is readable - nothing more.
  //
  // Note what is NOT here: the store's reachability. It is reported in `store` as
  // information and never affects the status code. If readiness depended on WordPress,
  // woo-mcp would be removed from its Service during a store outage and the gateway would
  // see a connection failure - "Unreachable" with no reason. Staying ready means the
  // gateway gets a precise, human-readable error naming the store instead, which is the
  // whole point of the observability work. A pod that vanishes explains nothing.
  //
  // Not affecting the status code turned out to be only half of it. The first version
  // awaited an *unbounded* probe - a GET, so it carried the full retry budget, ~40s
  // against an unreachable store - and the handler therefore never answered inside the
  // kubelet's timeout. Readiness failed on `context deadline exceeded`, so the pod left
  // its Service during a store outage anyway. The intent was right and the implementation
  // silently inverted it.
  //
  // Two guards now, because this property is load-bearing and one of them is the kind of
  // thing a later refactor can quietly remove:
  //   1. `probe()` runs one attempt on a small `probeTimeoutMs` budget (client.ts).
  //   2. The race below, so readiness answers even if the probe misbehaves regardless.
  // A diagnostic must never be able to outlive the deadline of the thing reporting it.
  if (req.method === 'GET' && url.pathname === '/readyz') {
    void (async () => {
      try {
        await credential.read();
      } catch (error) {
        logger.error({ requestId, err: String(error) }, 'credential unreadable');
        sendJson(res, 503, { status: 'unready', reason: 'credential file unreadable' });
        return;
      }

      const store = await Promise.race([
        woo.probe(),
        new Promise<{ reachable: boolean; detail: string }>((resolve) =>
          setTimeout(
            () => resolve({ reachable: false, detail: 'store probe exceeded its own deadline' }),
            READYZ_PROBE_CEILING_MS,
          ).unref(),
        ),
      ]);

      // 200 either way. The store field is information, not a verdict.
      sendJson(res, 200, { status: 'ok', credential: 'readable', store });
    })();
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
    {
      port: config.PORT,
      store: config.STORE_SLUG,
      baseUrl: config.WC_BASE_URL,
      storeHost: config.WC_STORE_HOST,
      timeoutMs: config.WC_TIMEOUT_MS,
    },
    'woo-mcp listening',
  );
});

// Kubernetes sends SIGTERM and then waits for terminationGracePeriodSeconds before
// SIGKILL. Closing the listener lets in-flight tool calls finish instead of being cut
// off mid-write to the store, which for create_product is the difference between a clean
// failure and a half-created product.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
