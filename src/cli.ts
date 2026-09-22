#!/usr/bin/env node
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { DiscordRestClient } from './discord.js';
import { parseAction, SnowflakeSchema, type Action } from './domain.js';
import { DomainError, toPublicError } from './errors.js';
import { FileConfirmationStore, FileCreatedResourceStore, FileOperationStore, FileTargetLockManager, JsonlAuditSink } from './persistence.js';
import { PolicyConfigSchema, type PolicyConfig } from './policy.js';
import { FileActionPlanStore, PlanningExecutionService, type ActionDiscordAdapter, type ActionPlan } from './service.js';

const HELP = `discord-ai-interface — policy-controlled Discord administration

Setup and inspection:
  discord-ai-interface setup
  discord-ai-interface status
  discord-ai-interface guilds
  discord-ai-interface guild GUILD_ID
  discord-ai-interface channels GUILD_ID
  discord-ai-interface channel GUILD_ID CHANNEL_ID
  discord-ai-interface roles GUILD_ID
  discord-ai-interface member GUILD_ID MEMBER_ID
  discord-ai-interface bans GUILD_ID
  discord-ai-interface audit GUILD_ID [LIMIT]

Mutations (each command is a separate, durable step):
  discord-ai-interface propose --action-json JSON
  discord-ai-interface propose-nl TEXT
  discord-ai-interface approve OPERATION_ID
  discord-ai-interface execute OPERATION_ID
  discord-ai-interface operation OPERATION_ID
  discord-ai-interface recover OPERATION_ID NOTE
  discord-ai-interface reconcile OPERATION_ID succeeded|failed NOTE

Autonomous mode (guild marked "autonomous": true in the policy):
  discord-ai-interface auto --action-json JSON
  discord-ai-interface auto-nl TEXT
  discord-ai-interface batch --actions-json '["ACTION_JSON", ...]'   (up to 20 actions, one call)

Approval always prompts on a terminal for the complete canonical action hash unless the
target guild is in autonomous mode, where planning and execution happen in one step.
There is no --yes, environment-variable, or command-line confirmation bypass.

Environment:
  DISCORD_BOT_TOKEN       required, environment only
  DISCORD_AI_POLICY       policy JSON path (required for mutation commands)
  DISCORD_AI_DATA_DIR     durable state directory (default .discord-ai-interface)
  OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL  optional propose-nl provider
`;

interface Writable { write(value: string): unknown }
export interface CliDependencies {
  readonly stdout?: Writable;
  readonly stderr?: Writable;
  readonly discord?: ActionDiscordAdapter & Partial<Pick<DiscordRestClient, 'listCurrentUserGuilds' | 'listGuildBans' | 'getGuildAuditLogs'>>;
  /** Test/embedding boundary. The production entry point always uses an interactive TTY. */
  readonly confirmHash?: (expectedHash: string) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

interface Runtime {
  readonly discord: ActionDiscordAdapter & Partial<Pick<DiscordRestClient, 'listCurrentUserGuilds' | 'listGuildBans' | 'getGuildAuditLogs'>>;
  readonly operations: FileOperationStore;
  readonly service: PlanningExecutionService;
}

function json(output: Writable, value: unknown): void { output.write(`${JSON.stringify(value, null, 2)}\n`); }
function id(value: string | undefined, label: string): string {
  const parsed = SnowflakeSchema.safeParse(value);
  if (!parsed.success) throw new TypeError(`${label} must be a valid Discord snowflake`);
  return parsed.data;
}
function dataDirectory(env: NodeJS.ProcessEnv): string { return resolve(env.DISCORD_AI_DATA_DIR ?? '.discord-ai-interface'); }
function policyStatus(env: NodeJS.ProcessEnv): { readonly configured: boolean; readonly valid: boolean } {
  if (env.DISCORD_AI_POLICY === undefined || env.DISCORD_AI_POLICY === '') return { configured: false, valid: false };
  try { readPolicy(env); return { configured: true, valid: true }; }
  catch { return { configured: true, valid: false }; }
}
function readPolicy(env: NodeJS.ProcessEnv): PolicyConfig {
  const path = env.DISCORD_AI_POLICY;
  if (path === undefined || path === '') throw new DomainError('CONFIG_INVALID', 'DISCORD_AI_POLICY is required for mutation commands');
  try { return PolicyConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('CONFIG_INVALID', 'Policy file is missing or invalid');
  }
}
function runtime(env: NodeJS.ProcessEnv, dependencies: CliDependencies, needsPolicy = true): Runtime {
  const config = loadConfig({ env });
  const discord = dependencies.discord ?? new DiscordRestClient({ token: config.discord.botToken, baseUrl: config.discord.apiBaseUrl, requestTimeoutMs: config.discord.requestTimeoutMs });
  const directory = dataDirectory(env);
  const operations = new FileOperationStore(resolve(directory, 'operations.json'));
  const policy = needsPolicy ? readPolicy(env) : PolicyConfigSchema.parse({});
  const service = new PlanningExecutionService({
    discord, policy, operations,
    confirmations: new FileConfirmationStore(resolve(directory, 'confirmations.json')),
    plans: new FileActionPlanStore(resolve(directory, 'plans.json')),
    locks: new FileTargetLockManager(resolve(directory, 'target-locks')),
    created: new FileCreatedResourceStore(resolve(directory, 'created-resources.json')),
    audit: new JsonlAuditSink(resolve(directory, 'audit.jsonl')),
  });
  return { discord, operations, service };
}

async function interactiveHash(expectedHash: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new DomainError('CONFIRMATION_INVALID', 'Approval requires an interactive terminal');
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await reader.question(`Type the complete action hash to approve:\n${expectedHash}\n> `)).trim(); }
  finally { reader.close(); }
}

function proposalView(operation: unknown, plan: ActionPlan): unknown {
  return { operation, preview: {
    action: plan.action, actionHash: plan.actionHash, risk: plan.risk, reversibility: plan.reversibility,
    reason: plan.action.reason, before: plan.before, after: plan.after, diff: plan.diff,
    consequences: plan.consequences, warnings: plan.warnings, preconditions: plan.preconditions,
  } };
}

async function naturalLanguageAction(text: string, env: NodeJS.ProcessEnv, fetcher: typeof globalThis.fetch): Promise<Readonly<Action>> {
  const key = env.OPENAI_API_KEY; const model = env.OPENAI_MODEL;
  if (key === undefined || key === '' || model === undefined || model === '') throw new DomainError('CONFIG_INVALID', 'OPENAI_API_KEY and OPENAI_MODEL are required for propose-nl');
  let provider: URL;
  try { provider = new URL(env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1'); }
  catch { throw new DomainError('CONFIG_INVALID', 'OPENAI_BASE_URL is invalid'); }
  const transportAllowed = provider.protocol === 'https:' || (provider.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(provider.hostname));
  if (!transportAllowed || provider.username !== '' || provider.password !== '' || provider.search !== '' || provider.hash !== '') throw new DomainError('CONFIG_INVALID', 'OPENAI_BASE_URL must use HTTPS, except loopback HTTP for local testing');
  const base = provider.toString().replace(/\/+$/, ''); const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30_000);
  let response: Response; let body: unknown;
  try {
    response = await fetcher(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({
      model, temperature: 0,
      messages: [
        { role: 'system', content: 'Translate the operator request into exactly one JSON object matching a narrow Discord action. Allowed type values: role.add, role.remove, role.create, role.update, role.delete, role.reorder, member.timeout, member.untimeout, member.ban, member.unban, overwrite.upsert, overwrite.delete, channel.create, channel.update, channel.delete, channel.reorder, message.send. Use immutable numeric IDs, include a reason, and output JSON only. role.create needs name, color, hoist, mentionable. channel.create needs name, channelType (text, voice, category, announcement, stage, forum, media) and optional parentId. message.send needs channelId, mentionEveryone (false unless asked), allowedMentions (["everyone"] only with mentionEveryone), and an embed with title, description, color and optional fields. You only propose actions; the operator decides whether they execute autonomously.' },
        { role: 'user', content: text },
      ],
    }), signal: controller.signal, redirect: 'error' });
    if (!response.ok) throw new DomainError('CONFIG_INVALID', `Natural-language provider returned status ${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > 65_536) throw new DomainError('CONFIG_INVALID', 'Natural-language provider response is too large');
    const raw = await response.text();
    if (raw.length > 65_536) throw new DomainError('CONFIG_INVALID', 'Natural-language provider response is too large');
    try { body = JSON.parse(raw) as unknown; } catch { throw new DomainError('CONFIG_INVALID', 'Natural-language provider returned invalid JSON'); }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('CONFIG_INVALID', 'Natural-language provider request failed');
  } finally { clearTimeout(timer); }
  const content = (body as { choices?: { message?: { content?: unknown } }[] }).choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new DomainError('CONFIG_INVALID', 'Natural-language provider returned no proposal');
  let candidate: unknown;
  try { candidate = JSON.parse(content); } catch { throw new DomainError('CONFIG_INVALID', 'Natural-language provider proposal was not a JSON action'); }
  if (JSON.stringify(candidate).includes(key)) throw new DomainError('CONFIG_INVALID', 'Natural-language provider returned secret material; proposal rejected');
  return parseAction(candidate);
}

/** Run one CLI command. Production approval cannot be scripted because it requires a TTY. */
export async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = process.env, dependencies: CliDependencies = {}): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout; const stderr = dependencies.stderr ?? process.stderr;
  try {
    if (args.length === 0 || args.includes('--help') || args.includes('-h')) { stdout.write(HELP); return 0; }
    if (args.includes('--version') || args.includes('-v')) { stdout.write('0.1.0\n'); return 0; }
    if (args.length === 2 && args[0] === 'config' && args[1] === 'check') { loadConfig({ env }); stdout.write('Configuration is valid.\n'); return 0; }
    if (args.length === 1 && args[0] === 'setup') {
      loadConfig({ env }); const directory = dataDirectory(env); mkdirSync(directory, { recursive: true, mode: 0o700 });
      json(stdout, { ready: true, dataDirectory: directory, policy: policyStatus(env) }); return 0;
    }
    if (args.length === 1 && args[0] === 'status') {
      const value = runtime(env, dependencies, false); const user = await value.discord.getCurrentUser();
      json(stdout, { configured: true, discord: { connected: true, botId: user.id, username: user.username ?? null }, dataDirectory: dataDirectory(env), policy: policyStatus(env) }); return 0;
    }
    if (args.length === 1 && args[0] === 'guilds') {
      const discord = runtime(env, dependencies, false).discord;
      if (discord.listCurrentUserGuilds === undefined) throw new DomainError('INTERNAL_ERROR', 'Discord adapter does not support guild inspection');
      json(stdout, await discord.listCurrentUserGuilds()); return 0;
    }
    if (args[0] === 'guild' && args.length === 2) { const value = runtime(env, dependencies, false); json(stdout, await value.discord.getGuild(id(args[1], 'guildId'))); return 0; }
    if (args[0] === 'channels' && args.length === 2) { const value = runtime(env, dependencies, false); json(stdout, await value.discord.listGuildChannels(id(args[1], 'guildId'))); return 0; }
    if (args[0] === 'channel' && args.length === 3) {
      const guildId = id(args[1], 'guildId'); const channelId = id(args[2], 'channelId'); const value = runtime(env, dependencies, false);
      const channel = (await value.discord.listGuildChannels(guildId)).find((item) => item.id === channelId);
      if (channel === undefined) throw new DomainError('DISCORD_HTTP_ERROR', 'Channel not found'); json(stdout, channel); return 0;
    }
    if (args[0] === 'roles' && args.length === 2) { const value = runtime(env, dependencies, false); json(stdout, await value.discord.listGuildRoles(id(args[1], 'guildId'))); return 0; }
    if (args[0] === 'member' && args.length === 3) { const value = runtime(env, dependencies, false); json(stdout, await value.discord.getGuildMember(id(args[1], 'guildId'), id(args[2], 'memberId'))); return 0; }
    if (args[0] === 'bans' && args.length === 2) {
      const discord = runtime(env, dependencies, false).discord;
      if (discord.listGuildBans === undefined) throw new DomainError('INTERNAL_ERROR', 'Discord adapter does not support ban inspection');
      json(stdout, await discord.listGuildBans(id(args[1], 'guildId'))); return 0;
    }
    if (args[0] === 'audit' && (args.length === 2 || args.length === 3)) {
      const discord = runtime(env, dependencies, false).discord;
      if (discord.getGuildAuditLogs === undefined) throw new DomainError('INTERNAL_ERROR', 'Discord adapter does not support audit-log inspection');
      const limit = args[2] === undefined ? 50 : Number(args[2]);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be an integer from 1 to 100');
      json(stdout, await discord.getGuildAuditLogs(id(args[1], 'guildId'), { limit })); return 0;
    }
    if (args[0] === 'propose' && args.length === 3 && args[1] === '--action-json') {
      let action: unknown; try { action = JSON.parse(args[2] ?? ''); } catch { throw new TypeError('Action must be valid JSON'); }
      const value = runtime(env, dependencies); const result = await value.service.propose(action); json(stdout, proposalView(result.operation, result.plan)); return 0;
    }
    if (args[0] === 'propose-nl' && args.length >= 2) {
      const action = await naturalLanguageAction(args.slice(1).join(' '), env, dependencies.fetch ?? globalThis.fetch);
      const value = runtime(env, dependencies); const result = await value.service.propose(action); json(stdout, proposalView(result.operation, result.plan)); return 0;
    }
    if (args[0] === 'approve' && args.length === 2) {
      const value = runtime(env, dependencies); const operationId = args[1] ?? ''; const operation = value.operations.get(operationId);
      if (operation === undefined) throw new DomainError('OPERATION_NOT_FOUND', 'Operation not found');
      json(stdout, { operationId: operation.id, action: operation.action, actionHash: operation.actionHash });
      const confirmation = value.service.requestConfirmation(operation.id, 5 * 60_000);
      const supplied = await (dependencies.confirmHash ?? interactiveHash)(operation.actionHash);
      json(stdout, value.service.approve(operation.id, confirmation.id, supplied)); return 0;
    }
    if (args[0] === 'execute' && args.length === 2) { const value = runtime(env, dependencies); json(stdout, await value.service.execute(args[1] ?? '')); return 0; }
    if (args[0] === 'auto' && args.length === 3 && args[1] === '--action-json') {
      let action: unknown; try { action = JSON.parse(args[2] ?? ''); } catch { throw new TypeError('Action must be valid JSON'); }
      const value = runtime(env, dependencies); const result = await value.service.executeAutonomous(action); json(stdout, proposalView(result.operation, result.plan)); return 0;
    }
    if (args[0] === 'auto-nl' && args.length >= 2) {
      const action = await naturalLanguageAction(args.slice(1).join(' '), env, dependencies.fetch ?? globalThis.fetch);
      const value = runtime(env, dependencies); const result = await value.service.executeAutonomous(action); json(stdout, proposalView(result.operation, result.plan)); return 0;
    }
    if (args[0] === 'batch' && args.length === 3 && args[1] === '--actions-json') {
      let actions: unknown; try { actions = JSON.parse(args[2] ?? ''); } catch { throw new TypeError('Actions must be valid JSON'); }
      if (!Array.isArray(actions) || actions.length === 0 || actions.length > 20) throw new TypeError('Actions must be a JSON array of 1 to 20 actions');
      const value = runtime(env, dependencies); const results: unknown[] = [];
      const list = actions as unknown[];
      for (const action of list) {
        try { const result = await value.service.executeAutonomous(action); results.push({ action, operation: result.operation, preview: result.plan }); }
        catch (error) { results.push({ action, error: toPublicError(error) }); }
      }
      json(stdout, { results }); return 0;
    }
    if (args[0] === 'operation' && args.length === 2) {
      const value = runtime(env, dependencies, false); const operation = value.operations.get(args[1] ?? '');
      if (operation === undefined) throw new DomainError('OPERATION_NOT_FOUND', 'Operation not found'); json(stdout, operation); return 0;
    }
    if (args[0] === 'recover' && args.length >= 3) {
      const value = runtime(env, dependencies); json(stdout, value.service.recoverInterrupted(args[1] ?? '', args.slice(2).join(' '))); return 0;
    }
    if (args[0] === 'reconcile' && args.length >= 4 && (args[2] === 'succeeded' || args[2] === 'failed')) {
      const value = runtime(env, dependencies); json(stdout, value.service.reconcile(args[1] ?? '', args[2], args.slice(3).join(' '))); return 0;
    }
    stderr.write('Unknown or malformed command. Run discord-ai-interface --help.\n'); return 2;
  } catch (error) { stderr.write(`${JSON.stringify(toPublicError(error))}\n`); return 1; }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runCli(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}
