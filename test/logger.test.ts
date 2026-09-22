import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Secret } from '../src/config.js';
import { createLogger, redactValue } from '../src/logger.js';

class StringSink extends Writable {
  public value = '';

  public override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.value += chunk.toString('utf8');
    callback();
  }
}

describe('redaction-safe logging', () => {
  it('redacts sensitive keys, nested secrets, messages, and errors', () => {
    const token = 'a-registered-private-value';
    const sink = new StringSink();
    const logger = createLogger({ destination: sink, level: 'debug', secrets: [token] });

    logger.error(`request failed with ${token}`, {
      authorization: `Bot ${token}`,
      nested: { botToken: token, safe: 'visible' },
      wrapped: new Secret(token),
      error: new Error(`upstream reflected ${token}`),
    });

    expect(sink.value).not.toContain(token);
    expect(sink.value).toContain('[REDACTED]');
    expect(sink.value).toContain('visible');
  });

  it('handles circular and bigint context without throwing', () => {
    const value: Record<string, unknown> = { count: 1n };
    value.self = value;
    expect(redactValue(value)).toEqual({ count: '1', self: '[Circular]' });
  });

  it('never writes below the selected level', () => {
    const sink = new StringSink();
    const logger = createLogger({ destination: sink, level: 'error' });
    logger.info('not emitted', { token: 'private' });
    expect(sink.value).toBe('');
  });
});
