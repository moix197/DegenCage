import pino, { type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from 'pino';

/**
 * The one logging entry point. Nothing else in the codebase imports `pino`
 * directly — that is what makes swapping in OpenTelemetry later a one-file change
 * rather than a sweep (see `.ai/decisions/observability-stack.md`).
 *
 * Structured JSON to stdout only: every host captures stdout, so this is the one
 * logging target with zero lock-in.
 */

export interface LogFields {
  /** The trade-intent id tying every line of one user action together. */
  correlationId?: string;
  [field: string]: unknown;
}

export interface AppLogger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Pins fields onto every subsequent line — how a request pins its correlation id. */
  child(fields: LogFields): AppLogger;
}

/**
 * Field names whose value is never safe to log, wherever they sit in a payload.
 *
 * Every name here has to be credential-shaped *on its own*: redaction is silent, and the
 * event trail is the product, so an over-matching name destroys audit data without
 * anyone noticing. Deliberately absent is a bare `token` — in a Solana app that is an SPL
 * token symbol or mint (`{ trade: { token: 'BONK' } }`), not a credential. Credentials
 * say which kind of token they are.
 */
const CREDENTIAL_FIELDS = [
  'databaseUrl',
  'password',
  'secret',
  'authToken',
  'bearerToken',
  'accessToken',
  'refreshToken',
  'apiToken',
  'apiKey',
  'privateKey',
  'cookie',
  'authorization',
] as const;

/**
 * pino's redactor (fast-redact) has no recursive wildcard, so every nesting level is
 * spelled out. Four covers the depth a log payload realistically reaches — e.g.
 * `{ request: { headers: { authorization } } }`.
 */
const REDACT_DEPTH = 4;

function credentialRedactPaths(): string[] {
  return Array.from({ length: REDACT_DEPTH }, (_, depth) => '*.'.repeat(depth)).flatMap((prefix) =>
    CREDENTIAL_FIELDS.map((field) => `${prefix}${field}`),
  );
}

function baseOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'degencage-web' },
    // Money-adjacent app: never let a URL with credentials or a cookie reach a log line,
    // including when it arrives nested inside a context object rather than top level.
    redact: {
      paths: credentialRedactPaths(),
      censor: '[redacted]',
    },
  };
}

function wrap(pinoLogger: PinoLogger): AppLogger {
  return {
    debug: (message, fields) => pinoLogger.debug(fields ?? {}, message),
    info: (message, fields) => pinoLogger.info(fields ?? {}, message),
    warn: (message, fields) => pinoLogger.warn(fields ?? {}, message),
    error: (message, fields) => pinoLogger.error(fields ?? {}, message),
    child: (fields) => wrap(pinoLogger.child(fields)),
  };
}

/** Exported so tests can capture output; application code uses the `logger` singleton. */
export function createLogger(destination?: DestinationStream): AppLogger {
  return wrap(destination ? pino(baseOptions(), destination) : pino(baseOptions()));
}

export const logger = createLogger();
