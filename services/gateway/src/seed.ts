/**
 * Seed entrypoint: creates the initial admin and member from a Kubernetes Secret.
 *
 * Run by a Helm hook Job as `node dist/seed.js`, using the SAME image as the gateway.
 * That is the point: the hash is produced by the identical argon2id code and parameters
 * that `verifyPassword` will later check it against. A separate seeding tool - a psql
 * script, a one-off container - would mean two implementations of the same format, and the
 * failure when they drift is "the password is correct and login fails", which is exactly
 * the class of bug that cost a day in stage 2 with the WordPress application password.
 *
 * Idempotent, because it runs on every `helm upgrade`, not just install. Re-running must
 * not reset a password an admin has since changed, so the insert is a no-op when the
 * account already exists rather than an upsert.
 */
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger, type Logger } from './logger.js';
import { hashPassword } from './auth/passwords.js';
import { matchesAllowlist } from './security/ssrf.js';

/**
 * Seed-only configuration, validated separately from the gateway's.
 *
 * A minimum length is enforced here as well as in the chart. The chart generates these
 * values, so in normal operation they are strong - but `bootstrapExistingSecret` lets an
 * operator supply their own, and the one thing worse than a generated password is a
 * human-chosen one that is four characters long and now belongs to an admin account.
 */
const seedSchema = z.object({
  SEED_ADMIN_EMAIL: z.string().min(3).max(320),
  SEED_ADMIN_PASSWORD: z.string().min(12, 'SEED_ADMIN_PASSWORD must be at least 12 characters'),
  SEED_MEMBER_EMAIL: z.string().min(3).max(320),
  SEED_MEMBER_PASSWORD: z.string().min(12, 'SEED_MEMBER_PASSWORD must be at least 12 characters'),
});

/**
 * Upstreams to pre-register, supplied as JSON by the chart.
 *
 * A list rather than a single hardcoded WooCommerce entry, because stage 6 adds notes-mcp
 * and everything-mcp and they belong here for the same reason: an upstream the chart
 * installs should be registered by the chart, not typed into a form afterwards. Making it
 * a list now means those two are a values change rather than a code change.
 */
const seedUpstreamSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase letters, digits and hyphens'),
  url: z.string().url().max(2048),
  // Only 'none' is accepted here, deliberately. A pre-registered upstream with a
  // credential would mean a secret travelling through this Job's environment to be
  // encrypted - and the chart has no good place to put one that is not already a
  // Kubernetes Secret the operator could reference directly. An upstream that needs a
  // credential is registered through the API, where the write-only path already exists.
  authType: z.literal('none').default('none'),
  timeoutMs: z.number().int().min(1000).max(120_000).default(20_000),
});

/**
 * Pre-registers the upstreams the chart ships with.
 *
 * ON CONFLICT (slug) DO NOTHING, for the same reason the user insert does: this runs on
 * every `helm upgrade`, and an admin who has since edited the URL, disabled the server or
 * attached a credential must not have that overwritten by a deploy. Idempotent here means
 * "leave an existing upstream alone", not "converge it to the declared state" - the
 * declared state is a starting point, not an authority.
 *
 * Deliberately NOT resolving DNS as part of validation, which is a departure from the SSRF
 * guard on the API. The guard exists because an admin can type an arbitrary URL into a
 * form; this value comes from Helm values, which is the same file the allowlist itself
 * comes from - anyone who can change one can change the other, so resolving adds no
 * security. It would, however, add a failure: the platform chart can be installed before
 * the store chart, so the name may legitimately not resolve yet, and a seed Job that failed
 * for that reason would block the whole release.
 *
 * The shape and the allowlist ARE checked, because those catch a typo or a misconfigured
 * URL the gateway could never reach - a cheap check against a real mistake.
 */
async function seedUpstreams(db: ReturnType<typeof createPool>, logger: Logger, allowlist: string[]): Promise<void> {
  const raw = process.env['SEED_UPSTREAMS'];
  if (raw === undefined || raw.trim() === '' || raw.trim() === '[]') {
    logger.info('no upstreams to pre-register');
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Fail the Job. A malformed list is a chart error, and failing the hook makes it
    // visible at deploy time rather than leaving an operator to wonder why their upstream
    // never appeared.
    process.stderr.write('seed: SEED_UPSTREAMS is not valid JSON\n');
    process.exit(1);
  }

  const upstreams = z.array(seedUpstreamSchema).safeParse(parsed);
  if (!upstreams.success) {
    const issues = upstreams.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    process.stderr.write(`seed: SEED_UPSTREAMS is invalid.\n${issues}\n`);
    process.exit(1);
  }

  for (const upstream of upstreams.data) {
    const host = safeHost(upstream.url);
    if (host === undefined) {
      process.stderr.write(`seed: upstream "${upstream.slug}" has an unusable URL\n`);
      process.exit(1);
    }

    if (!matchesAllowlist(host, allowlist)) {
      // Refused rather than warned. Registering a URL the gateway's own guard will reject
      // on every call would produce an upstream that is permanently unreachable for a
      // reason nobody would look for in the chart.
      process.stderr.write(
        `seed: upstream "${upstream.slug}" host ${host} is not on gateway.upstreamAllowlist; ` +
          'add it there or remove the upstream from seed.upstreams\n',
      );
      process.exit(1);
    }

    const result = await db.query<{ id: string }>(
      `INSERT INTO mcp_servers (slug, name, url, auth_type, timeout_ms)
            VALUES ($1, $2, $3, 'none', $4)
       ON CONFLICT (slug) DO NOTHING
         RETURNING id`,
      [upstream.slug, upstream.name, upstream.url, upstream.timeoutMs],
    );

    if (result.rows.length === 0) {
      logger.info({ slug: upstream.slug }, 'upstream already registered, left unchanged');
    } else {
      logger.info({ slug: upstream.slug, url: upstream.url }, 'upstream pre-registered');
    }
  }
}

/** The hostname, with IPv6 brackets stripped, or undefined if the URL is unusable. */
function safeHost(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === '' ? undefined : host;
  } catch {
    return undefined;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL).child({ component: 'seed' });

  const parsed = seedSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Field names and rules only, never values - the same discipline as config.ts.
    process.stderr.write(`seed: refusing to run, configuration is invalid.\n${issues}\n`);
    process.exit(1);
  }

  const seed = parsed.data;
  const db = createPool(config, logger);

  try {
    for (const account of [
      { email: seed.SEED_ADMIN_EMAIL, password: seed.SEED_ADMIN_PASSWORD, role: 'admin' as const },
      { email: seed.SEED_MEMBER_EMAIL, password: seed.SEED_MEMBER_PASSWORD, role: 'member' as const },
    ]) {
      /**
       * Hash first, then insert with ON CONFLICT DO NOTHING.
       *
       * ON CONFLICT infers the functional unique index by repeating its EXPRESSION,
       * `(lower(email))`. Note it cannot be written as `ON CONSTRAINT
       * users_email_lower_key`: that form only accepts a named constraint, and this is a
       * `CREATE UNIQUE INDEX`, which is not one. The distinction is invisible until the
       * statement fails at runtime.
       *
       * Inferring on the expression also means two casings of one address collide exactly
       * as login treats them, since both consult the same index. DO NOTHING rather
       * than DO UPDATE: an upsert would silently reset the password on every
       * `helm upgrade`, overwriting whatever the admin had changed it to and handing
       * account access back to whoever can read the Secret. Idempotent here means "leave
       * an existing account alone", not "converge it to the declared state".
       *
       * The cost is that this cannot repair a forgotten password - that is a deliberate
       * admin action, not a side effect of a deploy.
       */
      const passwordHash = await hashPassword(account.password);

      const result = await db.query<{ id: string }>(
        `INSERT INTO users (email, password_hash, role)
              VALUES ($1, $2, $3)
         ON CONFLICT (lower(email)) DO NOTHING
           RETURNING id`,
        [account.email, passwordHash, account.role],
      );

      if (result.rows.length === 0) {
        logger.info({ email: account.email, role: account.role }, 'account already exists, left unchanged');
      } else {
        logger.info({ email: account.email, role: account.role, userId: result.rows[0]?.id }, 'account created');
      }
    }

    await seedUpstreams(db, logger, config.UPSTREAM_ALLOWLIST);

    const counts = await db.query<{ role: string; n: string }>(
      'SELECT role, count(*)::text AS n FROM users GROUP BY role ORDER BY role',
    );
    logger.info({ users: counts.rows }, 'seed complete');
  } finally {
    // Always drain the pool. Without this the Job's process keeps an open connection and
    // never exits, so the pod stays Running, the Helm hook waits, and the upgrade times
    // out with no error to explain it.
    await db.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`seed: failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
