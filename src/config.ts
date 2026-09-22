import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { DomainError } from './errors.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** A value that is redacted by stringification, inspection, and JSON encoding. */
export class Secret {
  readonly #value: string;

  public constructor(value: string) {
    this.#value = value;
    Object.freeze(this);
  }

  public reveal(): string {
    return this.#value;
  }

  public toString(): string {
    return '[REDACTED]';
  }

  public toJSON(): string {
    return '[REDACTED]';
  }

  public [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'Secret([REDACTED])';
  }
}

const apiUrlSchema = z.string().url().refine((value) => {
  const url = new URL(value);
  const transportAllowed = url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  return transportAllowed && url.username === '' && url.password === '' && url.search === '' && url.hash === '';
}, 'API URL must be HTTP(S) without credentials, query, or fragment');
const fileSchema = z
  .object({
    discordApiBaseUrl: apiUrlSchema.optional(),
    logLevel: z.enum(LOG_LEVELS).optional(),
    requestTimeoutMs: z.number().int().min(1_000).max(60_000).optional(),
  })
  .strict();

const tokenSchema = z.string().min(1).regex(/^\S+$/);
const timeoutEnvironmentSchema = z.coerce.number().int().min(1_000).max(60_000);

export interface RuntimeConfig {
  readonly discord: Readonly<{
    readonly apiBaseUrl: string;
    readonly botToken: Secret;
    readonly requestTimeoutMs: number;
  }>;
  readonly logging: Readonly<{
    readonly level: LogLevel;
  }>;
}

export interface LoadConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly configPath?: string;
}

function configurationError(message: string): DomainError {
  return new DomainError('CONFIG_INVALID', message);
}

function readConfigFile(path: string): unknown {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    throw new DomainError('CONFIG_IO', `Unable to read configuration file: ${path}`);
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw configurationError(`Configuration file is not valid JSON: ${path}`);
  }
}

function parseFileConfig(value: unknown): z.infer<typeof fileSchema> {
  const result = fileSchema.safeParse(value);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.') || 'root'))];
    throw configurationError(`Invalid configuration field(s): ${fields.join(', ')}`);
  }
  return result.data;
}

/**
 * Load and validate configuration. The Discord token is accepted exclusively
 * from DISCORD_BOT_TOKEN; JSON configuration is deliberately non-secret.
 */
export function loadConfig(options: LoadConfigOptions = {}): RuntimeConfig {
  const env = options.env ?? process.env;
  const path = options.configPath ?? env.DISCORD_AI_CONFIG;
  const file = path === undefined || path === '' ? {} : parseFileConfig(readConfigFile(path));

  const tokenResult = tokenSchema.safeParse(env.DISCORD_BOT_TOKEN);
  if (!tokenResult.success) {
    throw configurationError('DISCORD_BOT_TOKEN is required and must contain no whitespace.');
  }

  const levelValue = env.LOG_LEVEL ?? file.logLevel ?? 'info';
  const levelResult = z.enum(LOG_LEVELS).safeParse(levelValue);
  if (!levelResult.success) {
    throw configurationError(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}.`);
  }

  const timeoutValue = env.DISCORD_REQUEST_TIMEOUT_MS ?? file.requestTimeoutMs ?? 10_000;
  const timeoutResult = timeoutEnvironmentSchema.safeParse(timeoutValue);
  if (!timeoutResult.success) {
    throw configurationError('DISCORD_REQUEST_TIMEOUT_MS must be an integer from 1000 to 60000.');
  }

  const apiBaseUrl = env.DISCORD_API_BASE_URL ?? file.discordApiBaseUrl ?? 'https://discord.com/api/v10';
  const urlResult = apiUrlSchema.safeParse(apiBaseUrl);
  if (!urlResult.success) {
    throw configurationError('DISCORD_API_BASE_URL must be a valid URL.');
  }

  const discord = Object.freeze({
    apiBaseUrl: urlResult.data.replace(/\/$/, ''),
    botToken: new Secret(tokenResult.data),
    requestTimeoutMs: timeoutResult.data,
  });
  const logging = Object.freeze({ level: levelResult.data });
  return Object.freeze({ discord, logging });
}
