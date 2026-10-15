/**
 * Tool naming: how one upstream's `list_products` becomes `woo__list_products`.
 *
 * This is the piece that makes aggregation possible at all. Several upstreams expose tools
 * whose names collide - in this project deliberately, because notes-mcp also offers
 * `list_products` so the collision is demonstrable rather than theoretical - and a single
 * `tools/list` has to present them as distinct, individually callable things.
 *
 * Kept in its own module because it is needed in two places that must agree exactly: the
 * prober writes these names into `mcp_tools`, and `tools/call` resolves them back. If those
 * two ever disagreed, a tool would be advertised under a name that cannot be called, which
 * is the worst possible failure here - it looks like the upstream is broken.
 */
import { createHash } from 'node:crypto';

/**
 * Double underscore, not single.
 *
 * Tool names contain single underscores constantly - `list_products`, `update_order_status` -
 * so a single-underscore separator would be ambiguous to split on: is `woo_list_products`
 * server `woo` with tool `list_products`, or server `woo_list` with tool `products`? The
 * slug pattern (`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`, enforced by a CHECK constraint) forbids
 * underscores entirely, which is what makes the FIRST `__` the unambiguous boundary.
 *
 * Not a dot or a colon, because those are not accepted by every LLM provider's function-name
 * validation - see MAX_NAME_LENGTH for the same concern about length.
 */
export const SEPARATOR = '__';

/**
 * 60 characters, and the number comes from the consumers rather than from taste.
 *
 * These names end up as function names in an LLM request. OpenAI's function-calling API
 * limits a name to 64 characters matching `^[a-zA-Z0-9_-]{1,64}$`, and other providers are
 * in the same region. MCP itself does not impose a limit, so a gateway that passed through
 * whatever an upstream published would work until someone registered a server with long
 * tool names and then fail inside the LLM call - a long way from the cause.
 *
 * 60 rather than 64 leaves four characters of headroom for a client that adds its own
 * prefix, which some do.
 */
export const MAX_NAME_LENGTH = 60;

/**
 * Hex characters of digest appended when a name has to be clamped.
 *
 * 12, not 8, and the number came from measurement rather than instinct. 8 hex characters is
 * 32 bits, and the birthday bound says that collides sooner than it feels like it should: a
 * test generating 200,000 long names produced **7 collisions**, which matches n²/2·2³²
 * almost exactly.
 *
 * Realistically this gateway will carry tens of tools, where 32 bits is already fine - the
 * probability at 100 names is about one in a million. But `mcp_tools.prefixed_name` is
 * UNIQUE, so a collision is not a cosmetic clash: the second tool’s row fails to insert and
 * that tool silently stops being advertised. "Unlikely" is a poor answer when the failure
 * mode is a tool quietly disappearing.
 *
 * 12 hex is 48 bits, which takes the same 200,000-name test to roughly one chance in ten
 * thousand, and leaves 47 characters of readable prefix. The prober ALSO handles the unique
 * violation explicitly, because a probability is not a guarantee.
 */
const HASH_LENGTH = 12;

/**
 * Builds the exposed name for one upstream tool.
 *
 * Under the limit, the name is exactly `<slug>__<tool>` - readable, and that readability
 * matters more than it sounds, because a model picks a tool by reading its name and
 * description. `woo__list_products` tells it which store it is touching.
 *
 * Over the limit, the name is truncated and a digest of the FULL name is appended. The
 * digest is of the full name, not of the truncated part, so two long names sharing their
 * first fifty characters still differ - which is the realistic collision, since a verbose
 * naming convention is exactly what produces over-long names.
 *
 * Deterministic: the same input always gives the same output, with no counter and no
 * database lookup. That is what lets the prober and the call path compute it independently
 * and agree, and it is why there is no "allocate a short name" table to keep in sync.
 */
export function buildToolName(slug: string, toolName: string): string {
  const full = `${slug}${SEPARATOR}${toolName}`;
  if (full.length <= MAX_NAME_LENGTH) return full;

  const digest = createHash('sha256').update(full, 'utf8').digest('hex').slice(0, HASH_LENGTH);
  // -1 for the underscore joining the truncated name to the digest.
  const keep = MAX_NAME_LENGTH - HASH_LENGTH - 1;
  return `${full.slice(0, keep)}_${digest}`;
}

/**
 * Splits an exposed name back into its parts, for `tools/call`.
 *
 * Returns undefined when the name has no separator at all - which means the caller invented
 * it, since every name this gateway publishes contains one.
 *
 * **This result is a hint, not an authority**, and that distinction is the important part.
 * For a clamped name the `tool` half is truncated and therefore wrong, so the call path
 * resolves the full name against `mcp_tools` rather than trusting what is parsed here. The
 * parse exists to produce a good error message - naming the server a caller was probably
 * aiming at - and to let an obviously malformed name be rejected before it costs a query.
 */
export function splitToolName(exposed: string): { slug: string; tool: string } | undefined {
  const index = exposed.indexOf(SEPARATOR);
  if (index <= 0) return undefined;

  const slug = exposed.slice(0, index);
  const tool = exposed.slice(index + SEPARATOR.length);
  if (tool.length === 0) return undefined;

  return { slug, tool };
}
