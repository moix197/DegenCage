import { describe, expect, it } from 'vitest';

import { createLogger } from './logger';

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    write(chunk: string) {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  });

  return { logger, lines };
}

describe('logger', () => {
  it('emits structured JSON carrying level, message, service and caller fields', () => {
    const { logger, lines } = captureLogger();

    logger.info('rule evaluated', { correlationId: 'trade-intent-1', verdict: 'allow' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      msg: 'rule evaluated',
      service: 'degencage-web',
      correlationId: 'trade-intent-1',
      verdict: 'allow',
      level: 30,
    });
    expect(lines[0]).toHaveProperty('time');
  });

  it('pins child fields onto every subsequent line', () => {
    const { logger, lines } = captureLogger();

    const scoped = logger.child({ correlationId: 'trade-intent-2' });
    scoped.warn('cooldown active');
    scoped.error('flag lookup failed');

    expect(lines.map((line) => line['correlationId'])).toEqual([
      'trade-intent-2',
      'trade-intent-2',
    ]);
    expect(lines.map((line) => line['level'])).toEqual([40, 50]);
  });

  it('does not throw on a circular payload, and still emits the line', () => {
    const { logger, lines } = captureLogger();

    const circular: Record<string, unknown> = { limitId: 'daily' };
    circular['self'] = circular;

    expect(() => logger.info('circular payload', { circular })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'circular payload' });
  });

  it('redacts credential-shaped fields', () => {
    const { logger, lines } = captureLogger();

    logger.info('connecting', { databaseUrl: 'postgresql://user:hunter2@host/db' });

    expect(lines[0]?.['databaseUrl']).toBe('[redacted]');
  });

  it('redacts credential-shaped fields nested inside a context object', () => {
    const { logger, lines } = captureLogger();

    logger.info('outbound call', {
      jupiter: { apiToken: 'jup-secret' },
      request: { headers: { authorization: 'Bearer abc' } },
      db: { config: { connection: { password: 'hunter2' } } },
      mint: 'So11111111111111111111111111111111111111112',
    });

    const line = lines[0] as Record<string, Record<string, Record<string, never>>>;
    expect(line['jupiter']?.['apiToken']).toBe('[redacted]');
    expect(line['request']?.['headers']?.['authorization']).toBe('[redacted]');
    expect(line['db']?.['config']?.['connection']?.['password']).toBe('[redacted]');
    // Non-credential fields still come through: redaction is targeted, not blanket.
    expect(line['mint']).toBe('So11111111111111111111111111111111111111112');
  });

  it('keeps a nested `token` field carrying an SPL token symbol unredacted', () => {
    const { logger, lines } = captureLogger();

    logger.info('trade blocked', {
      trade: { token: 'BONK', authToken: 'session-secret' },
    });

    const line = lines[0] as Record<string, Record<string, unknown>>;
    // The audit trail is the product: a token symbol is the whole point of the event.
    expect(line['trade']?.['token']).toBe('BONK');
    expect(line['trade']?.['authToken']).toBe('[redacted]');
  });

  it('drops lines below the configured level', () => {
    const { logger, lines } = captureLogger();

    logger.debug('noisy detail');

    expect(lines).toHaveLength(0);
  });
});
