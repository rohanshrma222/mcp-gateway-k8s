/**
 * The MCP server: five tools over one WooCommerce store.
 *
 * `createMcpServer` builds a *fresh* server per request. That is required by the
 * stateless transport (see index.ts) and is cheap, because all the expensive state - the
 * HTTP client, the cached credential - lives in the dependencies passed in and is shared.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Logger } from '../logger.js';
import type { WooClient } from '../woo/client.js';
import { isWooError } from '../woo/errors.js';
import {
  ORDER_STATUSES,
  PRODUCT_STATUSES,
  toOrderSummary,
  toProductSummary,
} from '../woo/shapes.js';

export interface McpDeps {
  woo: WooClient;
  logger: Logger;
  storeSlug: string;
}

const PRODUCTS = '/wp-json/wc/v3/products';
const ORDERS = '/wp-json/wc/v3/orders';

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

/**
 * Tool failures are returned as results with isError, not thrown as protocol errors.
 *
 * The distinction matters. A JSON-RPC error means "this request was malformed or the
 * server is broken" and clients treat it as a transport-level fault. "The store says
 * that order does not exist" is a perfectly successful round trip with a negative answer
 * - and when the caller is an LLM, it is information it can act on and recover from.
 * Returning it as a result keeps the conversation going; throwing it tends to abort the
 * tool loop.
 */
function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/**
 * One wrapper for every tool body, so failure handling cannot drift between tools.
 *
 * Two kinds of failure are distinguished on purpose. A WooError has already been reduced
 * to a safe, human-readable sentence by errors.ts and is returned as-is. Anything else is
 * a bug in this server, so the detail goes to the log with the request id and the caller
 * gets a flat sentence - because an unexpected exception's message is exactly the thing
 * most likely to contain an internal path or a credential fragment.
 */
async function guard(
  deps: McpDeps,
  tool: string,
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const startedAt = Date.now();
  try {
    const result = await run();
    deps.logger.info({ tool, durationMs: Date.now() - startedAt, outcome: 'ok' }, 'tool call');
    return result;
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (isWooError(error)) {
      deps.logger.warn(
        { tool, durationMs, outcome: 'error', kind: error.kind, status: error.status },
        'tool call failed upstream',
      );
      return fail(error.toToolMessage());
    }
    deps.logger.error({ tool, durationMs, outcome: 'error', err: error }, 'tool call threw');
    return fail(`woo-mcp failed to handle ${tool}; see server logs for the request id`);
  }
}

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer(
    { name: 'woo-mcp', version: '0.1.0' },
    {
      instructions:
        `Tools for the WooCommerce store "${deps.storeSlug}". Products and orders are ` +
        `live production data: creating a product publishes it to the storefront, and ` +
        `changing an order status sends customer email and adjusts stock.`,
    },
  );

  // Descriptions are written for a model that has never seen this store. They say what
  // the tool does, what the units are, and what the caller must not assume - because a
  // tool description is the only documentation an LLM ever gets.

  server.registerTool(
    'list_products',
    {
      title: 'List products',
      description:
        'List products in the store, newest first. Returns a trimmed summary per product ' +
        '(id, name, price, stock status, permalink), not the full WooCommerce object. ' +
        'Use `search` to filter by name or SKU. Prices are strings in the store currency.',
      inputSchema: {
        search: z.string().min(1).max(200).optional().describe('Match against name and SKU'),
        status: z.enum(PRODUCT_STATUSES).optional().describe('Defaults to any status'),
        per_page: z.coerce.number().int().min(1).max(50).default(20)
          .describe('Capped at 50 to keep responses within a model context window'),
        page: z.coerce.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ search, status, per_page, page }) =>
      guard(deps, 'list_products', async () => {
        const raw = await deps.woo.get<unknown[]>(PRODUCTS, {
          search,
          status,
          per_page,
          page,
          orderby: 'date',
          order: 'desc',
        });
        const products = (Array.isArray(raw) ? raw : []).map(toProductSummary);
        return ok({ count: products.length, page, products });
      }),
  );

  server.registerTool(
    'create_product',
    {
      title: 'Create product',
      description:
        'Create a simple product and publish it to the storefront immediately. ' +
        '`regular_price` is a decimal string in the store currency, e.g. "499.00". ' +
        'This writes to live data and is not reversible through these tools; there is no ' +
        'delete_product tool. Returns the created product summary including its permalink.',
      inputSchema: {
        name: z.string().min(1).max(200),
        regular_price: z
          .string()
          .regex(/^\d+(\.\d{1,2})?$/, 'must be a decimal string such as "499" or "499.00"')
          .describe('Decimal string, no currency symbol'),
        description: z.string().max(5000).optional(),
        short_description: z.string().max(1000).optional(),
        sku: z.string().max(100).optional(),
        status: z.enum(PRODUCT_STATUSES).default('publish'),
      },
      // destructiveHint false: it adds rather than replaces. idempotentHint false is the
      // important one - calling it twice creates two products, which a client retrying on
      // a timeout needs to know.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      guard(deps, 'create_product', async () => {
        const created = await deps.woo.post<unknown>(PRODUCTS, {
          type: 'simple',
          name: input.name,
          regular_price: input.regular_price,
          description: input.description ?? '',
          short_description: input.short_description ?? '',
          ...(input.sku ? { sku: input.sku } : {}),
          status: input.status,
          manage_stock: false,
        });
        return ok({ created: toProductSummary(created) });
      }),
  );

  server.registerTool(
    'list_orders',
    {
      title: 'List orders',
      description:
        'List orders, newest first, as trimmed summaries including line items and the ' +
        'billing name and email. `after` and `before` are ISO 8601 timestamps and filter ' +
        'on creation time, so "orders today" means after=<today at 00:00>. Contains ' +
        'customer personal data: do not repeat email addresses unless asked.',
      inputSchema: {
        status: z.enum(ORDER_STATUSES).optional().describe('Defaults to all statuses'),
        after: z.string().datetime({ offset: true }).optional().describe('ISO 8601'),
        before: z.string().datetime({ offset: true }).optional().describe('ISO 8601'),
        per_page: z.coerce.number().int().min(1).max(50).default(20),
        page: z.coerce.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ status, after, before, per_page, page }) =>
      guard(deps, 'list_orders', async () => {
        const raw = await deps.woo.get<unknown[]>(ORDERS, {
          status,
          after,
          before,
          per_page,
          page,
          orderby: 'date',
          order: 'desc',
        });
        const orders = (Array.isArray(raw) ? raw : []).map(toOrderSummary);
        return ok({ count: orders.length, page, orders });
      }),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get order',
      description:
        'Fetch one order by its numeric id, with line items, totals and billing details. ' +
        'Returns an error if no such order exists. Contains customer personal data.',
      inputSchema: {
        id: z.coerce.number().int().positive().describe('Numeric order id, not the order number'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) =>
      guard(deps, 'get_order', async () => {
        const raw = await deps.woo.get<unknown>(`${ORDERS}/${id}`);
        return ok({ order: toOrderSummary(raw) });
      }),
  );

  server.registerTool(
    'update_order_status',
    {
      title: 'Update order status',
      description:
        'Change an order status. This has side effects in the store beyond the status ' +
        'field: WooCommerce sends the customer the email for the new status, and moving ' +
        'to or from cancelled/refunded adjusts stock. Confirm with the user before ' +
        'setting cancelled, refunded or completed.',
      inputSchema: {
        id: z.coerce.number().int().positive(),
        status: z.enum(ORDER_STATUSES).describe('Target status'),
      },
      // destructiveHint true: this is not reversible in any meaningful sense. The status
      // field can be set back, but the email has been sent and the stock has moved.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id, status }) =>
      guard(deps, 'update_order_status', async () => {
        const updated = await deps.woo.put<unknown>(`${ORDERS}/${id}`, { status });
        return ok({ updated: toOrderSummary(updated) });
      }),
  );

  return server;
}
