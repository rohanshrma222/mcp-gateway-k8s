/**
 * Projections of WooCommerce objects down to the fields a caller actually needs.
 *
 * This is a deliberate design choice, not laziness about types.
 *
 * A single WooCommerce product response carries well over fifty fields - every date in
 * three formats, every tax and shipping class, image metadata, download rules, related
 * product ids, meta_data arrays, and a `_links` block. An order carries more. Returning
 * them raw has three costs that all land on the consumer:
 *
 *   1. Context. The caller here is usually an LLM with a finite window. Twenty raw
 *      products can run to tens of thousands of tokens of which almost none is relevant,
 *      and that is context the model then cannot spend on the actual task.
 *   2. Leakage. meta_data is free-form and plugins write to it. Forwarding it verbatim
 *      means any plugin's internal bookkeeping - including anything a plugin chose to
 *      stash there - crosses the boundary without anyone deciding it should.
 *   3. Stability. A projection is a contract. Consumers depend on these field names, not
 *      on whatever WooCommerce or a plugin changes next release.
 *
 * So each tool returns a named shape. Anything a caller genuinely needs later is a
 * considered addition rather than something that was already silently flowing.
 */

export interface ProductSummary {
  id: number;
  name: string;
  slug: string;
  status: string;
  price: string;
  regular_price: string;
  stock_status: string;
  purchasable: boolean;
  permalink: string;
  short_description: string;
  sku: string;
}

export interface OrderLineItem {
  id: number;
  name: string;
  product_id: number;
  quantity: number;
  total: string;
}

export interface OrderSummary {
  id: number;
  number: string;
  status: string;
  currency: string;
  total: string;
  payment_method_title: string;
  date_created: string;
  date_modified: string;
  customer_note: string;
  billing_name: string;
  billing_email: string;
  line_items: OrderLineItem[];
}

/** Narrowing helpers. The REST API is untyped JSON, so nothing is assumed. */
function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' ? value : fallback;
}
function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// HTML is stripped rather than forwarded. WooCommerce descriptions are authored in the
// block editor, so they arrive wrapped in markup that is noise to every consumer here and
// would be rendered as literal tags in a chat reply.
function plain(value: unknown): string {
  return str(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function toProductSummary(raw: unknown): ProductSummary {
  const p = (raw ?? {}) as Record<string, unknown>;
  return {
    id: num(p['id']),
    name: str(p['name']),
    slug: str(p['slug']),
    status: str(p['status']),
    price: str(p['price']),
    regular_price: str(p['regular_price']),
    stock_status: str(p['stock_status']),
    purchasable: bool(p['purchasable']),
    permalink: str(p['permalink']),
    short_description: plain(p['short_description']),
    sku: str(p['sku']),
  };
}

export function toOrderSummary(raw: unknown): OrderSummary {
  const o = (raw ?? {}) as Record<string, unknown>;
  const billing = (o['billing'] ?? {}) as Record<string, unknown>;
  const rawItems = Array.isArray(o['line_items']) ? o['line_items'] : [];

  return {
    id: num(o['id']),
    number: str(o['number']),
    status: str(o['status']),
    currency: str(o['currency']),
    total: str(o['total']),
    payment_method_title: str(o['payment_method_title']),
    date_created: str(o['date_created']),
    date_modified: str(o['date_modified']),
    customer_note: plain(o['customer_note']),
    billing_name: `${str(billing['first_name'])} ${str(billing['last_name'])}`.trim(),
    billing_email: str(billing['email']),
    line_items: rawItems.map((item) => {
      const li = (item ?? {}) as Record<string, unknown>;
      return {
        id: num(li['id']),
        name: str(li['name']),
        product_id: num(li['product_id']),
        quantity: num(li['quantity']),
        total: str(li['total']),
      };
    }),
  };
}

/**
 * The statuses WooCommerce accepts for an order.
 *
 * Enumerated rather than accepting a free string so an invalid value is rejected by the
 * tool's own schema, before a request leaves this process. The caller then gets the list
 * of valid options in the error, which a 400 from WooCommerce would not have given them.
 */
export const ORDER_STATUSES = [
  'pending',
  'processing',
  'on-hold',
  'completed',
  'cancelled',
  'refunded',
  'failed',
  'trash',
] as const;

export const PRODUCT_STATUSES = ['draft', 'pending', 'private', 'publish'] as const;
