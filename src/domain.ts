import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/** Discord IDs are unsigned decimal snowflakes. Strings avoid precision loss. */
export const SnowflakeSchema = z.string().regex(/^[1-9][0-9]{0,19}$/, 'Invalid Discord snowflake').refine(
  (value) => /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18_446_744_073_709_551_615n,
  'Discord snowflake exceeds uint64',
);
export type Snowflake = z.infer<typeof SnowflakeSchema> & { readonly __brand: 'Snowflake' };

export const ActionTypeSchema = z.enum([
  'role.add',
  'role.remove',
  'role.create',
  'role.update',
  'role.delete',
  'role.reorder',
  'member.timeout',
  'member.untimeout',
  'member.ban',
  'member.unban',
  'overwrite.upsert',
  'overwrite.delete',
  'channel.create',
  'channel.update',
  'channel.delete',
  'channel.reorder',
  'message.send',
]);
export type ActionType = z.infer<typeof ActionTypeSchema>;
export const RiskLevelSchema = z.enum(['low', 'medium', 'high']);
export const ReversibilitySchema = z.enum(['reversible', 'compensatable', 'irreversible']);

const AuditReasonSchema = z.string().trim().min(1).max(512).refine((value) => {
  try { return encodeURIComponent(value).length <= 512; } catch { return false; }
}, 'URL-encoded audit reason exceeds Discord\'s 512-character limit');
const base = {
  guildId: SnowflakeSchema,
  reason: AuditReasonSchema,
};
const roleNameSchema = z.string().trim().min(1).max(100);
const clientNonceSchema = z.string().uuid();
const channelNameSchema = z.string().trim().min(1).max(100);
const channelTypeSchema = z.enum(['text', 'voice', 'category', 'announcement', 'stage', 'forum', 'media']);
const allowedMentionSchema = z.enum(['everyone']);
const embedFieldSchema = z.object({ name: z.string().trim().min(1).max(256), value: z.string().trim().min(1).max(1_024), inline: z.boolean().default(false) }).strict();
const staffReportEmbedSchema = z.object({
  title: z.string().trim().min(1).max(256),
  description: z.string().trim().min(1).max(4_096),
  color: z.number().int().min(0).max(0xFF_FF_FF),
  fields: z.array(embedFieldSchema).max(10).default([]),
}).strict();

const roleAction = z.object({ ...base, type: z.enum(['role.add', 'role.remove']), memberId: SnowflakeSchema, roleId: SnowflakeSchema }).strict();
const roleCreateAction = z.object({ ...base, type: z.literal('role.create'), clientNonce: clientNonceSchema.optional(), name: roleNameSchema, color: z.number().int().min(0).max(0xFF_FF_FF), hoist: z.boolean(), mentionable: z.boolean() }).strict();
const roleUpdateAction = z.object({ ...base, type: z.literal('role.update'), roleId: SnowflakeSchema, name: roleNameSchema, color: z.number().int().min(0).max(0xFF_FF_FF), hoist: z.boolean(), mentionable: z.boolean() }).strict();
const roleDeleteAction = z.object({ ...base, type: z.literal('role.delete'), roleId: SnowflakeSchema }).strict();
const roleReorderAction = z.object({ ...base, type: z.literal('role.reorder'), roleId: SnowflakeSchema, position: z.number().int().min(1).max(250) }).strict();
const timeoutAction = z.object({ ...base, type: z.literal('member.timeout'), memberId: SnowflakeSchema, until: z.string().datetime({ offset: true }) }).strict();
const untimeoutAction = z.object({ ...base, type: z.literal('member.untimeout'), memberId: SnowflakeSchema }).strict();
const banAction = z.object({ ...base, type: z.literal('member.ban'), memberId: SnowflakeSchema, deleteMessageSeconds: z.number().int().min(0).max(604_800).default(0) }).strict();
const unbanAction = z.object({ ...base, type: z.literal('member.unban'), memberId: SnowflakeSchema }).strict();
const overwriteUpsertAction = z.object({
  ...base,
  type: z.literal('overwrite.upsert'),
  channelId: SnowflakeSchema,
  targetId: SnowflakeSchema,
  targetType: z.enum(['member', 'role']),
  allow: z.string().regex(/^(0|[1-9][0-9]*)$/),
  deny: z.string().regex(/^(0|[1-9][0-9]*)$/),
}).strict();
const overwriteDeleteAction = z.object({ ...base, type: z.literal('overwrite.delete'), channelId: SnowflakeSchema, targetId: SnowflakeSchema, targetType: z.enum(['member', 'role']) }).strict();
const channelCreateAction = z.object({ ...base, type: z.literal('channel.create'), clientNonce: clientNonceSchema.optional(), name: channelNameSchema, channelType: channelTypeSchema, parentId: SnowflakeSchema.optional() }).strict();
const channelUpdateAction = z.object({ ...base, type: z.literal('channel.update'), channelId: SnowflakeSchema, name: channelNameSchema, parentId: SnowflakeSchema.nullable() }).strict();
const channelDeleteAction = z.object({ ...base, type: z.literal('channel.delete'), channelId: SnowflakeSchema }).strict();
const channelReorderAction = z.object({ ...base, type: z.literal('channel.reorder'), channelId: SnowflakeSchema, position: z.number().int().min(0).max(500) }).strict();
const messageSendAction = z.object({
  ...base,
  type: z.literal('message.send'),
  channelId: SnowflakeSchema,
  clientNonce: clientNonceSchema.optional(),
  mentionEveryone: z.boolean(),
  allowedMentions: z.array(allowedMentionSchema).max(1),
  content: z.literal('@everyone').optional(),
  embed: staffReportEmbedSchema,
}).strict();

export const ActionSchema = z.discriminatedUnion('type', [roleAction, roleCreateAction, roleUpdateAction, roleDeleteAction, roleReorderAction, timeoutAction, untimeoutAction, banAction, unbanAction, overwriteUpsertAction, overwriteDeleteAction, channelCreateAction, channelUpdateAction, channelDeleteAction, channelReorderAction, messageSendAction]).superRefine((value, context) => {
  if (value.type === 'overwrite.upsert' && (BigInt(value.allow) & BigInt(value.deny)) !== 0n) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Permission bits cannot be both allowed and denied' });
  }
  if (value.type === 'channel.create' && value.channelType === 'category' && value.parentId !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A category cannot have a parent channel' });
  }
  if ((value.type === 'role.update' || value.type === 'role.delete' || value.type === 'role.reorder') && value.roleId === value.guildId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'The @everyone role cannot be changed' });
  }
  if (value.type === 'channel.update' && value.parentId === value.channelId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'A channel cannot be its own parent' });
  }
  if (value.type === 'message.send') {
    const permitsEveryone = value.allowedMentions.length === 1;
    if (value.mentionEveryone !== permitsEveryone) context.addIssue({ code: z.ZodIssueCode.custom, message: 'allowedMentions must match mentionEveryone' });
    if (value.mentionEveryone && value.content !== '@everyone') context.addIssue({ code: z.ZodIssueCode.custom, message: 'An @everyone mention requires exactly @everyone content' });
    if (!value.mentionEveryone && value.content !== undefined) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Message content is only permitted for an explicit @everyone mention' });
  }
});
export type Action = z.infer<typeof ActionSchema>;

function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value) && Number.isInteger(value)) throw new TypeError('Canonical JSON does not support non-finite or unsafe integer numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError('Canonical JSON does not support cycles');
    seen.add(value);
    const result = value.map((item) => normalize(item, seen));
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) throw new TypeError('Canonical JSON does not support cycles');
    const prototype: object | null = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError('Canonical JSON supports plain objects only');
    seen.add(value);
    const object = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      if (object[key] === undefined) throw new TypeError('Canonical JSON does not support undefined');
      result[key] = normalize(object[key], seen);
    }
    seen.delete(value);
    return result;
  }
  throw new TypeError('Canonical JSON supports JSON values only');
}

/** Stable, key-sorted JSON used as the sole hash input. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new Set()));
}

export function actionHash(action: Action): string {
  const parsed = ActionSchema.parse(action);
  return createHash('sha256').update(canonicalJson(parsed), 'utf8').digest('hex');
}

/** Parse, normalize defaults, and deeply freeze an action. Missing client nonces are generated so every create action has a stable idempotency key. */
export function parseAction(value: unknown): Readonly<Action> {
  const action = ActionSchema.parse(value);
  const completed = action.type === 'role.create' || action.type === 'channel.create' || action.type === 'message.send'
    ? { ...action, clientNonce: action.clientNonce ?? randomUUID() }
    : action;
  return Object.freeze(completed);
}

export function actionTargetKey(action: Action): string {
  switch (action.type) {
    // Lock the complete Discord resource represented by each exact preview. Role and
    // moderation actions can invalidate one another's member snapshot; overwrite
    // actions can invalidate category synchronization and channel permission state.
    case 'role.add': case 'role.remove':
    case 'member.timeout': case 'member.untimeout': case 'member.ban': case 'member.unban': return `${action.guildId}:member:${action.memberId}`;
    case 'role.create': return `${action.guildId}:role-create:${action.clientNonce}`;
    case 'role.update': case 'role.delete': case 'role.reorder': return `${action.guildId}:role:${action.roleId}`;
    case 'overwrite.upsert': case 'overwrite.delete':
    case 'channel.update': case 'channel.delete': case 'channel.reorder': case 'message.send': return `${action.guildId}:channel:${action.channelId}`;
    case 'channel.create': return `${action.guildId}:channel-create:${action.clientNonce}`;
  }
}
