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

function baseOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'degencage-web' },
    // Money-adjacent app: never let a URL with credentials or a cookie reach a log line.
    redact: {
      paths: ['databaseUrl', 'password', 'secret', 'token', 'cookie', '*.authorization'],
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
