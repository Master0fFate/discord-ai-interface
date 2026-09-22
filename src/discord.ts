import { Secret } from './config.js';
import { SnowflakeSchema } from './domain.js';
import { DomainError } from './errors.js';

const DEFAULT_BASE_URL = 'https://discord.com/api/v10';
const DEFAULT_USER_AGENT = 'DiscordBot (https://github.com/Master0fFate/discord-ai-interface, 0.1.0)';
const JSON_CONTENT_TYPE = 'application/json';

type Fetch = typeof globalThis.fetch;
type HttpMethod = 'GET' | 'PATCH' | 'PUT' | 'DELETE' | 'POST';
type DiscordJson = Record<string, unknown>;

/** Discord's message-create nonce accepts at most 25 characters; action clientNonce values are UUIDs (36). */
export function nonceForWire(nonce: string): string {
  return nonce.replace(/-/g, '').slice(0, 25);
}

export type DiscordErrorKind = 'http' | 'network' | 'rate_limit' | 'timeout' | 'invalid_response';

/** A Discord transport error containing only operator-safe, non-secret metadata. */
export class DiscordApiError extends DomainError {
  public readonly kind: DiscordErrorKind;
  public readonly status: number | undefined;
  public readonly discordCode: number | string | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly uncertain: boolean;

  public constructor(options: {
    readonly kind: DiscordErrorKind;
    readonly message: string;
    readonly status?: number;
    readonly discordCode?: number | string;
    readonly retryAfterMs?: number;
    readonly uncertain?: boolean;
    readonly method: HttpMethod;
    readonly route: string;
  }) {
    const details: Record<string, unknown> = { kind: options.kind, method: options.method, route: options.route };
    if (options.status !== undefined) details.status = options.status;
    if (options.discordCode !== undefined) details.discordCode = options.discordCode;
    if (options.retryAfterMs !== undefined) details.retryAfterMs = options.retryAfterMs;
    if (options.uncertain === true) details.uncertain = true;
    super(errorCode(options.kind), options.message, details);
    this.name = 'DiscordApiError';
    this.kind = options.kind;
    this.status = options.status;
    this.discordCode = options.discordCode;
    this.retryAfterMs = options.retryAfterMs;
    this.uncertain = options.uncertain ?? false;
  }
}

function errorCode(kind: DiscordErrorKind): 'DISCORD_HTTP_ERROR' | 'DISCORD_NETWORK_ERROR' | 'DISCORD_RATE_LIMITED' | 'DISCORD_TIMEOUT' | 'DISCORD_INVALID_RESPONSE' {
  switch (kind) {
    case 'http': return 'DISCORD_HTTP_ERROR';
    case 'network': return 'DISCORD_NETWORK_ERROR';
    case 'rate_limit': return 'DISCORD_RATE_LIMITED';
    case 'timeout': return 'DISCORD_TIMEOUT';
    case 'invalid_response': return 'DISCORD_INVALID_RESPONSE';
  }
}

export interface DiscordRestOptions {
  readonly token: string | Secret;
  readonly baseUrl?: string;
  readonly fetch?: Fetch;
  /** Number of retries after the initial attempt. */
  readonly maxRetries?: number;
  readonly requestTimeoutMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly userAgent?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly random?: () => number;
  readonly now?: () => number;
}

export interface DiscordUser extends DiscordJson { readonly id: string }
export interface DiscordGuild extends DiscordJson { readonly id: string }
export interface DiscordChannel extends DiscordJson { readonly id: string }
export interface DiscordRole extends DiscordJson { readonly id: string }
export interface DiscordMember extends DiscordJson { readonly user?: DiscordUser }
export interface DiscordBan extends DiscordJson { readonly user: DiscordUser }
export interface DiscordMessage extends DiscordJson { readonly id: string; readonly nonce?: string | number; readonly embeds?: readonly Record<string, unknown>[] }
export type DiscordAuditLog = DiscordJson;

export interface ListGuildBansOptions {
  readonly limit?: number;
  readonly before?: string;
  readonly after?: string;
}

export interface GetAuditLogsOptions {
  readonly userId?: string;
  readonly actionType?: number;
  readonly before?: string;
  readonly after?: string;
  readonly limit?: number;
}

interface ParsedError {
  readonly discordCode?: number | string;
  readonly retryAfterMs?: number;
  readonly global: boolean;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateId(value: string, name: string): string {
  const result = SnowflakeSchema.safeParse(value);
  if (!result.success) throw new TypeError(`${name} must be a valid Discord snowflake`);
  return result.data;
}

function auditReason(reason: string): string {
  const normalized = reason.trim();
  const encoded = encodeURIComponent(normalized);
  if (normalized.length === 0 || encoded.length > 512) throw new TypeError('URL-encoded audit reason must be between 1 and 512 characters');
  return encoded;
}

function addQuery(path: string, values: Readonly<Record<string, string | number | undefined>>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) query.set(key, String(value));
  const suffix = query.toString();
  return suffix === '' ? path : `${path}?${suffix}`;
}

/** Narrow Discord REST v10 client. It never exposes its token or raw error bodies. */
export class DiscordRestClient {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #fetch: Fetch;
  readonly #maxRetries: number;
  readonly #requestTimeoutMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #userAgent: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #random: () => number;
  readonly #now: () => number;
  #globalBlockedUntil = 0;
  readonly #routeBlockedUntil = new Map<string, number>();
  readonly #bucketByRoute = new Map<string, string>();
  readonly #bucketBlockedUntil = new Map<string, number>();

  public constructor(options: DiscordRestOptions) {
    const token = options.token instanceof Secret ? options.token.reveal() : options.token;
    if (token.trim() === '' || /\s/.test(token)) throw new TypeError('Discord bot token is invalid');
    this.#token = token;
    let baseUrl: URL;
    try { baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL); }
    catch { throw new TypeError('Discord API base URL is invalid'); }
    const transportAllowed = baseUrl.protocol === 'https:' || (baseUrl.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(baseUrl.hostname));
    if (!transportAllowed || baseUrl.username !== '' || baseUrl.password !== '' || baseUrl.search !== '' || baseUrl.hash !== '') throw new TypeError('Discord API base URL must use HTTPS, except loopback HTTP for local testing');
    this.#baseUrl = baseUrl.toString().replace(/\/+$/, '');
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#maxRetries = options.maxRetries ?? 3;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#sleep = options.sleep ?? delay;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    if (!Number.isInteger(this.#maxRetries) || this.#maxRetries < 0 || this.#maxRetries > 10) throw new TypeError('maxRetries must be an integer from 0 to 10');
    if (!Number.isFinite(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) throw new TypeError('requestTimeoutMs must be positive');
    if (!Number.isFinite(this.#maxRetryDelayMs) || this.#maxRetryDelayMs <= 0) throw new TypeError('maxRetryDelayMs must be positive');
    if (!/^DiscordBot \([^\r\n]+\)$/.test(this.#userAgent)) throw new TypeError('userAgent must use the DiscordBot (URL, version) format');
  }

  public getCurrentUser(): Promise<DiscordUser> {
    return this.#request<DiscordUser>('GET', '/users/@me');
  }

  public listCurrentUserGuilds(): Promise<readonly DiscordGuild[]> {
    return this.#request<readonly DiscordGuild[]>('GET', '/users/@me/guilds');
  }

  public getGuild(guildId: string): Promise<DiscordGuild> {
    return this.#request<DiscordGuild>('GET', `/guilds/${validateId(guildId, 'guildId')}`);
  }

  public listGuildChannels(guildId: string): Promise<readonly DiscordChannel[]> {
    return this.#request<readonly DiscordChannel[]>('GET', `/guilds/${validateId(guildId, 'guildId')}/channels`);
  }

  public listGuildRoles(guildId: string): Promise<readonly DiscordRole[]> {
    return this.#request<readonly DiscordRole[]>('GET', `/guilds/${validateId(guildId, 'guildId')}/roles`);
  }

  public getGuildMember(guildId: string, memberId: string): Promise<DiscordMember> {
    return this.#request<DiscordMember>('GET', `/guilds/${validateId(guildId, 'guildId')}/members/${validateId(memberId, 'memberId')}`);
  }

  public listGuildBans(guildId: string, options: ListGuildBansOptions = {}): Promise<readonly DiscordBan[]> {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) throw new TypeError('ban limit must be an integer from 1 to 1000');
    if (options.before !== undefined && options.after !== undefined) throw new TypeError('before and after cannot be used together');
    const path = addQuery(`/guilds/${validateId(guildId, 'guildId')}/bans`, {
      limit: options.limit, before: options.before === undefined ? undefined : validateId(options.before, 'before'), after: options.after === undefined ? undefined : validateId(options.after, 'after'),
    });
    return this.#request<readonly DiscordBan[]>('GET', path);
  }

  public getGuildBan(guildId: string, memberId: string): Promise<DiscordBan> {
    return this.#request<DiscordBan>('GET', `/guilds/${validateId(guildId, 'guildId')}/bans/${validateId(memberId, 'memberId')}`);
  }

  public getGuildAuditLogs(guildId: string, options: GetAuditLogsOptions = {}): Promise<DiscordAuditLog> {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)) throw new TypeError('audit-log limit must be an integer from 1 to 100');
    if (options.actionType !== undefined && (!Number.isInteger(options.actionType) || options.actionType < 0)) throw new TypeError('actionType must be a nonnegative integer');
    if (options.before !== undefined && options.after !== undefined) throw new TypeError('before and after cannot be used together');
    const path = addQuery(`/guilds/${validateId(guildId, 'guildId')}/audit-logs`, {
      user_id: options.userId === undefined ? undefined : validateId(options.userId, 'userId'), action_type: options.actionType,
      before: options.before === undefined ? undefined : validateId(options.before, 'before'), after: options.after === undefined ? undefined : validateId(options.after, 'after'), limit: options.limit,
    });
    return this.#request<DiscordAuditLog>('GET', path);
  }

  public async addMemberRole(guildId: string, memberId: string, roleId: string, reason: string): Promise<void> {
    await this.#request('PUT', `/guilds/${validateId(guildId, 'guildId')}/members/${validateId(memberId, 'memberId')}/roles/${validateId(roleId, 'roleId')}`, undefined, reason);
  }

  public async removeMemberRole(guildId: string, memberId: string, roleId: string, reason: string): Promise<void> {
    await this.#request('DELETE', `/guilds/${validateId(guildId, 'guildId')}/members/${validateId(memberId, 'memberId')}/roles/${validateId(roleId, 'roleId')}`, undefined, reason);
  }

  public setMemberTimeout(guildId: string, memberId: string, until: string | null, reason: string): Promise<DiscordMember> {
    if (until !== null) {
      const timestamp = Date.parse(until);
      if (!Number.isFinite(timestamp) || timestamp <= this.#now() || timestamp > this.#now() + 28 * 24 * 60 * 60 * 1000) throw new TypeError('timeout must be a valid future timestamp no more than 28 days away');
    }
    return this.#request<DiscordMember>('PATCH', `/guilds/${validateId(guildId, 'guildId')}/members/${validateId(memberId, 'memberId')}`, { communication_disabled_until: until }, reason);
  }

  public timeoutMember(guildId: string, memberId: string, until: string, reason: string): Promise<DiscordMember> {
    return this.setMemberTimeout(guildId, memberId, until, reason);
  }

  public clearMemberTimeout(guildId: string, memberId: string, reason: string): Promise<DiscordMember> {
    return this.setMemberTimeout(guildId, memberId, null, reason);
  }

  public async banMember(guildId: string, memberId: string, deleteMessageSeconds: number, reason: string): Promise<void> {
    if (!Number.isInteger(deleteMessageSeconds) || deleteMessageSeconds < 0 || deleteMessageSeconds > 604_800) throw new TypeError('deleteMessageSeconds must be an integer from 0 to 604800');
    await this.#request('PUT', `/guilds/${validateId(guildId, 'guildId')}/bans/${validateId(memberId, 'memberId')}`, { delete_message_seconds: deleteMessageSeconds }, reason);
  }

  public async unbanMember(guildId: string, memberId: string, reason: string): Promise<void> {
    await this.#request('DELETE', `/guilds/${validateId(guildId, 'guildId')}/bans/${validateId(memberId, 'memberId')}`, undefined, reason);
  }

  public async upsertChannelPermissionOverwrite(channelId: string, targetId: string, targetType: 'role' | 'member', allow: string, deny: string, reason: string): Promise<void> {
    if (!/^(0|[1-9][0-9]*)$/.test(allow) || !/^(0|[1-9][0-9]*)$/.test(deny)) throw new TypeError('Permission values must be unsigned decimal strings');
    if ((BigInt(allow) & BigInt(deny)) !== 0n) throw new TypeError('Permission values may not overlap');
    await this.#request('PUT', `/channels/${validateId(channelId, 'channelId')}/permissions/${validateId(targetId, 'targetId')}`, { allow, deny, type: targetType === 'role' ? 0 : 1 }, reason);
  }

  public async deleteChannelPermissionOverwrite(channelId: string, targetId: string, reason: string): Promise<void> {
    await this.#request('DELETE', `/channels/${validateId(channelId, 'channelId')}/permissions/${validateId(targetId, 'targetId')}`, undefined, reason);
  }

  public createGuildRole(guildId: string, name: string, color: number, hoist: boolean, mentionable: boolean, reason: string): Promise<DiscordRole> {
    return this.#request<DiscordRole>('POST', `/guilds/${validateId(guildId, 'guildId')}/roles`, { name, color, hoist, mentionable }, reason);
  }

  public updateGuildRole(guildId: string, roleId: string, name: string, color: number, hoist: boolean, mentionable: boolean, reason: string): Promise<DiscordRole> {
    return this.#request<DiscordRole>('PATCH', `/guilds/${validateId(guildId, 'guildId')}/roles/${validateId(roleId, 'roleId')}`, { name, color, hoist, mentionable }, reason);
  }

  public async deleteGuildRole(guildId: string, roleId: string, reason: string): Promise<void> {
    await this.#request('DELETE', `/guilds/${validateId(guildId, 'guildId')}/roles/${validateId(roleId, 'roleId')}`, undefined, reason);
  }

  public async reorderGuildRole(guildId: string, roleId: string, position: number, reason: string): Promise<void> {
    if (!Number.isInteger(position) || position < 1 || position > 250) throw new TypeError('role position must be an integer from 1 to 250');
    await this.#request('PATCH', `/guilds/${validateId(guildId, 'guildId')}/roles`, [{ id: validateId(roleId, 'roleId'), position }], reason);
  }

  public createGuildChannel(guildId: string, name: string, channelType: 'text' | 'voice' | 'category' | 'announcement' | 'stage' | 'forum' | 'media', parentId: string | undefined, reason: string): Promise<DiscordChannel> {
    const type: Record<string, number> = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16 };
    const body: Record<string, unknown> = { name, type: type[channelType] };
    if (parentId !== undefined) body.parent_id = validateId(parentId, 'parentId');
    return this.#request<DiscordChannel>('POST', `/guilds/${validateId(guildId, 'guildId')}/channels`, body, reason);
  }

  public updateChannel(channelId: string, name: string, parentId: string | null, reason: string): Promise<DiscordChannel> {
    const body: Record<string, unknown> = { name };
    if (parentId !== null) body.parent_id = validateId(parentId, 'parentId');
    else body.parent_id = null;
    return this.#request<DiscordChannel>('PATCH', `/channels/${validateId(channelId, 'channelId')}`, body, reason);
  }

  public async deleteChannel(channelId: string, reason: string): Promise<void> {
    await this.#request('DELETE', `/channels/${validateId(channelId, 'channelId')}`, undefined, reason);
  }

  public async reorderGuildChannel(guildId: string, channelId: string, position: number, reason: string): Promise<void> {
    if (!Number.isInteger(position) || position < 0 || position > 500) throw new TypeError('channel position must be an integer from 0 to 500');
    await this.#request('PATCH', `/guilds/${validateId(guildId, 'guildId')}/channels`, [{ id: validateId(channelId, 'channelId'), position }], reason);
  }

  public createMessage(channelId: string, payload: { readonly content?: string; readonly nonce?: string; readonly embeds: readonly Record<string, unknown>[]; readonly allowedMentions: readonly string[] }, reason: string): Promise<DiscordMessage> {
    const body: Record<string, unknown> = { embeds: payload.embeds, allowed_mentions: { parse: payload.allowedMentions } };
    if (payload.content !== undefined) body.content = payload.content;
    // Discord's message-create nonce accepts at most 25 characters; action nonces are UUIDs (36).
    if (payload.nonce !== undefined) body.nonce = nonceForWire(payload.nonce);
    return this.#request<DiscordMessage>('POST', `/channels/${validateId(channelId, 'channelId')}/messages`, body, reason);
  }

  public getChannelMessages(channelId: string, limit: number): Promise<readonly DiscordMessage[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('message limit must be an integer from 1 to 100');
    return this.#request<readonly DiscordMessage[]>('GET', `/channels/${validateId(channelId, 'channelId')}/messages?limit=${limit}`);
  }

  async #request<T = void>(method: HttpMethod, route: string, body?: DiscordJson | readonly unknown[], reason?: string): Promise<T> {
    const routeKey = route.split('?')[0] ?? route;
    const mutation = method !== 'GET';
    const encodedReason = reason === undefined ? undefined : auditReason(reason);
    let mutationMayHaveApplied = false;
    for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
      await this.#waitForLimit(routeKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
      let response: Response;
      try {
        const headers: Record<string, string> = { Authorization: `Bot ${this.#token}`, 'User-Agent': this.#userAgent, Accept: JSON_CONTENT_TYPE };
        if (body !== undefined) headers['Content-Type'] = JSON_CONTENT_TYPE;
        if (encodedReason !== undefined) headers['X-Audit-Log-Reason'] = encodedReason;
        response = await this.#fetch(`${this.#baseUrl}${route}`, {
          method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: 'error',
        });
      } catch {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        if (mutation) mutationMayHaveApplied = true;
        if (attempt < this.#maxRetries) {
          await this.#sleep(this.#backoff(attempt));
          continue;
        }
        throw new DiscordApiError({ kind: timedOut ? 'timeout' : 'network', message: timedOut ? 'Discord request timed out.' : 'Discord network request failed.', method, route: routeKey, uncertain: mutationMayHaveApplied });
      }
      try {
        this.#recordBucket(routeKey, response);
        if (response.ok) return await this.#parseSuccess<T>(response, method, routeKey);

        const parsed = await this.#parseError(response);
        if (response.status === 429) {
          const retryAfterMs = Math.min(parsed.retryAfterMs ?? 1_000, this.#maxRetryDelayMs);
          this.#block(routeKey, response, retryAfterMs, parsed.global);
          if (attempt < this.#maxRetries) continue;
          throw new DiscordApiError({ kind: 'rate_limit', message: 'Discord rate limit retry budget exhausted.', status: 429, ...(parsed.discordCode === undefined ? {} : { discordCode: parsed.discordCode }), retryAfterMs, method, route: routeKey, uncertain: mutationMayHaveApplied });
        }
        if (response.status >= 500) {
          if (mutation) mutationMayHaveApplied = true;
          if (attempt < this.#maxRetries) {
            const retryHeader = this.#headerDelay(response);
            await this.#sleep(retryHeader ?? this.#backoff(attempt));
            continue;
          }
        }
        throw new DiscordApiError({ kind: 'http', message: `Discord API request failed with status ${response.status}.`, status: response.status, ...(parsed.discordCode === undefined ? {} : { discordCode: parsed.discordCode }), method, route: routeKey, uncertain: mutationMayHaveApplied });
      } finally { clearTimeout(timer); }
    }
    throw new DiscordApiError({ kind: 'network', message: 'Discord retry budget exhausted.', method, route: routeKey, uncertain: mutation });
  }

  async #parseSuccess<T>(response: Response, method: HttpMethod, route: string): Promise<T> {
    if (response.status === 204 || response.headers.get('content-length') === '0') return undefined as T;
    try {
      return await response.json() as T;
    } catch {
      throw new DiscordApiError({ kind: 'invalid_response', message: 'Discord returned an invalid JSON response.', status: response.status, method, route, uncertain: method !== 'GET' });
    }
  }

  async #parseError(response: Response): Promise<ParsedError> {
    let value: unknown;
    try { value = await response.json(); } catch { value = undefined; }
    if (!isObject(value)) return { global: response.headers.get('x-ratelimit-global') === 'true' };
    const code = typeof value.code === 'number' || typeof value.code === 'string' ? value.code : undefined;
    const retry = typeof value.retry_after === 'number' && Number.isFinite(value.retry_after) && value.retry_after >= 0 ? value.retry_after * 1_000 : undefined;
    return { ...(code === undefined ? {} : { discordCode: code }), ...(retry === undefined ? {} : { retryAfterMs: retry }), global: value.global === true || response.headers.get('x-ratelimit-global') === 'true' };
  }

  #recordBucket(route: string, response: Response): void {
    const bucket = response.headers.get('x-ratelimit-bucket');
    if (bucket !== null) this.#bucketByRoute.set(route, bucket);
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const wait = this.#headerDelay(response);
      if (wait !== undefined) this.#block(route, response, wait, false);
    }
  }

  #block(route: string, response: Response, delayMs: number, global: boolean): void {
    const until = this.#now() + Math.max(0, delayMs);
    if (global) this.#globalBlockedUntil = Math.max(this.#globalBlockedUntil, until);
    else {
      this.#routeBlockedUntil.set(route, Math.max(this.#routeBlockedUntil.get(route) ?? 0, until));
      const bucket = response.headers.get('x-ratelimit-bucket') ?? this.#bucketByRoute.get(route);
      if (bucket !== undefined) this.#bucketBlockedUntil.set(bucket, Math.max(this.#bucketBlockedUntil.get(bucket) ?? 0, until));
    }
  }

  async #waitForLimit(route: string): Promise<void> {
    const bucket = this.#bucketByRoute.get(route);
    const until = Math.max(this.#globalBlockedUntil, this.#routeBlockedUntil.get(route) ?? 0, bucket === undefined ? 0 : this.#bucketBlockedUntil.get(bucket) ?? 0);
    const wait = until - this.#now();
    if (wait > 0) await this.#sleep(Math.min(wait, this.#maxRetryDelayMs));
    this.#routeBlockedUntil.delete(route);
    if (bucket !== undefined) this.#bucketBlockedUntil.delete(bucket);
    if (this.#globalBlockedUntil <= until) this.#globalBlockedUntil = 0;
  }

  #headerDelay(response: Response): number | undefined {
    const raw = response.headers.get('retry-after') ?? response.headers.get('x-ratelimit-reset-after');
    if (raw === null) return undefined;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1_000, this.#maxRetryDelayMs) : undefined;
  }

  #backoff(attempt: number): number {
    const ceiling = Math.min(250 * 2 ** attempt, this.#maxRetryDelayMs);
    return Math.max(1, Math.round(ceiling * (0.5 + this.#random() * 0.5)));
  }
}

/** Compatibility name for consumers that describe the client as an adapter. */
export { DiscordRestClient as DiscordRestAdapter };
