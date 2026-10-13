/**
 * Structured logging.
 *
 * Same shape and the same reasoning as woo-mcp's logger: JSON lines, a request id on
 * every one, and an explicit redaction list. The interesting question in this system is
 * never "what happened" but "what happened to this one call", and that is unanswerable
 * across the dashboard, the gateway, an upstream MCP server and WordPress unless one id
 * travels the whole way.
 *
 * The redaction list matters more here than anywhere else in the project. This process
 * holds every upstream credential, the JWT signing key, the encryption key and users'
 * API keys; it builds Authorization headers for upstreams and reads Cookie headers from
 * browsers. One careless object dump - `log.info({ req })` - would put a session cookie
 * or a bearer token into a log aggregator permanently. Redaction is applied by path, so
 * it keeps working when an object is nested somewhere unexpected.
 *
 * `no-console` in the repo's eslint config is the other half: output cannot bypass this
 * on the way out.
 */
import { pino } from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: 'gateway' },
    redact: {
      paths: [
        // Inbound: browser sessions and API keys.
        'req.headers.authorization',
        'req.headers.cookie',
        'headers.authorization',
        'headers.cookie',
        'authorization',
        'cookie',
        // Outbound: credentials injected into upstream requests.
        'upstreamHeaders',
        '*.authorization',
        // Secrets by the names they carry in this codebase.
        'password',
        'passwordHash',
        'apiKey',
        'secret',
        'token',
        'jwt',
        'credential',
        'encryptionKey',
        'PGPASSWORD',
        'JWT_SECRET',
        'ENCRYPTION_KEY',
        '*.password',
        '*.secret',
        '*.token',
        '*.credential',
      ],
      censor: '[redacted]',
    },
    formatters: {
      // Log the level as a word rather than pino's default numeric code. The numbers are
      // fine for a machine and a nuisance for a human reading `kubectl logs` during a
      // demo, which is the situation these logs actually have to survive.
      level: (label) => ({ level: label }),
    },
  });
}

export type Logger = ReturnType<typeof createLogger>;
