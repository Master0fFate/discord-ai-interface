import { inspect } from 'node:util';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { DomainError } from '../src/errors.js';

const TOKEN = 'test-token-value';

describe('loadConfig', () => {
  it('requires the token only from the environment and applies safe defaults', () => {
    const config = loadConfig({ env: { DISCORD_BOT_TOKEN: TOKEN } });

    expect(config.discord.botToken.reveal()).toBe(TOKEN);
    expect(config.discord.apiBaseUrl).toBe('https://discord.com/api/v10');
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(inspect(config)).not.toContain(TOKEN);
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('rejects a token in the JSON configuration without echoing its value', () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-ai-config-'));
    const path = join(directory, 'config.json');
    const leaked = 'must-never-be-printed';
    writeFileSync(path, JSON.stringify({ discordBotToken: leaked }), 'utf8');

    try {
      loadConfig({ env: { DISCORD_BOT_TOKEN: TOKEN }, configPath: path });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(String(error)).not.toContain(leaked);
    }
  });

  it('does not include invalid environment values in errors', () => {
    const invalidToken = 'private token with spaces';
    try {
      loadConfig({ env: { DISCORD_BOT_TOKEN: invalidToken } });
      throw new Error('expected validation failure');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(String(error)).not.toContain(invalidToken);
    }
  });

  it('rejects unsafe API base URLs', () => {
    for (const value of ['file:///tmp/discord', 'http://example.com/api', 'https://user:pass@example.com/api', 'https://example.com/api?token=x', 'https://example.com/api#fragment']) {
      expect(() => loadConfig({ env: { DISCORD_BOT_TOKEN: TOKEN, DISCORD_API_BASE_URL: value } })).toThrow(/valid URL/);
    }
  });

  it('loads and overrides validated non-secret file settings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-ai-config-'));
    const path = join(directory, 'config.json');
    writeFileSync(path, JSON.stringify({ logLevel: 'warn', requestTimeoutMs: 5_000 }), 'utf8');

    const config = loadConfig({
      env: { DISCORD_BOT_TOKEN: TOKEN, LOG_LEVEL: 'error' },
      configPath: path,
    });
    expect(config.logging.level).toBe('error');
    expect(config.discord.requestTimeoutMs).toBe(5_000);
  });
});
