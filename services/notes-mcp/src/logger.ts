/**
 * Structured logging.
 *
 * Every log line is JSON with a request id, because the interesting question in this
 * system is never "what happened" but "what happened to this one call" - and that
 * question is unanswerable across a gateway and an upstream unless the id travels with
 * it. The gateway sends `x-request-id` and this server echoes it, so one call's path
 * through two services shares a key.
 *
 * The redaction list is kept even though this service holds no credential at all. It is
 * the cheapest possible guard against the day one is added: a server that starts logging
 * a secret the moment it acquires one is a worse outcome than a list of paths that
 * currently match nothing. The repo's eslint config also warns on `console.*`, so output
 * cannot bypass this on the way out.
 */
import { pino } from 'pino';

export function createLogger(level: string, instanceSlug: string) {
  return pino({
    level,
    base: { service: 'notes-mcp', instance: instanceSlug },
    redact: {
      paths: [
        'authorization',
        'Authorization',
        'headers.authorization',
        'headers.Authorization',
        'password',
        '*.password',
        '*.authorization',
      ],
      censor: '[redacted]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
