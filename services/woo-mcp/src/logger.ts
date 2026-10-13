/**
 * Structured logging.
 *
 * Every log line is JSON with a request id, because the interesting question in this
 * system is never "what happened" but "what happened to this one call" - and that
 * question is unanswerable across a gateway, this server and WordPress unless the id
 * travels with it.
 *
 * The redaction list is not decoration. This process holds a WooCommerce credential and
 * builds an Authorization header on every request; one careless object dump would put it
 * in a log aggregator forever. The repo's eslint config also warns on `console.*` so
 * output cannot bypass this on the way out.
 */
import { pino } from 'pino';

export function createLogger(level: string, storeSlug: string) {
  return pino({
    level,
    base: { service: 'woo-mcp', store: storeSlug },
    redact: {
      paths: [
        'authorization',
        'Authorization',
        'headers.authorization',
        'headers.Authorization',
        'password',
        'appPassword',
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
