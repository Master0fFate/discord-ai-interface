import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { DiscordApiError, type DiscordBan, type DiscordChannel, type DiscordGuild, type DiscordMember, type DiscordMessage, type DiscordRole, type DiscordUser } from '../src/discord.js';
import type { ActionDiscordAdapter } from '../src/service.js';

const GUILD = '10000000000000000'; const BOT = '20000000000000000'; const MEMBER = '30000000000000000'; const ROLE = '40000000000000000';
class MockDiscord implements ActionDiscordAdapter {
  readonly guild: DiscordGuild = { id: GUILD, name: 'Test Guild', owner_id: BOT };
  readonly roles: DiscordRole[] = [
    { id: GUILD, name: '@everyone', position: 0, permissions: '0' },
    { id: '50000000000000000', name: 'Bot', position: 10, permissions: String(1n << 28n) },
    { id: ROLE, name: 'Helper', position: 2, permissions: '0' },
  ];
  memberRoles: string[] = [];
  public getCurrentUser(): Promise<DiscordUser> { return Promise.resolve({ id: BOT, username: 'admin-bot' }); }
  public listCurrentUserGuilds(): Promise<readonly DiscordGuild[]> { return Promise.resolve([this.guild]); }
  public getGuild(): Promise<DiscordGuild> { return Promise.resolve(this.guild); }
  public listGuildRoles(): Promise<readonly DiscordRole[]> { return Promise.resolve(this.roles); }
  public getGuildMember(_guildId: string, memberId: string): Promise<DiscordMember> { return Promise.resolve(memberId === BOT ? { user: { id: BOT }, roles: ['50000000000000000'] } : { user: { id: MEMBER }, roles: this.memberRoles }); }
  public listGuildChannels(): Promise<readonly DiscordChannel[]> { return Promise.resolve([]); }
  public getGuildBan(guildId: string, memberId: string): Promise<DiscordBan> { return Promise.reject(new DiscordApiError({ kind: 'http', message: 'not found', status: 404, method: 'GET', route: `/guilds/${guildId}/bans/${memberId}` })); }
  public listGuildBans(): Promise<readonly DiscordBan[]> { return Promise.resolve([]); }
  public addMemberRole(): Promise<void> { this.memberRoles = [ROLE]; return Promise.resolve(); }
  public removeMemberRole(): Promise<void> { this.memberRoles = []; return Promise.resolve(); }
  public timeoutMember(): Promise<DiscordMember> { return Promise.resolve({}); }
  public clearMemberTimeout(): Promise<DiscordMember> { return Promise.resolve({}); }
  public banMember(): Promise<void> { return Promise.resolve(); }
  public unbanMember(): Promise<void> { return Promise.resolve(); }
  public upsertChannelPermissionOverwrite(): Promise<void> { return Promise.resolve(); }
  public deleteChannelPermissionOverwrite(): Promise<void> { return Promise.resolve(); }
  public createGuildRole(): Promise<DiscordRole> { return Promise.resolve({ id: ROLE }); }
  public updateGuildRole(): Promise<DiscordRole> { return Promise.resolve({ id: ROLE }); }
  public deleteGuildRole(): Promise<void> { return Promise.resolve(); }
  public reorderGuildRole(): Promise<void> { return Promise.resolve(); }
  public createGuildChannel(): Promise<DiscordChannel> { return Promise.resolve({ id: GUILD }); }
  public updateChannel(): Promise<DiscordChannel> { return Promise.resolve({ id: GUILD }); }
  public deleteChannel(): Promise<void> { return Promise.resolve(); }
  public reorderGuildChannel(): Promise<void> { return Promise.resolve(); }
  public createMessage(): Promise<DiscordMessage> { return Promise.resolve({ id: GUILD }); }
  public getChannelMessages(): Promise<readonly DiscordMessage[]> { return Promise.resolve([]); }
}
function sink(): { readonly output: { write(value: string): void }; readonly text: () => string } {
  let value = ''; return { output: { write(chunk): void { value += chunk; } }, text: () => value };
}

describe('human CLI', () => {
  it('supports reads and a durable propose-confirm-execute flow', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-cli-')); const policyPath = join(directory, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ guilds: { [GUILD]: { operations: ['role.add'], roleIds: [ROLE], memberIds: [MEMBER] } } }));
    const env = { DISCORD_BOT_TOKEN: 'test-token', DISCORD_AI_DATA_DIR: directory, DISCORD_AI_POLICY: policyPath };
    const discord = new MockDiscord();

    const read = sink(); expect(await runCli(['guilds'], env, { discord, stdout: read.output, stderr: read.output })).toBe(0);
    expect(JSON.parse(read.text())).toEqual([expect.objectContaining({ id: GUILD, name: 'Test Guild' })]);

    const proposed = sink(); const action = { type: 'role.add', guildId: GUILD, memberId: MEMBER, roleId: ROLE, reason: 'Approved support access' };
    expect(await runCli(['propose', '--action-json', JSON.stringify(action)], env, { discord, stdout: proposed.output, stderr: proposed.output })).toBe(0);
    const proposal = JSON.parse(proposed.text()) as { operation: { id: string }; preview: { actionHash: string; diff: unknown[] } };
    expect(proposal.preview.actionHash).toMatch(/^[a-f0-9]{64}$/); expect(proposal.preview.diff).toHaveLength(1);

    const approved = sink();
    expect(await runCli(['approve', proposal.operation.id], env, { discord, stdout: approved.output, stderr: approved.output, confirmHash: (hash) => Promise.resolve(hash) })).toBe(0);
    expect(approved.text()).toContain('"status": "approved"');

    const executed = sink();
    expect(await runCli(['execute', proposal.operation.id], env, { discord, stdout: executed.output, stderr: executed.output })).toBe(0);
    expect(JSON.parse(executed.text())).toEqual(expect.objectContaining({ status: 'succeeded' })); expect(discord.memberRoles).toEqual([ROLE]);

    const status = sink(); expect(await runCli(['operation', proposal.operation.id], env, { discord, stdout: status.output, stderr: status.output })).toBe(0);
    expect((JSON.parse(status.text()) as { status: string }).status).toBe('succeeded');
  });

  it('rejects provider responses that reflect the provider credential', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-cli-provider-')); const policyPath = join(directory, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ guilds: { [GUILD]: { operations: ['role.add'], roleIds: [ROLE], memberIds: [MEMBER] } } }));
    const key = 'provider-secret-value'; const output = sink();
    const reflected = { choices: [{ message: { content: JSON.stringify({ type: 'role.add', guildId: GUILD, memberId: MEMBER, roleId: ROLE, reason: key }) } }] };
    const fetcher = () => Promise.resolve(new Response(JSON.stringify(reflected), { status: 200, headers: { 'content-type': 'application/json' } }));
    const code = await runCli(['propose-nl', 'grant support role'], { DISCORD_BOT_TOKEN: 'test-token', DISCORD_AI_DATA_DIR: directory, DISCORD_AI_POLICY: policyPath, OPENAI_API_KEY: key, OPENAI_MODEL: 'test-model' }, { discord: new MockDiscord(), stdout: output.output, stderr: output.output, fetch: fetcher });
    expect(code).toBe(1); expect(output.text()).not.toContain(key); expect(output.text()).toContain('secret material');
  });

  it('has no command-line approval bypass', async () => {
    const output = sink();
    expect(await runCli(['approve', '00000000-0000-0000-0000-000000000000', '--yes'], {}, { stdout: output.output, stderr: output.output })).toBe(2);
    expect(output.text()).toContain('Unknown or malformed command');
  });

  it('executes autonomously with auto when the guild is marked autonomous', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-cli-auto-')); const policyPath = join(directory, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ guilds: { [GUILD]: { autonomous: true, operations: ['role.add'], roleIds: [ROLE], memberIds: [MEMBER] } } }));
    const env = { DISCORD_BOT_TOKEN: 'test-token', DISCORD_AI_DATA_DIR: directory, DISCORD_AI_POLICY: policyPath };
    const discord = new MockDiscord();
    const output = sink();
    const action = { type: 'role.add', guildId: GUILD, memberId: MEMBER, roleId: ROLE, reason: 'Autonomous grant' };
    expect(await runCli(['auto', '--action-json', JSON.stringify(action)], env, { discord, stdout: output.output, stderr: output.output })).toBe(0);
    const result = JSON.parse(output.text()) as { operation: { status: string }; preview: { actionHash: string; diff: unknown[] } };
    expect(result.operation.status).toBe('succeeded'); expect(result.preview.actionHash).toMatch(/^[a-f0-9]{64}$/); expect(discord.memberRoles).toEqual([ROLE]);
  });

  it('refuses auto for a guild that is not autonomous', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-cli-auto-denied-')); const policyPath = join(directory, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ guilds: { [GUILD]: { operations: ['role.add'], roleIds: [ROLE], memberIds: [MEMBER] } } }));
    const env = { DISCORD_BOT_TOKEN: 'test-token', DISCORD_AI_DATA_DIR: directory, DISCORD_AI_POLICY: policyPath };
    const output = sink();
    const action = { type: 'role.add', guildId: GUILD, memberId: MEMBER, roleId: ROLE, reason: 'Denied grant' };
    expect(await runCli(['auto', '--action-json', JSON.stringify(action)], env, { discord: new MockDiscord(), stdout: output.output, stderr: output.output })).toBe(1);
    expect(output.text()).toContain('POLICY_DENIED');
  });

  it('runs autonomous batches through one CLI call', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'discord-cli-batch-')); const policyPath = join(directory, 'policy.json');
    writeFileSync(policyPath, JSON.stringify({ guilds: { [GUILD]: { autonomous: true, operations: ['role.add'], roleIds: [ROLE], memberIds: [MEMBER] } } }));
    const env = { DISCORD_BOT_TOKEN: 'test-token', DISCORD_AI_DATA_DIR: directory, DISCORD_AI_POLICY: policyPath };
    const discord = new MockDiscord(); const output = sink();
    const action = { type: 'role.add', guildId: GUILD, memberId: MEMBER, roleId: ROLE, reason: 'Batch grant' };
    expect(await runCli(['batch', '--actions-json', JSON.stringify([action, action])], env, { discord, stdout: output.output, stderr: output.output })).toBe(0);
    const result = JSON.parse(output.text()) as { results: { operation: { status: string } }[] };
    expect(result.results).toHaveLength(2);
    expect(result.results.every((entry) => entry.operation.status === 'succeeded')).toBe(true);
    expect(discord.memberRoles).toEqual([ROLE]);
  });
});
