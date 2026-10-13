/**
 * WooCommerce REST v3 client.
 *
 * Deliberately small: no SDK, no generated client. The surface this server needs is five
 * endpoints, and a hand-written client means the timeout, retry and error behaviour are
 * all visible in one file rather than being a library's opinion I would have to defend
 * without having chosen it.
 */
import { Buffer } from 'node:buffer';
import type { CredentialFile } from '../credentials.js';
import type { Logger } from '../logger.js';
import { WooError, wooErrorFromResponse } from './errors.js';

export interface WooClientOptions {
  baseUrl: string;
  /** Canonical store hostname, sent as the Host header. See config.ts. */
  storeHost: string;
  username: string;
  credential: CredentialFile;
  timeoutMs: number;
  maxRetries: number;
  /**
   * Budget for the diagnostic store probe in /readyz, deliberately far smaller than
   * `timeoutMs` and used for a single attempt with no retries.
   *
   * This exists because the first version did not have it, and the omission defeated the
   * whole point of the readiness design. See `probe()` below.
   */
  probeTimeoutMs: number;
  logger: Logger;
}

type Query = Record<string, string | number | undefined>;

export class WooClient {
  constructor(private readonly options: WooClientOptions) {}

  async get<T>(path: string, query: Query = {}, requestId?: string): Promise<T> {
    return this.request<T>('GET', path, { query, requestId });
  }

  async post<T>(path: string, body: unknown, requestId?: string): Promise<T> {
    return this.request<T>('POST', path, { body, requestId });
  }

  async put<T>(path: string, body: unknown, requestId?: string): Promise<T> {
    return this.request<T>('PUT', path, { body, requestId });
  }

  /**
   * Liveness of the *store*, for the diagnostic field in /readyz.
   *
   * Returns a reason rather than throwing, because this is reported as information and
   * must never be able to fail a health endpoint.
   *
   * Not throwing is necessary but not sufficient, and the first version proved it. It
   * called `this.get()`, which means a GET - so it inherited the tool-call budget: up to
   * `maxRetries + 1` attempts at `timeoutMs` each, plus backoff between them. Against an
   * unreachable store that is ~40s before it returns anything at all. The readiness
   * handler awaits it, so the handler simply never answered inside the kubelet's
   * `timeoutSeconds`, and the probe failed with `context deadline exceeded`.
   *
   * The result was the exact behaviour the design exists to prevent: the pod left its
   * Service during a store outage, so a caller would have seen a bare connection failure
   * instead of a precise reason. Observed live, on a cluster where Calico had not
   * finished converging after a host reboot and the store was briefly unreachable.
   *
   * So the budget is explicit here: one attempt, `probeTimeoutMs`, no retries. A
   * diagnostic field must be cheaper than the deadline of the thing reporting it.
   */
  async probe(): Promise<{ reachable: boolean; detail: string }> {
    try {
      await this.request('GET', '/wp-json/', {
        requestId: 'probe',
        timeoutMs: this.options.probeTimeoutMs,
        attempts: 1,
      });
      return { reachable: true, detail: 'store responded to /wp-json/' };
    } catch (error) {
      const detail = error instanceof WooError ? error.toToolMessage() : String(error);
      return { reachable: false, detail };
    }
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    // Explicit `| undefined` on each optional: under exactOptionalPropertyTypes,
    // `requestId?: string` means "may be absent", NOT "may be undefined", so passing a
    // `string | undefined` value is rejected. Spelling both out is the honest fix; the
    // alternative is building the object conditionally at every call site.
    opts: {
      query?: Query | undefined;
      body?: unknown;
      requestId?: string | undefined;
      /** Overrides, used only by `probe()` to buy a smaller budget than a tool call. */
      timeoutMs?: number | undefined;
      attempts?: number | undefined;
    },
  ): Promise<T> {
    const url = new URL(path, this.options.baseUrl);
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const timeoutMs = opts.timeoutMs ?? this.options.timeoutMs;

    // Only GET is retried.
    //
    // This is a correctness decision, not a tuning one. A POST to /products that times
    // out may well have succeeded - the response was lost, not the write - so retrying it
    // creates a second product. An unresolved timeout the caller can act on is strictly
    // better than silent duplicate writes they have to find later. Same reasoning for
    // PUT, which is idempotent in principle but whose WooCommerce handlers fire order
    // status hooks, emails and stock changes as side effects.
    const attempts = opts.attempts ?? (method === 'GET' ? this.options.maxRetries + 1 : 1);
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.attempt<T>(method, url, opts.body, opts.requestId, timeoutMs);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof WooError && error.retryable;
        if (!retryable || attempt === attempts) break;

        // Exponential backoff with a small jitter. Jitter matters once the gateway runs
        // two replicas, each with its own client: without it, both back off in lockstep
        // and re-converge on the same instant, turning one slow response into a repeating
        // spike against a store that is already struggling.
        const backoffMs = Math.min(2_000, 150 * 2 ** (attempt - 1)) + Math.random() * 100;
        this.options.logger.warn(
          { requestId: opts.requestId, method, path, attempt, backoffMs, err: String(error) },
          'retrying WooCommerce request',
        );
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }

    throw lastError;
  }

  private async attempt<T>(
    method: string,
    url: URL,
    body: unknown,
    requestId: string | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const password = await this.options.credential.read();
    const auth = Buffer.from(`${this.options.username}:${password}`).toString('base64');

    // AbortController rather than a plain Promise.race: a race leaves the request running
    // and its socket held, so a slow store would accumulate connections until the process
    // ran out of them. Aborting actually cancels the request.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        // Never follow a redirect. WordPress answers a Host mismatch with a 301 to its
        // public URL, which is not reachable from inside the cluster - following it would
        // turn a configuration error into a confusing connection failure. Surfacing the
        // 301 names the actual problem.
        redirect: 'manual',
        headers: {
          Authorization: `Basic ${auth}`,
          Host: this.options.storeHost,
          Accept: 'application/json',
          'User-Agent': 'urumi-woo-mcp/0.1',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      const durationMs = Date.now() - startedAt;
      this.options.logger.debug(
        { requestId, method, path: url.pathname, status: response.status, durationMs },
        'WooCommerce request complete',
      );

      if (response.status >= 300 && response.status < 400) {
        throw new WooError(
          'protocol',
          `store redirected to ${response.headers.get('location') ?? 'an unknown location'}; ` +
            `this usually means the Host header (${this.options.storeHost}) does not match the store's configured siteurl`,
          response.status,
          undefined,
          false,
        );
      }

      const text = await response.text();

      if (!response.ok) {
        throw wooErrorFromResponse(response.status, text);
      }

      if (!text) return undefined as T;

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new WooError(
          'protocol',
          'store returned a 2xx response that was not valid JSON',
          response.status,
          undefined,
          true,
        );
      }
    } catch (error) {
      if (error instanceof WooError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new WooError(
          'timeout',
          // The effective budget for this attempt, not the configured tool-call one -
          // otherwise a probe timing out at 2s would report the 20s figure and send
          // whoever reads the message looking for a fault that is not there.
          `store did not respond within ${timeoutMs}ms`,
          undefined,
          undefined,
          true,
        );
      }
      // DNS failure, connection refused, reset mid-body. Retryable: these are the
      // failures a restarting WordPress pod produces.
      throw new WooError(
        'upstream',
        `could not reach the store: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
