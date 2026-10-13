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
import { createLogger } from './logger.js';
import { hashPassword } from './auth/passwords.js';

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
