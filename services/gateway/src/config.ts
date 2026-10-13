/**
 * Configuration, parsed and validated once at startup.
 *
 * The rule this file exists to enforce: a missing or malformed secret is a refusal to
 * boot, not a null discovered three layers deeper at the worst moment. A gateway that
 * starts without its encryption key looks healthy, passes its probes, serves the
 * dashboard, and fails the first time someone adds an upstream - by which point the
 * failure is a stack trace in a request handler rather than a sentence in the startup
 * log.
 *
 * So every value is declared here with its constraints, `loadConfig()` is called before
 * anything else, and a failure prints the offending field names and exits non-zero.
 * Kubernetes then shows CrashLoopBackOff with a readable reason, which is the loudest and
 * most honest way for a misconfiguration to present.
 */
import { z } from 'zod';

/**
 * Secret lengths are validated, not merely required.
 *
 * `JWT_SECRET` signs session cookies and `ENCRYPTION_KEY` wraps upstream credentials at
 * rest. A short value for either is worse than a missing one, because it works: the
 * system runs normally and the protection is weak in a way nothing surfaces. A floor
 * here means the Helm chart cannot accidentally generate something too small, and a
 * human cannot paste a placeholder.
 *
 * 32 bytes for the AES-256-GCM key, expressed as 64 hex characters. Hex rather than
 * base64 so the length is unambiguous and a truncated value is obvious on sight.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(3000),

  // Postgres. Assembled from parts rather than taken as one DSN, because the password
  // arrives from a Kubernetes Secret on its own and reassembling a connection string in
  // the chart would put the credential into a template and then into `describe pod`.
  PGHOST: z.string().min(1),
  PGPORT: z.coerce.number().int().positive().max(65535).default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),

  /**
   * Pool ceiling, per replica. Postgres's own `max_connections` defaults to 100, and the
   * arithmetic matters: this number is multiplied by the replica count, and exceeding the
   * server's limit turns a traffic spike into "too many clients already" for every
   * replica at once. 10 x 2 replicas leaves ample headroom for the migration Job and a
   * psql session.
   */
  PG_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),

  // Signs the dashboard session cookie. Used in 4.3.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  // AES-256-GCM key for upstream credentials at rest. Used in 4.5.
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/, 'ENCRYPTION_KEY must be 64 lowercase hex characters (32 bytes)'),

  /**
   * Whether the session cookie carries the `Secure` attribute, i.e. HTTPS only.
   *
   * Defaults to **true**, so the safe value is what you get by forgetting to set it. The
   * local overlay turns it off because the kind cluster serves plain HTTP and a Secure
   * cookie would simply never be stored, making login appear to succeed and every later
   * request 401. Defaulting the other way would mean a production deployment that quietly
   * sends session cookies over plaintext if the value were ever omitted.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Hosts permitted as upstream MCP servers, comma separated. Consumed by the SSRF guard
   * in 4.6: it rejects loopback, private, link-local and CGNAT addresses, and this
   * allowlist is what re-admits the in-cluster services that legitimately live on private
   * addresses. Parsed here so a malformed list fails at startup rather than on first use.
   */
  UPSTREAM_ALLOWLIST: z
    .string()
    .default('*.svc.cluster.local')
    .transform((raw) =>
      raw
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .refine((list) => list.length > 0, 'UPSTREAM_ALLOWLIST must contain at least one pattern'),

  METRICS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);

  if (!parsed.success) {
    // Written to stderr directly rather than through the logger, because the logger has
    // not been constructed yet - its level comes from the config being validated here.
    //
    // Only the field name and the rule are printed, never the received value. A
    // validation error that echoes its input is how a secret ends up in a crash log, and
    // "ENCRYPTION_KEY must be 64 lowercase hex characters" already says everything the
    // operator needs.
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    process.stderr.write(
      `gateway: refusing to start, configuration is invalid.\n${issues}\n` +
        'Every value above comes from the Helm chart; see charts/platform/values.yaml.\n',
    );
    process.exit(1);
  }

  return parsed.data;
}
