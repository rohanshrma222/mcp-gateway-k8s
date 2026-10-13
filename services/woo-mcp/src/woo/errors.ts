/**
 * Typed WooCommerce errors.
 *
 * The point of this file is that nothing downstream ever sees a raw WooCommerce response.
 * WordPress answers with HTML when it is unhappy in the wrong way - a PHP fatal, a
 * redirect to a login page, a maintenance notice - and an MCP tool that forwards that
 * verbatim hands an LLM a page of markup to reason about, which is both useless and a
 * plausible way to leak something that was never meant to leave the server.
 *
 * So every failure becomes one of these, each carrying a short sentence a human can act
 * on and nothing more.
 */

export type WooErrorKind =
  | 'auth'
  | 'not_found'
  | 'validation'
  | 'rate_limited'
  | 'upstream'
  | 'timeout'
  | 'protocol';

export class WooError extends Error {
  constructor(
    readonly kind: WooErrorKind,
    message: string,
    readonly status?: number,
    readonly wooCode?: string,
    /** True only for failures where the same request can safely be sent again. */
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'WooError';
  }

  /** A single line, safe to show a user or hand to a model. */
  toToolMessage(): string {
    const where = this.status ? ` (HTTP ${this.status})` : '';
    const code = this.wooCode ? ` [${this.wooCode}]` : '';
    return `WooCommerce ${this.kind} error${where}${code}: ${this.message}`;
  }
}

/** The JSON error envelope the WordPress REST API uses. */
interface WooErrorBody {
  code?: unknown;
  message?: unknown;
  data?: { status?: unknown } | undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Turns a non-2xx response into a WooError.
 *
 * `bodyText` is passed rather than a parsed object because the interesting case is
 * exactly when the body is *not* JSON. It is never included in the message in full:
 * only a short, stripped excerpt, because an HTML error page can contain a file path, a
 * stack frame or a database name.
 */
export function wooErrorFromResponse(status: number, bodyText: string): WooError {
  let parsed: WooErrorBody | undefined;
  try {
    const candidate: unknown = JSON.parse(bodyText);
    if (candidate && typeof candidate === 'object') {
      parsed = candidate as WooErrorBody;
    }
  } catch {
    parsed = undefined;
  }

  if (!parsed) {
    // Not JSON at all. Almost always an HTML page: a PHP error, a login redirect or a
    // maintenance screen. Report the shape, not the contents.
    const excerpt = bodyText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return new WooError(
      'protocol',
      `store returned a non-JSON response; first bytes: ${excerpt || '(empty)'}`,
      status,
      undefined,
      status >= 500,
    );
  }

  const wooCode = asString(parsed.code);
  const message = asString(parsed.message) ?? 'no message supplied by the store';

  if (status === 401 || status === 403) {
    return new WooError('auth', message, status, wooCode, false);
  }
  if (status === 404) {
    return new WooError('not_found', message, status, wooCode, false);
  }
  if (status === 429) {
    return new WooError('rate_limited', message, status, wooCode, true);
  }
  if (status >= 400 && status < 500) {
    return new WooError('validation', message, status, wooCode, false);
  }
  return new WooError('upstream', message, status, wooCode, true);
}

export function isWooError(value: unknown): value is WooError {
  return value instanceof WooError;
}
