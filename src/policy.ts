import { z } from 'zod';
import { DomainError } from './errors.js';
import { ActionTypeSchema, SnowflakeSchema, type Action, type ActionType } from './domain.js';

const permissionString = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const GuildPolicySchema = z.object({
  operations: z.array(ActionTypeSchema).max(17).default([]),
  /** When true, the AI may plan AND execute authorized operations without per-action human approval. */
  autonomous: z.boolean().default(false),
  /** When true, roles created by this bot are automatically authorized as role targets. */
  trackCreatedRoles: z.boolean().default(false),
  /** When true, channels created by this bot are automatically authorized as channel targets. */
  trackCreatedChannels: z.boolean().default(false),
  roleIds: z.array(SnowflakeSchema).default([]),
  channelIds: z.array(SnowflakeSchema).default([]),
  memberIds: z.array(SnowflakeSchema).default([]),
  protectedMemberIds: z.array(SnowflakeSchema).default([]),
  protectedRoleIds: z.array(SnowflakeSchema).default([]),
  allowedPermissionBits: permissionString.default('0'),
  maxTimeoutSeconds: z.number().int().positive().max(2_419_200).default(2_419_200),
  maxBanDeleteMessageSeconds: z.number().int().min(0).max(604_800).default(0),
}).strict();

export const PolicyConfigSchema = z.object({
  guilds: z.record(SnowflakeSchema, GuildPolicySchema).default({}),
  protectedMemberIds: z.array(SnowflakeSchema).default([]),
  protectedRoleIds: z.array(SnowflakeSchema).default([]),
}).strict();
export type PolicyConfig = z.infer<typeof PolicyConfigSchema>;

export type PolicyDecision = Readonly<{ allowed: true } | { allowed: false; reason: string }>;
const denied = (reason: string): PolicyDecision => Object.freeze({ allowed: false, reason });

export interface CreatedResources { readonly roleIds: readonly string[]; readonly channelIds: readonly string[] }
export const noCreatedResources: CreatedResources = Object.freeze({ roleIds: Object.freeze([]), channelIds: Object.freeze([]) });

/** Deterministic and deny-by-default. Empty allowlists grant nothing. */
export function evaluatePolicy(policyInput: PolicyConfig, action: Action, now = new Date(), created: CreatedResources = noCreatedResources): PolicyDecision {
  const policy = PolicyConfigSchema.parse(policyInput);
  const guild = policy.guilds[action.guildId];
  if (guild === undefined) return denied('Guild is not authorized');
  if (!guild.operations.includes(action.type)) return denied('Operation is not authorized');

  if ('memberId' in action) {
    if (policy.protectedMemberIds.includes(action.memberId) || guild.protectedMemberIds.includes(action.memberId)) return denied('Member is protected');
    if (!guild.memberIds.includes(action.memberId)) return denied('Member target is not authorized');
  }
  if ('roleId' in action) {
    if (policy.protectedRoleIds.includes(action.roleId) || guild.protectedRoleIds.includes(action.roleId)) return denied('Role is protected');
    const tracked = guild.trackCreatedRoles && created.roleIds.includes(action.roleId);
    if (!tracked && !guild.roleIds.includes(action.roleId)) return denied('Role target is not authorized');
  }
  if ('channelId' in action) {
    const tracked = guild.trackCreatedChannels && created.channelIds.includes(action.channelId);
    if (!tracked && !guild.channelIds.includes(action.channelId)) return denied('Channel target is not authorized');
  }
  if (action.type === 'channel.create' && action.parentId !== undefined) {
    const trackedParent = guild.trackCreatedChannels && created.channelIds.includes(action.parentId);
    if (!trackedParent && !guild.channelIds.includes(action.parentId)) return denied('Parent channel target is not authorized');
  }
  if (action.type === 'channel.update' && action.parentId !== null) {
    const trackedParent = guild.trackCreatedChannels && created.channelIds.includes(action.parentId);
    if (!trackedParent && !guild.channelIds.includes(action.parentId)) return denied('Parent channel target is not authorized');
  }
  if ('targetType' in action) {
    if (action.targetType === 'member') {
      if (policy.protectedMemberIds.includes(action.targetId) || guild.protectedMemberIds.includes(action.targetId)) return denied('Member is protected');
      if (!guild.memberIds.includes(action.targetId)) return denied('Overwrite member target is not authorized');
    } else {
      if (policy.protectedRoleIds.includes(action.targetId) || guild.protectedRoleIds.includes(action.targetId)) return denied('Role is protected');
      const tracked = guild.trackCreatedRoles && created.roleIds.includes(action.targetId);
      if (!tracked && !guild.roleIds.includes(action.targetId)) return denied('Overwrite role target is not authorized');
    }
  }
  if (action.type === 'overwrite.upsert') {
    const used = BigInt(action.allow) | BigInt(action.deny);
    if ((used & ~BigInt(guild.allowedPermissionBits)) !== 0n) return denied('Permission bits are not authorized');
  }
  if (action.type === 'member.ban' && action.deleteMessageSeconds > guild.maxBanDeleteMessageSeconds) return denied('Ban delete-message limit exceeded');
  if (action.type === 'member.timeout') {
    const seconds = (Date.parse(action.until) - now.getTime()) / 1000;
    if (seconds <= 0 || seconds > guild.maxTimeoutSeconds) return denied('Timeout duration is not authorized');
  }
  return Object.freeze({ allowed: true });
}

export function assertPolicy(policy: PolicyConfig, action: Action, now?: Date, created: CreatedResources = noCreatedResources): void {
  const decision = evaluatePolicy(policy, action, now, created);
  if (!decision.allowed) throw new DomainError('POLICY_DENIED', decision.reason, { actionType: action.type, guildId: action.guildId });
}

export function permitsOperation(policy: PolicyConfig, guildId: string, operation: ActionType): boolean {
  const result = PolicyConfigSchema.safeParse(policy);
  return result.success && result.data.guilds[guildId]?.operations.includes(operation) === true;
}
