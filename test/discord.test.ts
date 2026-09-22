import { describe, expect, it, vi } from 'vitest';
import { DiscordApiError, DiscordRestClient } from '../src/discord.js';

const guildId = '12345678901234567';
const memberId = '22345678901234567';
const roleId = '32345678901234567';
const token = 'very-secret-token';

function response(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  return new Response(body === undefined ? undefined : JSON.stringify(body), { ...init, headers });
}

describe('DiscordRestClient', () => {
  it('rejects plaintext non-loopback API endpoints that would expose the bot token', () => {
    expect(() => new DiscordRestClient({ token, baseUrl: 'http://example.com/api/v10' })).toThrow(/must use HTTPS/);
    expect(() => new DiscordRestClient({ token, baseUrl: 'http://127.0.0.1:3000/api/v10' })).not.toThrow();
  });

  it('authenticates reads with a safe User-Agent and parses success', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response({ id: guildId }, { status: 200 })));
    const client = new DiscordRestClient({ token, baseUrl: 'https://mock.invalid/api/v10', fetch: fetchMock });

    await expect(client.getGuild(guildId)).resolves.toEqual({ id: guildId });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://mock.invalid/api/v10/guilds/${guildId}`);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bot ${token}`);
    expect(new Headers(init?.headers).get('user-agent')).toMatch(/^DiscordBot \(/);
  });

  it('sends narrow mutation JSON and an encoded audit reason', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(undefined, { status: 204 })));
    const client = new DiscordRestClient({ token, fetch: fetchMock });

    await client.banMember(guildId, memberId, 60, 'spam & abuse');
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe('PUT');
    expect(init?.body).toBe('{"delete_message_seconds":60}');
    expect(new Headers(init?.headers).get('x-audit-log-reason')).toBe('spam%20%26%20abuse');
  });

  it('truncates message nonces to the 25-character Discord wire limit and sends embeds', async () => {
    const channelId = '42345678901234567';
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response({ id: 'm1' }, { status: 200 })));
    const client = new DiscordRestClient({ token, baseUrl: 'https://mock.invalid/api/v10', fetch: fetchMock });

    const uuid = 'a1c57857-6104-47fe-8059-e1546dff9cc9';
    await client.createMessage(channelId, { nonce: uuid, embeds: [{ title: 'T', description: 'D', color: 1886430, fields: [] }], allowedMentions: [] }, 'post');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://mock.invalid/api/v10/channels/${channelId}/messages`);
    const rawBody = init?.body as unknown as string;
    const body = JSON.parse(rawBody) as { nonce?: string; embeds: unknown[]; allowed_mentions: { parse: string[] } };
    expect(body.nonce).toBe('a1c57857610447fe8059e1546');
    expect(body.nonce?.length).toBeLessThanOrEqual(25);
    expect(body.embeds).toHaveLength(1);
    expect(body.allowed_mentions.parse).toEqual([]);
  });

  it('rejects audit reasons whose URL-encoded form exceeds Discord limits', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(new Response(undefined, { status: 204 })));
    const client = new DiscordRestClient({ token, fetch: fetchMock });
    await expect(client.banMember(guildId, memberId, 0, 'é'.repeat(100))).rejects.toThrow(/URL-encoded audit reason/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps HTTP errors without retaining the token or response message', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response({ code: 50_013, message: `echo ${token}` }, { status: 403 })));
    const client = new DiscordRestClient({ token, fetch: fetchMock, maxRetries: 0 });

    const error = await client.getGuild(guildId).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(DiscordApiError);
    expect(error).toMatchObject({ kind: 'http', status: 403, discordCode: 50_013, uncertain: false });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(String(error)).not.toContain(token);
  });

  it('uses Discord retry_after for 429 responses and then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ retry_after: 0.25, global: false }, { status: 429, headers: { 'x-ratelimit-bucket': 'bucket' } }))
      .mockResolvedValueOnce(response({ id: guildId }, { status: 200 }));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve());
    let now = 1_000;
    sleep.mockImplementation((milliseconds) => {
      now += milliseconds;
      return Promise.resolve();
    });
    const client = new DiscordRestClient({ token, fetch: fetchMock, maxRetries: 1, sleep, now: () => now });

    await expect(client.getGuild(guildId)).resolves.toEqual({ id: guildId });
    expect(sleep).toHaveBeenCalledWith(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns a structured rate-limit error after bounded retries', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response({ retry_after: 0 }, { status: 429 })));
    const client = new DiscordRestClient({ token, fetch: fetchMock, maxRetries: 1, sleep: () => Promise.resolve() });

    await expect(client.getGuild(guildId)).rejects.toMatchObject({ kind: 'rate_limit', status: 429, retryAfterMs: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bounds a global rate-limit storm and caps attacker-controlled retry delays', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(response({ retry_after: 999, global: true }, { status: 429 })));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve());
    const client = new DiscordRestClient({ token, fetch: fetchMock, maxRetries: 2, maxRetryDelayMs: 100, sleep, now: () => 0 });

    await expect(client.getGuild(guildId)).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: 100 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 100);
    expect(sleep).toHaveBeenNthCalledWith(2, 100);
  });

  it('bounds network retries and marks an unresolved mutation uncertain', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new Error(token)));
    const client = new DiscordRestClient({ token, fetch: fetchMock, maxRetries: 1, sleep: () => Promise.resolve(), random: () => 0 });

    const error = await client.addMemberRole(guildId, memberId, roleId, 'approved').catch((value: unknown) => value);
    expect(error).toMatchObject({ kind: 'network', uncertain: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(error)).not.toContain(token);
  });

  it('preserves mutation uncertainty when a lost response is followed by a definite HTTP error', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('lost response'))
      .mockResolvedValueOnce(response({ code: 50_013 }, { status: 403 }));
    const client = new DiscordRestClient({ token, fetch: fetchMock, maxRetries: 1, sleep: () => Promise.resolve() });
    await expect(client.addMemberRole(guildId, memberId, roleId, 'approved')).rejects.toMatchObject({ kind: 'http', status: 403, uncertain: true });
  });

  it('classifies an aborted request as a timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>((...args) => new Promise<Response>((_resolve, reject) => {
      args[1]?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));
    const client = new DiscordRestClient({ token, fetch: fetchMock, requestTimeoutMs: 1, maxRetries: 0 });

    await expect(client.getGuild(guildId)).rejects.toMatchObject({ kind: 'timeout', uncertain: false });
  });
});
