/**
 * Configuration, resolved once at startup and validated immediately.
 *
 * Fails fast and loudly on anything missing. A server that starts with half a
 * configuration and only discovers the gap on the first tool call turns a deployment
 * mistake into an intermittent runtime error, which is strictly harder to diagnose than
 * a pod that refuses to start and says why.
 */
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * In-cluster address of the WordPress Service, e.g. http://store-default-wordpress.
   * Never a public URL: this server talks to the store over the cluster network, which
   * is the whole reason it needs no external route of its own.
   */
  WC_BASE_URL: z.string().url(),

  /**
   * The store's canonical public hostname, sent as the Host header.
   *
   * WordPress compares the Host header against its configured siteurl and answers with a
   * 301 to the stored value when they differ. Calling the Service name without this
   * would therefore be redirected to the public URL - which this server cannot reach and
   * must not follow.
   */
  WC_STORE_HOST: z.string().min(1),

  WC_USERNAME: z.string().min(1),

  /**
   * Path to the mounted Secret file holding the WordPress application password. A file
   * rather than an environment variable, so a rotated Secret is picked up without a
   * restart - see credentials.ts.
   */
  WC_PASSWORD_FILE: z.string().min(1),

  WC_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  WC_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  /**
   * Budget for the diagnostic store probe in /readyz. Small on purpose, and capped, so
   * that it cannot grow past the kubelet's own probe timeout - at which point readiness
   * would fail on a store outage, which is precisely what the readiness design exists to
   * avoid. The cap is the guardrail; see client.ts `probe()` for the failure it prevents.
   *
   * The chart sets the readiness probe's `timeoutSeconds` to 3 explicitly rather than
   * leaving it at the kubelet's default of 1, so this budget and the ceiling in index.ts
   * both sit comfortably underneath it. The max here is deliberately below 3000ms: a
   * value above the probe timeout would be silently self-defeating.
   */
  WC_PROBE_TIMEOUT_MS: z.coerce.number().int().positive().max(2_000).default(1_000),

  /** Identifies which store this server fronts, for logs and tool descriptions. */
  STORE_SLUG: z.string().min(1).default('default'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`invalid configuration: ${detail}`);
  }
  return parsed.data;
}
