/**
 * Configuration, resolved once at startup and validated immediately.
 *
 * Same discipline as woo-mcp: fail fast and loudly on anything missing, because a server
 * that starts with half a configuration and only discovers the gap on the first tool call
 * turns a deployment mistake into an intermittent runtime error.
 */
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  /**
   * Where the SQLite file lives. A path rather than a connection string, because this
   * server owns its storage completely - there is no shared database to point at.
   *
   * It must be on the mounted PVC. The container's root filesystem is read-only, so a
   * default pointing anywhere else would fail at startup rather than silently writing
   * notes somewhere that disappears on the next rollout - which is the better of the two
   * failures, and the reason the default is the mount path rather than something like
   * ./notes.db.
   */
  NOTES_DB_PATH: z.string().min(1).default('/data/notes.db'),

  /**
   * Identifies this instance in logs and tool descriptions.
   *
   * Exists for the same reason woo-mcp has STORE_SLUG: the multi-store direction in the
   * brief's bonus section means a second copy of this server is a values change, and a
   * log line that cannot say which copy produced it is not much use when there are two.
   */
  NOTES_SLUG: z.string().min(1).default('team'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(): Config {
  const parsed = schema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Field names and rules only, never values - the same rule as every other config
      // loader in this repo. A log line that helpfully echoes the bad value is how a
    // secret ends up in a crash loop's output.
    process.stderr.write(`notes-mcp: refusing to start, configuration is invalid.\n${issues}\n`);
    process.exit(1);
  }

  return parsed.data;
}
