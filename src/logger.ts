import type { Writable } from 'node:stream';
import { Secret, type LogLevel } from './config.js';

const levelRank: Record<Exclude<LogLevel, 'silent'>, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};
const sensitiveKey = /(?:authorization|token|secret|password|api[-_]?key|cookie)/i;
const discordToken = /(?:Bot\s+)?[\w-]{20,}\.[\w-]{6,}\.[\w-]{20,}/g;

export interface Logger {
  debug(message: string, context?: Readonly<Record<string, unknown>>): void;
  info(message: string, context?: Readonly<Record<string, unknown>>): void;
  warn(message: string, context?: Readonly<Record<string, unknown>>): void;
  error(message: string, context?: Readonly<Record<string, unknown>>): void;
}

export interface LoggerOptions {
  readonly level?: LogLevel;
  readonly destination?: Writable;
  readonly secrets?: readonly string[];
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  let result = value.replace(discordToken, '[REDACTED]');
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join('[REDACTED]');
  }
  return result;
}

export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  const seen = new WeakSet();

  const visit = (item: unknown, key?: string): unknown => {
    if (key !== undefined && sensitiveKey.test(key)) return '[REDACTED]';
    if (item instanceof Secret) return '[REDACTED]';
    if (typeof item === 'string') return redactText(item, secrets);
    if (typeof item === 'bigint') return item.toString();
    if (item === null || typeof item !== 'object') return item;
    if (seen.has(item)) return '[Circular]';
    seen.add(item);

    if (item instanceof Error) {
      const code = 'code' in item && typeof item.code === 'string' ? item.code : undefined;
      return {
        name: item.name,
        message: redactText(item.message, secrets),
        ...(code === undefined ? {} : { code }),
      };
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry));

    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(item)) {
      output[entryKey] = visit(entryValue, entryKey);
    }
    return output;
  };

  return visit(value);
}

/** JSON-lines logger. Its default destination is stderr, keeping MCP stdout clean. */
export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const destination = options.destination ?? process.stderr;
  const secrets = options.secrets ?? [];

  const emit = (
    entryLevel: Exclude<LogLevel, 'silent'>,
    message: string,
    context?: Readonly<Record<string, unknown>>,
  ): void => {
    if (level === 'silent' || levelRank[entryLevel] < levelRank[level]) return;
    const record = redactValue(
      {
        timestamp: new Date().toISOString(),
        level: entryLevel,
        message,
        ...(context === undefined ? {} : { context }),
      },
      secrets,
    );
    destination.write(`${JSON.stringify(record)}\n`);
  };

  return {
    debug: (message, context) => emit('debug', message, context),
    info: (message, context) => emit('info', message, context),
    warn: (message, context) => emit('warn', message, context),
    error: (message, context) => emit('error', message, context),
  };
}
