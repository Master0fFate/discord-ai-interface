/* eslint-disable @typescript-eslint/require-await -- synchronous fakes implement promise-returning adapter methods */
import { describe, expect, it } from 'vitest';
import { DiscordApiError, nonceForWire, type DiscordBan, type DiscordChannel, type DiscordGuild, type DiscordMember, type DiscordMessage, type DiscordRole, type DiscordUser } from '../src/discord.js';
import type { Action } from '../src/domain.js';
import { InMemoryOperationStore, type AuditEvent } from '../src/persistence.js';
import { PolicyConfigSchema } from '../src/policy.js';
import { InMemoryCreatedResourceStore, PlanningExecutionService, type ActionDiscordAdapter } from '../src/service.js';

const guildId = '12345678901234567'; const memberId = '22345678901234567'; const botId = '32345678901234567';
const botRoleId = '42345678901234567'; const roleId = '52345678901234567'; const channelId = '62345678901234567';
const categoryId = '72345678901234567'; const otherRoleId = '82345678901234567';
const permissions = ((1n << 2n) | (1n << 28n) | (1n << 40n)).toString();
const structPermissions = ((1n << 2n) | (1n << 28n) | (1n << 40n) | (1n << 4n) | (1n << 10n) | (1n << 11n) | (1n << 17n)).toString();

class FakeDiscord implements ActionDiscordAdapter {
  readonly user: DiscordUser = { id: botId }; readonly guild: DiscordGuild = { id: guildId, owner_id: '92345678901234567' };
  roles: DiscordRole[] = [{ id: guildId, position: 0, permissions: '0' }, { id: roleId, position: 2, permissions: '0' }, { id: otherRoleId, position: 3, permissions: '0' }, { id: botRoleId, position: 10, permissions }];
  members = new Map<string, DiscordMember>([[botId, { user: this.user, roles: [botRoleId] }], [memberId, { user: { id: memberId }, roles: [] }]]);
  channels: DiscordChannel[] = [{ id: categoryId, type: 4, permission_overwrites: [] }, { id: channelId, parent_id: categoryId, permission_overwrites: [] }];
  messages: DiscordMessage[] = [];
  bans = new Set<string>(); noMutation = false; uncertain = false; nextId = 90000000000000000;
  getCurrentUser = async () => this.user; getGuild = async () => this.guild; listGuildRoles = async () => this.roles;
  getGuildMember = async (_g: string, id: string) => { const value = this.members.get(id); if (!value) throw new Error('missing member'); return structuredClone(value); };
  listGuildChannels = async () => structuredClone(this.channels);
  getGuildBan = async (_g: string, id: string): Promise<DiscordBan> => { if (!this.bans.has(id)) throw new DiscordApiError({ kind: 'http', message: 'not found', status: 404, method: 'GET', route: '/ban' }); return { user: { id } }; };
  private maybe(): void { if (this.uncertain) throw new DiscordApiError({ kind: 'timeout', message: 'timeout', uncertain: true, method: 'PUT', route: '/mutation' }); }
  private freshId(): string { const id = String(this.nextId); this.nextId += 1; return id; }
  addMemberRole = async (_g: string, id: string, role: string) => { this.maybe(); if (!this.noMutation) this.members.get(id)!.roles = [...(this.members.get(id)!.roles as string[]), role]; };
  removeMemberRole = async (_g: string, id: string, role: string) => { this.maybe(); if (!this.noMutation) this.members.get(id)!.roles = (this.members.get(id)!.roles as string[]).filter((v) => v !== role); };
  timeoutMember = async (_g: string, id: string, until: string) => { this.maybe(); if (!this.noMutation) this.members.get(id)!.communication_disabled_until = until; return this.members.get(id)!; };
  clearMemberTimeout = async (_g: string, id: string) => { this.maybe(); if (!this.noMutation) this.members.get(id)!.communication_disabled_until = null; return this.members.get(id)!; };
  banMember = async (_g: string, id: string) => { this.maybe(); if (!this.noMutation) this.bans.add(id); };
  unbanMember = async (_g: string, id: string) => { this.maybe(); if (!this.noMutation) this.bans.delete(id); };
  upsertChannelPermissionOverwrite = async (_c: string, id: string, type: 'role' | 'member', allow: string, deny: string) => { this.maybe(); if (!this.noMutation) this.setOverwrite(id, { id, type: type === 'role' ? 0 : 1, allow, deny }); };
  deleteChannelPermissionOverwrite = async (_c: string, id: string) => { this.maybe(); if (!this.noMutation) this.setOverwrite(id); };
  setOverwrite(id: string, value?: Record<string, unknown>): void { const channel = this.channels.find((v) => v.id === channelId)!; const rest = (channel.permission_overwrites as Record<string, unknown>[]).filter((v) => v.id !== id); channel.permission_overwrites = value ? [...rest, value] : rest; }
  createGuildRole = async (_g: string, name: string, color: number, hoist: boolean, mentionable: boolean) => { this.maybe(); const role: DiscordRole = { id: this.freshId(), name, color, hoist, mentionable, position: 1, permissions: '0' }; if (!this.noMutation) this.roles.push(role); return role; };
  updateGuildRole = async (_g: string, id: string, name: string, color: number, hoist: boolean, mentionable: boolean) => { this.maybe(); const role = this.roles.find((v) => v.id === id)!; if (!this.noMutation) Object.assign(role, { name, color, hoist, mentionable }); return role; };
  deleteGuildRole = async (_g: string, id: string) => { this.maybe(); if (!this.noMutation) this.roles = this.roles.filter((v) => v.id !== id); };
  reorderGuildRole = async (_g: string, id: string, position: number) => { this.maybe(); const role = this.roles.find((v) => v.id === id)!; if (!this.noMutation) role.position = position; };
  createGuildChannel = async (_g: string, name: string, channelType: 'text' | 'voice' | 'category' | 'announcement' | 'stage' | 'forum' | 'media', parentId: string | undefined) => { this.maybe(); const type = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16 }[channelType]; const channel: DiscordChannel = { id: this.freshId(), name, type, ...(parentId === undefined ? {} : { parent_id: parentId }), permission_overwrites: [] }; if (!this.noMutation) this.channels.push(channel); return channel; };
  updateChannel = async (id: string, name: string, parentId: string | null) => { this.maybe(); const channel = this.channels.find((v) => v.id === id)!; if (!this.noMutation) { channel.name = name; if (parentId === null) delete channel.parent_id; else channel.parent_id = parentId; } return channel; };
  deleteChannel = async (id: string) => { this.maybe(); if (!this.noMutation) this.channels = this.channels.filter((v) => v.id !== id); };
  reorderGuildChannel = async (_g: string, id: string, position: number) => { this.maybe(); const channel = this.channels.find((v) => v.id === id)!; if (!this.noMutation) channel.position = position; };
  createMessage = async (_c: string, payload: { readonly content?: string; readonly nonce?: string; readonly embeds: readonly Record<string, unknown>[]; readonly allowedMentions: readonly string[] }) => { this.maybe(); const message: DiscordMessage = { id: this.freshId(), ...(payload.content === undefined ? {} : { content: payload.content }), ...(payload.nonce === undefined ? {} : { nonce: nonceForWire(payload.nonce) }), embeds: payload.embeds }; if (!this.noMutation) this.messages.unshift(message); return message; };
  getChannelMessages = async () => structuredClone(this.messages);
}

const basePolicy = PolicyConfigSchema.parse({ guilds: { [guildId]: { operations: ['role.add', 'role.remove', 'member.timeout', 'member.untimeout', 'member.ban', 'member.unban', 'overwrite.upsert', 'overwrite.delete'], roleIds: [roleId], channelIds: [channelId], memberIds: [memberId], allowedPermissionBits: permissions, maxBanDeleteMessageSeconds: 60 } } });
function fixture(discord = new FakeDiscord(), audit: { append(event: AuditEvent): void } = { append: () => undefined }) { const operations = new InMemoryOperationStore(); return { discord, operations, service: new PlanningExecutionService({ discord, operations, policy: basePolicy, audit, now: () => new Date('2025-01-01T00:00:00Z'), verificationDelayMs: 0 }) }; }
async function approved(service: PlanningExecutionService, action: Action) { const proposed = await service.propose(action); const confirmation = service.requestConfirmation(proposed.operation.id, 1000); service.approve(proposed.operation.id, confirmation.id, proposed.plan.actionHash); return { id: proposed.operation.id, plan: proposed.plan }; }
const common = { guildId, reason: 'integration test' };

describe('planning and verified execution integration', () => {
  const actions: { action: Action; setup?(d: FakeDiscord): void }[] = [
    { action: { ...common, type: 'role.add', memberId, roleId } },
    { action: { ...common, type: 'role.remove', memberId, roleId }, setup: (d) => { d.members.get(memberId)!.roles = [roleId]; } },
    { action: { ...common, type: 'member.timeout', memberId, until: '2025-01-01T00:10:00.000Z' } },
    { action: { ...common, type: 'member.untimeout', memberId }, setup: (d) => { d.members.get(memberId)!.communication_disabled_until = '2025-01-01T00:10:00.000Z'; } },
    { action: { ...common, type: 'member.ban', memberId, deleteMessageSeconds: 0 } },
    { action: { ...common, type: 'member.unban', memberId }, setup: (d) => { d.bans.add(memberId); } },
    { action: { ...common, type: 'overwrite.upsert', channelId, targetId: roleId, targetType: 'role', allow: (1n << 28n).toString(), deny: '0' } },
    { action: { ...common, type: 'overwrite.delete', channelId, targetId: roleId, targetType: 'role' }, setup: (d) => d.setOverwrite(roleId, { id: roleId, type: 0, allow: permissions, deny: '0' }) },
  ];
  for (const entry of actions) it(`previews and verifies ${entry.action.type}`, async () => { const f = fixture(); entry.setup?.(f.discord); const value = await approved(f.service, entry.action); expect(value.plan.diff.length).toBeGreaterThan(0); if (entry.action.type === 'overwrite.upsert') expect(value.plan.warnings).toContain('Channel permissions are synchronized with its category; this change will desynchronize them.'); expect((await f.service.execute(value.id)).status).toBe('succeeded'); });

  it('succeeds idempotently without calling Discord when the desired state already holds', async () => {
    const f = fixture();
    f.discord.unbanMember = async () => { throw new Error('no-op mutation must not be called'); };
    const value = await approved(f.service, { ...common, type: 'member.unban', memberId });
    expect(value.plan.diff).toHaveLength(0);
    expect((await f.service.execute(value.id)).status).toBe('succeeded');
  });
  it('discloses irreversible message deletion in ban previews', async () => {
    const f = fixture();
    const proposed = await f.service.propose({ ...common, type: 'member.ban', memberId, deleteMessageSeconds: 60 });
    expect(proposed.plan.reversibility).toBe('irreversible');
    expect(proposed.plan.consequences.join(' ')).toContain('permanently deleted');
  });
  it('rejects timeouts beyond Discord\'s 28-day maximum', async () => {
    const f = fixture();
    await expect(f.service.propose({ ...common, type: 'member.timeout', memberId, until: '2025-01-30T00:00:01.000Z' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('fails before mutation on stale state', async () => { const f = fixture(); const value = await approved(f.service, actions[0]!.action); f.discord.members.get(memberId)!.roles = [otherRoleId]; const result = await f.service.execute(value.id); expect(result.status).toBe('failed'); expect(result.error).toContain('changed'); });
  it('fails closed when role hierarchy becomes stale before execution', async () => { const f = fixture(); const value = await approved(f.service, actions[0]!.action); const managed = f.discord.roles.find((role) => role.id === roleId)!; managed.position = 20; const result = await f.service.execute(value.id); expect(result.status).toBe('failed'); expect(f.discord.members.get(memberId)!.roles).not.toContain(roleId); });
  it('marks postcondition mismatch and uncertain transport for reconciliation', async () => { const mismatch = fixture(); const a = await approved(mismatch.service, actions[0]!.action); mismatch.discord.noMutation = true; expect((await mismatch.service.execute(a.id)).status).toBe('uncertain'); const uncertain = fixture(); const b = await approved(uncertain.service, actions[0]!.action); uncertain.discord.uncertain = true; expect((await uncertain.service.execute(b.id)).status).toBe('uncertain'); expect(uncertain.service.reconcile(b.id, 'failed', 'operator checked Discord').status).toBe('failed'); });
  it('recovers an interrupted executing record into manual reconciliation', () => {
    const f = fixture(); const operation = f.operations.create(actions[0]!.action);
    const approvedOperation = f.operations.transition(operation.id, 'proposed', 'approved', operation.version);
    f.operations.transition(operation.id, 'approved', 'executing', approvedOperation.version);
    expect(f.service.recoverInterrupted(operation.id, 'process crashed after request dispatch').status).toBe('uncertain');
    expect(f.service.reconcile(operation.id, 'failed', 'Discord audit confirms no mutation').status).toBe('failed');
  });
  it('fails closed when attempted audit cannot be written', async () => { const audit = { append(event: AuditEvent) { if (event.event === 'attempted') throw new Error('disk'); } }; const f = fixture(new FakeDiscord(), audit); const value = await approved(f.service, actions[0]!.action); expect((await f.service.execute(value.id)).status).toBe('failed'); expect(f.discord.members.get(memberId)!.roles).not.toContain(roleId); });
  it('rejects an overwrite delete whose declared target type disagrees with Discord state', async () => {
    const f = fixture(); f.discord.setOverwrite(roleId, { id: roleId, type: 0, allow: permissions, deny: '0' });
    const policy = PolicyConfigSchema.parse({ guilds: { [guildId]: { operations: ['overwrite.delete'], channelIds: [channelId], memberIds: [roleId], protectedRoleIds: [roleId] } } });
    const service = new PlanningExecutionService({ discord: f.discord, operations: f.operations, policy, audit: { append: () => undefined } });
    await expect(service.propose({ ...common, type: 'overwrite.delete', channelId, targetId: roleId, targetType: 'member' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
  it('rejects a protected target', async () => { const f = fixture(); const policy = PolicyConfigSchema.parse({ ...basePolicy, protectedMemberIds: [memberId] }); const service = new PlanningExecutionService({ discord: f.discord, operations: f.operations, policy, audit: { append: () => undefined } }); await expect(service.propose(actions[0]!.action)).rejects.toMatchObject({ code: 'POLICY_DENIED' }); });
});

const structPolicy = PolicyConfigSchema.parse({
  guilds: { [guildId]: {
    autonomous: true, trackCreatedRoles: true, trackCreatedChannels: true,
    operations: ['role.add', 'role.remove', 'role.create', 'role.update', 'role.delete', 'role.reorder', 'member.timeout', 'member.untimeout', 'member.ban', 'member.unban', 'overwrite.upsert', 'overwrite.delete', 'channel.create', 'channel.update', 'channel.delete', 'channel.reorder', 'message.send'],
    roleIds: [roleId, guildId], channelIds: [channelId, categoryId], memberIds: [memberId],
    allowedPermissionBits: permissions, maxBanDeleteMessageSeconds: 60,
  } },
});
function structDiscord(): FakeDiscord { const discord = new FakeDiscord(); discord.roles.find((role) => role.id === botRoleId)!.permissions = structPermissions; return discord; }
function structFixture(discord = structDiscord(), audit: { append(event: AuditEvent): void } = { append: () => undefined }, policy = structPolicy) {
  const operations = new InMemoryOperationStore(); const created = new InMemoryCreatedResourceStore();
  const service = new PlanningExecutionService({ discord, operations, policy, created, audit, now: () => new Date('2025-01-01T00:00:00Z'), verificationDelayMs: 0 });
  return { discord, operations, created, service };
}

describe('structural actions in autonomous mode', () => {
  const roleAdd = { ...common, type: 'role.add' as const, memberId, roleId };
  const structural: { action: Action }[] = [
    { action: { ...common, type: 'role.create', name: 'Moderator', color: 0xFF0000, hoist: true, mentionable: false } },
    { action: { ...common, type: 'role.update', roleId, name: 'Renamed', color: 0x00FF00, hoist: false, mentionable: true } },
    { action: { ...common, type: 'role.delete', roleId } },
    { action: { ...common, type: 'role.reorder', roleId, position: 5 } },
    { action: { ...common, type: 'channel.create', name: 'announcements', channelType: 'text', parentId: categoryId } },
    { action: { ...common, type: 'channel.update', channelId, name: 'renamed-general', parentId: null } },
    { action: { ...common, type: 'channel.delete', channelId } },
    { action: { ...common, type: 'channel.reorder', channelId, position: 3 } },
    { action: { ...common, type: 'message.send', channelId, mentionEveryone: false, allowedMentions: [], embed: { title: 'Welcome', description: 'Rules below', color: 0, fields: [] } } },
  ];
  for (const entry of structural) it(`previews, executes and verifies ${entry.action.type} without human approval`, async () => {
    const f = structFixture(); const result = await f.service.executeAutonomous(entry.action);
    expect(result.plan.diff.length).toBeGreaterThan(0);
    expect(result.operation.status).toBe('succeeded');
  });

  it('refuses a role move that would place the role at or above the bot highest role', async () => {
    const f = structFixture();
    await expect(f.service.executeAutonomous({ ...common, type: 'role.reorder', roleId, position: 10 })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(f.discord.roles.find((role) => role.id === roleId)!.position).toBe(2);
    expect((await f.service.executeAutonomous({ ...common, type: 'role.reorder', roleId, position: 9 })).operation.status).toBe('succeeded');
  });

  it('refuses autonomous execution when the guild is not marked autonomous', async () => {
    const policy = PolicyConfigSchema.parse({ guilds: { [guildId]: { operations: ['role.add'], roleIds: [roleId], memberIds: [memberId] } } });
    const f = structFixture(new FakeDiscord(), { append: () => undefined }, policy);
    await expect(f.service.executeAutonomous(roleAdd)).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('records an autonomous_approved audit event before execution', async () => {
    const events: AuditEvent[] = []; const f = structFixture(structDiscord(), { append: (event) => events.push(event) });
    await f.service.executeAutonomous(roleAdd);
    expect(events.some((event) => event.event === 'autonomous_approved')).toBe(true);
    expect(events.some((event) => event.event === 'succeeded')).toBe(true);
  });

  it('tracks created channels so follow-up management needs no policy edit', async () => {
    const f = structFixture();
    const created = await f.service.executeAutonomous({ ...common, type: 'channel.create', name: 'staff-lounge', channelType: 'text', parentId: categoryId });
    const tracked = f.created.list(guildId).channels;
    expect(tracked).toHaveLength(1);
    const followUp = await f.service.executeAutonomous({ ...common, type: 'channel.update', channelId: tracked[0]!, name: 'staff-lounge-v2', parentId: categoryId });
    expect(followUp.operation.status).toBe('succeeded');
    expect(created.operation.action).toHaveProperty('clientNonce');
  });

  it('tracks created roles so they can be updated and assigned without policy edits', async () => {
    const f = structFixture();
    await f.service.executeAutonomous({ ...common, type: 'role.create', name: 'VIP', color: 0x0000FF, hoist: false, mentionable: false });
    const tracked = f.created.list(guildId).roles;
    expect(tracked).toHaveLength(1);
    const updated = await f.service.executeAutonomous({ ...common, type: 'role.update', roleId: tracked[0]!, name: 'VIP+', color: 0x0000FF, hoist: false, mentionable: false });
    expect(updated.operation.status).toBe('succeeded');
  });

  it('still supports the human-approval path for structural actions', async () => {
    const f = structFixture();
    const proposed = await f.service.propose({ ...common, type: 'channel.create', name: 'approved-channel', channelType: 'text', parentId: categoryId });
    const confirmation = f.service.requestConfirmation(proposed.operation.id, 1000);
    f.service.approve(proposed.operation.id, confirmation.id, proposed.plan.actionHash);
    expect((await f.service.execute(proposed.operation.id)).status).toBe('succeeded');
    expect(f.created.list(guildId).channels).toHaveLength(1);
  });

  it('fast path: no re-snapshot and no created-resource refetch on autonomous creates', async () => {
    const f = structFixture();
    let roleFetches = 0; let channelFetches = 0; let memberFetches = 0;
    const listRoles = f.discord.listGuildRoles.bind(f.discord); f.discord.listGuildRoles = async () => { roleFetches += 1; return listRoles(); };
    const listChannels = f.discord.listGuildChannels.bind(f.discord); f.discord.listGuildChannels = async () => { channelFetches += 1; return listChannels(); };
    const getMember = f.discord.getGuildMember.bind(f.discord); f.discord.getGuildMember = async (g, id) => { memberFetches += 1; return getMember(g, id); };
    const result = await f.service.executeAutonomous({ ...common, type: 'channel.create', name: 'speed-test', channelType: 'text', parentId: categoryId });
    expect(result.operation.status).toBe('succeeded');
    expect(roleFetches).toBe(1);      // plan snapshot only; no re-snapshot, no tracking refetch
    expect(memberFetches).toBe(1);    // bot member read once in the plan snapshot
    expect(channelFetches).toBe(2);   // plan snapshot + postcondition verification
    expect(f.created.list(guildId).channels).toHaveLength(1); // tracked directly from the mutation response
  });

  it('fails a create cleanly when preflight denies the parent', async () => {
    const policy = PolicyConfigSchema.parse({ guilds: { [guildId]: { autonomous: true, trackCreatedChannels: true, operations: ['channel.create'], channelIds: [], allowedPermissionBits: permissions } } });
    const f = structFixture(structDiscord(), { append: () => undefined }, policy);
    await expect(f.service.executeAutonomous({ ...common, type: 'channel.create', name: 'orphan', channelType: 'text', parentId: categoryId })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
