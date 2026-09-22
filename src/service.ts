import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ActionSchema, actionHash, actionTargetKey, canonicalJson, parseAction, type Action } from './domain.js';
import { DiscordApiError, nonceForWire, type DiscordBan, type DiscordChannel, type DiscordGuild, type DiscordMember, type DiscordMessage, type DiscordRole, type DiscordUser } from './discord.js';
import { DomainError } from './errors.js';
import { assertPolicy, evaluatePolicy, type CreatedResources, type PolicyConfig } from './policy.js';
import { ConfirmationStore, TargetLockManager, withFileStoreLock, writeAtomicFile, type AuditEvent, type Confirmation, type Operation, type OperationStore } from './persistence.js';

const ADMINISTRATOR = 1n << 3n;
const BAN_MEMBERS = 1n << 2n;
const MANAGE_CHANNELS = 1n << 4n;
const VIEW_CHANNEL = 1n << 10n;
const SEND_MESSAGES = 1n << 11n;
const MENTION_EVERYONE = 1n << 17n;
const MANAGE_ROLES = 1n << 28n;
const MODERATE_MEMBERS = 1n << 40n;

export const StateDiffSchema = z.object({ path: z.string(), before: z.unknown(), after: z.unknown() }).strict();
export type StateDiff = z.infer<typeof StateDiffSchema>;
export interface CompensationMetadata { readonly available: boolean; readonly action?: Readonly<Action>; readonly note: string }
export interface ActionPlan {
  readonly action: Readonly<Action>;
  readonly actionHash: string;
  /** Hash of all Discord state on which the preview and preflight depend. */
  readonly stateHash: string;
  readonly risk: 'low' | 'medium' | 'high';
  readonly reversibility: 'reversible' | 'compensatable' | 'irreversible';
  readonly consequences: readonly string[];
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  readonly diff: readonly StateDiff[];
  readonly warnings: readonly string[];
  readonly preconditions: readonly string[];
  readonly compensation: CompensationMetadata;
}
export const ActionPlanSchema = z.object({
  action: ActionSchema, actionHash: z.string().regex(/^[a-f0-9]{64}$/), stateHash: z.string().regex(/^[a-f0-9]{64}$/),
  risk: z.enum(['low', 'medium', 'high']), reversibility: z.enum(['reversible', 'compensatable', 'irreversible']),
  consequences: z.array(z.string()), before: z.record(z.unknown()), after: z.record(z.unknown()), diff: z.array(StateDiffSchema),
  warnings: z.array(z.string()), preconditions: z.array(z.string()),
  compensation: z.object({ available: z.boolean(), action: ActionSchema.optional(), note: z.string() }).strict(),
}).strict().superRefine((plan, context) => {
  if (actionHash(plan.action) !== plan.actionHash) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Plan action hash does not match action' });
});

/** The deliberately narrow part of DiscordRestClient used by planning/execution. */
export interface ActionDiscordAdapter {
  getCurrentUser(): Promise<DiscordUser>;
  getGuild(guildId: string): Promise<DiscordGuild>;
  listGuildRoles(guildId: string): Promise<readonly DiscordRole[]>;
  getGuildMember(guildId: string, memberId: string): Promise<DiscordMember>;
  listGuildChannels(guildId: string): Promise<readonly DiscordChannel[]>;
  getGuildBan(guildId: string, memberId: string): Promise<DiscordBan>;
  addMemberRole(guildId: string, memberId: string, roleId: string, reason: string): Promise<void>;
  removeMemberRole(guildId: string, memberId: string, roleId: string, reason: string): Promise<void>;
  timeoutMember(guildId: string, memberId: string, until: string, reason: string): Promise<DiscordMember>;
  clearMemberTimeout(guildId: string, memberId: string, reason: string): Promise<DiscordMember>;
  banMember(guildId: string, memberId: string, deleteMessageSeconds: number, reason: string): Promise<void>;
  unbanMember(guildId: string, memberId: string, reason: string): Promise<void>;
  upsertChannelPermissionOverwrite(channelId: string, targetId: string, targetType: 'role' | 'member', allow: string, deny: string, reason: string): Promise<void>;
  deleteChannelPermissionOverwrite(channelId: string, targetId: string, reason: string): Promise<void>;
  createGuildRole(guildId: string, name: string, color: number, hoist: boolean, mentionable: boolean, reason: string): Promise<DiscordRole>;
  updateGuildRole(guildId: string, roleId: string, name: string, color: number, hoist: boolean, mentionable: boolean, reason: string): Promise<DiscordRole>;
  deleteGuildRole(guildId: string, roleId: string, reason: string): Promise<void>;
  reorderGuildRole(guildId: string, roleId: string, position: number, reason: string): Promise<void>;
  createGuildChannel(guildId: string, name: string, channelType: 'text' | 'voice' | 'category' | 'announcement' | 'stage' | 'forum' | 'media', parentId: string | undefined, reason: string): Promise<DiscordChannel>;
  updateChannel(channelId: string, name: string, parentId: string | null, reason: string): Promise<DiscordChannel>;
  deleteChannel(channelId: string, reason: string): Promise<void>;
  reorderGuildChannel(guildId: string, channelId: string, position: number, reason: string): Promise<void>;
  createMessage(channelId: string, payload: { readonly content?: string; readonly nonce?: string; readonly embeds: readonly Record<string, unknown>[]; readonly allowedMentions: readonly string[] }, reason: string): Promise<DiscordMessage>;
  getChannelMessages(channelId: string, limit: number): Promise<readonly DiscordMessage[]>;
}

export interface AuditSink { append(event: AuditEvent): void }
/** Resources created by this bot; autonomous mode uses them to authorize follow-up management. */
export interface CreatedResourceStore {
  list(guildId: string): Readonly<{ roles: readonly string[]; channels: readonly string[] }>;
  add(guildId: string, kind: 'role' | 'channel', id: string): void;
}
export class InMemoryCreatedResourceStore implements CreatedResourceStore {
  readonly #records = new Map<string, { roles: string[]; channels: string[] }>();
  public list(guildId: string): Readonly<{ roles: readonly string[]; channels: readonly string[] }> {
    const value = this.#records.get(guildId);
    return value === undefined ? { roles: [], channels: [] } : { roles: [...value.roles], channels: [...value.channels] };
  }
  public add(guildId: string, kind: 'role' | 'channel', id: string): void {
    const value = this.#records.get(guildId) ?? { roles: [], channels: [] };
    const list = kind === 'role' ? value.roles : value.channels;
    if (!list.includes(id)) list.push(id);
    this.#records.set(guildId, value);
  }
}
/** Durable implementations let separately-invoked CLI commands retain the approved preview. */
export interface ActionPlanStore {
  get(operationId: string): ActionPlan | undefined;
  set(operationId: string, plan: ActionPlan): void;
}
export class InMemoryActionPlanStore implements ActionPlanStore {
  protected readonly plans = new Map<string, ActionPlan>();
  public get(operationId: string): ActionPlan | undefined { return this.plans.get(operationId); }
  public set(operationId: string, plan: ActionPlan): void { this.plans.set(operationId, ActionPlanSchema.parse(plan) as unknown as ActionPlan); }
}
const actionPlanFileSchema = z.object({ plans: z.record(z.string().uuid(), ActionPlanSchema) }).strict();
/** Atomic, durable previews used by the multi-command human CLI. */
export class FileActionPlanStore extends InMemoryActionPlanStore {
  readonly #path: string;
  public constructor(path: string) { super(); this.#path = resolve(path); this.refresh(); }
  public override get(operationId: string): ActionPlan | undefined { this.refresh(); return super.get(operationId); }
  public override set(operationId: string, plan: ActionPlan): void {
    withFileStoreLock(this.#path, () => {
      this.refresh();
      try { super.set(operationId, plan); this.persist(); }
      catch (error) { this.refresh(); throw error; }
    });
  }
  private refresh(): void {
    this.plans.clear();
    if (!existsSync(this.#path)) return;
    let data: z.infer<typeof actionPlanFileSchema>;
    try { data = actionPlanFileSchema.parse(JSON.parse(readFileSync(this.#path, 'utf8'))); }
    catch { throw new DomainError('PERSISTENCE_CORRUPT', 'Action plan store is invalid'); }
    for (const [id, plan] of Object.entries(data.plans)) this.plans.set(id, plan as unknown as ActionPlan);
  }
  private persist(): void {
    try {
      writeAtomicFile(this.#path, canonicalJson({ plans: Object.fromEntries(this.plans) }));
    } catch { throw new DomainError('PERSISTENCE_WRITE_FAILED', 'Unable to persist action plans'); }
  }
}
export interface PlanningExecutionOptions {
  readonly discord: ActionDiscordAdapter;
  readonly policy: PolicyConfig;
  readonly operations: OperationStore;
  readonly confirmations?: ConfirmationStore;
  readonly audit: AuditSink;
  readonly locks?: TargetLockManager;
  readonly plans?: ActionPlanStore;
  readonly created?: CreatedResourceStore;
  readonly now?: () => Date;
  readonly verificationAttempts?: number;
  readonly verificationDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

interface Snapshot { readonly state: Record<string, unknown>; readonly warnings: string[]; readonly preconditions: string[] }

function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').sort() : []; }
function text(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function integer(value: unknown): number { return typeof value === 'number' && Number.isInteger(value) ? value : 0; }
function bits(value: unknown): bigint { try { return BigInt(typeof value === 'string' ? value : '0'); } catch { return 0n; } }
function object(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function notFound(error: unknown): boolean { return error instanceof DiscordApiError && error.status === 404; }
function stateHash(state: unknown): string { return actionHashLike(canonicalJson(state)); }
// Kept local to avoid treating a state snapshot as an Action.
function actionHashLike(value: string): string { return createHash('sha256').update(value).digest('hex'); }

function overwrite(channel: DiscordChannel, targetId: string): Record<string, unknown> | null {
  const values = Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : [];
  const found = values.map(object).find((item) => item.id === targetId);
  return found === undefined ? null : { id: targetId, type: found.type === 1 || found.type === '1' || found.type === 'member' ? 'member' : 'role', allow: text(found.allow) ?? '0', deny: text(found.deny) ?? '0' };
}
function sameOverwriteSet(left: DiscordChannel, right: DiscordChannel): boolean {
  const normalize = (channel: DiscordChannel): unknown[] => (Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : []).map(object).map((v) => ({ id: v.id, type: v.type, allow: text(v.allow) ?? '0', deny: text(v.deny) ?? '0' })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return canonicalJson(normalize(left)) === canonicalJson(normalize(right));
}

/** Discord's documented guild-channel overwrite order for a member. */
function channelPermissions(channel: DiscordChannel, guildId: string, memberId: string, memberRoleIds: ReadonlySet<string>, guildPermissions: bigint): bigint {
  if ((guildPermissions & ADMINISTRATOR) !== 0n) return guildPermissions;
  const values = (Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites : []).map(object);
  const apply = (current: bigint, entry: Record<string, unknown> | undefined): bigint => entry === undefined ? current : (current & ~bits(entry.deny)) | bits(entry.allow);
  let result = apply(guildPermissions, values.find((entry) => entry.id === guildId));
  let roleAllow = 0n; let roleDeny = 0n;
  for (const entry of values) if (typeof entry.id === 'string' && memberRoleIds.has(entry.id) && entry.id !== guildId) { roleAllow |= bits(entry.allow); roleDeny |= bits(entry.deny); }
  result = (result & ~roleDeny) | roleAllow;
  return apply(result, values.find((entry) => entry.id === memberId));
}

/** Plans deterministic previews and executes approved operations with fail-closed verification. */
export class PlanningExecutionService {
  readonly #discord: ActionDiscordAdapter; readonly #policy: PolicyConfig; readonly #operations: OperationStore;
  readonly #confirmations: ConfirmationStore; readonly #audit: AuditSink; readonly #locks: TargetLockManager;
  readonly #now: () => Date; readonly #attempts: number; readonly #delay: number; readonly #sleep: (ms: number) => Promise<void>;
  readonly #plans: ActionPlanStore; readonly #created: CreatedResourceStore;
  #botIdCache: string | undefined;

  public constructor(options: PlanningExecutionOptions) {
    this.#discord = options.discord; this.#policy = options.policy; this.#operations = options.operations;
    this.#confirmations = options.confirmations ?? new ConfirmationStore(); this.#audit = options.audit; this.#locks = options.locks ?? new TargetLockManager();
    this.#plans = options.plans ?? new InMemoryActionPlanStore(); this.#created = options.created ?? new InMemoryCreatedResourceStore();
    this.#now = options.now ?? (() => new Date()); this.#attempts = options.verificationAttempts ?? 3; this.#delay = options.verificationDelayMs ?? 100;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    if (!Number.isInteger(this.#attempts) || this.#attempts < 1 || this.#attempts > 10) throw new TypeError('verificationAttempts must be from 1 to 10');
  }

  #createdSets(guildId: string): CreatedResources {
    const value = this.#created.list(guildId);
    return { roleIds: value.roles, channelIds: value.channels };
  }

  /** The bot's own user ID never changes; cache it per process to save one Discord round trip per operation. */
  async #currentBotId(): Promise<string> {
    if (this.#botIdCache === undefined) this.#botIdCache = (await this.#discord.getCurrentUser()).id;
    return this.#botIdCache;
  }

  public async plan(input: unknown): Promise<ActionPlan> {
    const action = parseAction(input); assertPolicy(this.#policy, action, this.#now(), this.#createdSets(action.guildId));
    if (action.type === 'member.timeout') {
      const now = this.#now().getTime(); const until = Date.parse(action.until);
      if (until <= now || until > now + 28 * 24 * 60 * 60 * 1000) throw new DomainError('POLICY_DENIED', 'Timeout must end in the future and no more than 28 days from now');
    }
    const snapshot = await this.#snapshot(action, true);
    return this.#makePlan(action, snapshot);
  }

  public async propose(input: unknown): Promise<{ readonly operation: Operation; readonly plan: ActionPlan }> {
    const action = parseAction(input); const operation = this.#operations.create(action, this.#now());
    const decision = evaluatePolicy(this.#policy, action, this.#now(), this.#createdSets(action.guildId));
    if (!decision.allowed) {
      this.#auditEvent(operation, 'denied', { reason: decision.reason });
      this.#operations.transition(operation.id, 'proposed', 'failed', operation.version, decision.reason, this.#now());
      throw new DomainError('POLICY_DENIED', decision.reason, { operationId: operation.id });
    }
    let plan: ActionPlan;
    try { plan = await this.plan(action); }
    catch (error) {
      this.#auditEvent(operation, 'failed', { phase: 'planning' });
      this.#operations.transition(operation.id, 'proposed', 'failed', operation.version, 'Planning preflight failed', this.#now()); throw error;
    }
    this.#auditEvent(operation, 'proposed', { stateHash: plan.stateHash, diff: plan.diff, warnings: plan.warnings });
    this.#plans.set(operation.id, plan); return { operation, plan };
  }

  /** Autonomous mode: plan and execute one action in a single step when the guild is marked autonomous. */
  public async executeAutonomous(input: unknown): Promise<{ readonly operation: Operation; readonly plan: ActionPlan }> {
    const action = parseAction(input);
    const guild = this.#policy.guilds[action.guildId];
    if (guild?.autonomous !== true) throw new DomainError('POLICY_DENIED', 'Autonomous execution requires the guild to be in autonomous mode');
    const decision = evaluatePolicy(this.#policy, action, this.#now(), this.#createdSets(action.guildId));
    if (!decision.allowed) throw new DomainError('POLICY_DENIED', decision.reason);
    const operation = this.#operations.create(action, this.#now());
    let plan: ActionPlan;
    try { plan = await this.plan(action); }
    catch (error) {
      this.#auditEvent(operation, 'failed', { phase: 'planning' });
      this.#operations.transition(operation.id, 'proposed', 'failed', operation.version, 'Planning preflight failed', this.#now()); throw error;
    }
    this.#auditEvent(operation, 'autonomous_approved', { mode: 'autonomous', stateHash: plan.stateHash, diff: plan.diff, warnings: plan.warnings });
    this.#operations.transition(operation.id, 'proposed', 'approved', operation.version, undefined, this.#now());
    this.#plans.set(operation.id, plan);
    const executed = await this.execute(operation.id, { verifyState: false });
    return { operation: executed, plan };
  }

  public requestConfirmation(operationId: string, ttlMs: number): Confirmation {
    const operation = this.#required(operationId); return this.#confirmations.issue(operation, ttlMs, this.#now());
  }

  public approve(operationId: string, confirmationId: string, suppliedHash: string): Operation {
    const operation = this.#required(operationId);
    // Approval is not usable unless its append-only evidence can be persisted. Consume
    // the one-time proof before recording approval so an invalid proof can never create
    // a false audit event. An audit failure safely leaves the operation proposed.
    this.#confirmations.consume(confirmationId, operation, suppliedHash, this.#now());
    this.#auditEvent(operation, 'approval_requested');
    const approved = this.#operations.transition(operation.id, 'proposed', 'approved', operation.version, undefined, this.#now());
    this.#auditEvent(approved, 'approved'); return approved;
  }

  public async execute(operationId: string, options: { readonly verifyState?: boolean } = {}): Promise<Operation> {
    const initial = this.#required(operationId);
    return this.#locks.withLock(actionTargetKey(initial.action), async () => {
      const approved = this.#required(operationId);
      if (approved.status !== 'approved') throw new DomainError('OPERATION_CONFLICT', 'Operation is not approved');
      try { assertPolicy(this.#policy, approved.action, this.#now(), this.#createdSets(approved.action.guildId)); }
      catch (error) { return this.#failBeforeMutation(approved, error instanceof Error ? error.message : 'Policy revalidation failed'); }
      const originalPlan = this.#plans.get(operationId);
      if (originalPlan === undefined) return this.#failBeforeMutation(approved, 'Approved operation has no retained state preview');
      if (originalPlan.actionHash !== approved.actionHash) return this.#failBeforeMutation(approved, 'Retained preview does not match the approved action');
      // The state-drift re-snapshot guards the human-approval path where state can change
      // while the operator decides. Autonomous mode plans and executes back-to-back, so it
      // skips the redundant snapshot; postcondition verification still fails closed.
      if (options.verifyState !== false) {
        let current: Snapshot;
        try { current = await this.#snapshot(approved.action, true); }
        catch (error) { return this.#failBeforeMutation(approved, error instanceof Error ? error.message : 'Preflight failed'); }
        if (stateHash(current.state) !== originalPlan.stateHash) return this.#failBeforeMutation(approved, 'Discord state changed since approval');
      }
      const executing = this.#operations.transition(approved.id, 'approved', 'executing', approved.version, undefined, this.#now());
      try { this.#auditEvent(executing, 'attempted', { stateHash: originalPlan.stateHash }); }
      catch { return this.#operations.transition(executing.id, 'executing', 'failed', executing.version, 'Audit write failed before mutation', this.#now()); }
      const sideEffectWithoutStateDiff = executing.action.type === 'member.ban' && executing.action.deleteMessageSeconds > 0;
      if (originalPlan.diff.length === 0 && !sideEffectWithoutStateDiff) return this.#finish(executing, 'succeeded', undefined, { noOp: true, compensation: originalPlan.compensation });
      let createdId: string | undefined;
      try { createdId = await this.#mutate(executing.action); }
      catch (error) {
        const uncertain = error instanceof DiscordApiError && error.uncertain;
        return this.#finish(executing, uncertain ? 'uncertain' : 'failed', uncertain ? 'Discord response was uncertain; manual reconciliation required' : 'Discord mutation failed', { phase: 'mutation' });
      }
      this.#trackCreated(executing.action, createdId);
      let matched = false;
      try {
        for (let attempt = 0; attempt < this.#attempts; attempt += 1) {
          if (await this.#verify(executing.action, originalPlan.after, createdId)) { matched = true; break; }
          if (attempt + 1 < this.#attempts) await this.#sleep(this.#delay);
        }
      } catch { /* an unreadable result cannot be asserted */ }
      if (!matched) return this.#finish(executing, 'uncertain', 'Postcondition mismatch; manual reconciliation required', { expected: originalPlan.after, compensation: originalPlan.compensation });
      return this.#finish(executing, 'succeeded', undefined, { compensation: originalPlan.compensation });
    });
  }

  /** Marks a crash-interrupted execution uncertain after the operator has stopped all writers. */
  public recoverInterrupted(operationId: string, note: string): Operation {
    const operation = this.#required(operationId);
    if (operation.status !== 'executing') throw new DomainError('OPERATION_CONFLICT', 'Only executing operations can be recovered as uncertain');
    if (note.trim() === '') throw new TypeError('A recovery note is required');
    this.#auditEvent(operation, 'recovery_requested', { note });
    const uncertain = this.#operations.transition(operation.id, 'executing', 'uncertain', operation.version, 'Interrupted execution requires manual reconciliation', this.#now());
    this.#auditEvent(uncertain, 'uncertain', { recovery: 'interrupted-process', note }); return uncertain;
  }

  /** Records an operator's authoritative reconciliation of an uncertain result. */
  public reconcile(operationId: string, outcome: 'succeeded' | 'failed', note: string): Operation {
    const operation = this.#required(operationId);
    if (operation.status !== 'uncertain') throw new DomainError('OPERATION_CONFLICT', 'Only uncertain operations can be reconciled');
    if (note.trim() === '') throw new TypeError('A reconciliation note is required');
    this.#auditEvent(operation, 'reconciliation_requested', { requestedOutcome: outcome, note });
    const reconciled = this.#operations.transition(operation.id, 'uncertain', outcome, operation.version, outcome === 'failed' ? note : undefined, this.#now());
    this.#auditEvent(reconciled, outcome, { reconciliation: 'manual', note }); return reconciled;
  }

  #required(id: string): Operation { const operation = this.#operations.get(id); if (operation === undefined) throw new DomainError('OPERATION_NOT_FOUND', 'Operation not found'); return operation; }
  #auditEvent(operation: Operation, event: AuditEvent['event'], details?: Record<string, unknown>): void {
    this.#audit.append({ timestamp: this.#now().toISOString(), event, operationId: operation.id, actionHash: operation.actionHash, ...(details === undefined ? {} : { details }) });
  }
  #failBeforeMutation(operation: Operation, message: string): Operation {
    this.#auditEvent(operation, 'failed', { phase: 'preflight', reason: message });
    return this.#operations.transition(operation.id, 'approved', 'failed', operation.version, message.slice(0, 1000), this.#now());
  }
  #finish(operation: Operation, status: 'succeeded' | 'failed' | 'uncertain', error?: string, details?: Record<string, unknown>): Operation {
    // Persist evidence before claiming success. If that write fails, the mutation's outcome
    // requires reconciliation and the store remains able to transition from executing.
    try { this.#auditEvent(operation, status, details); }
    catch {
      return this.#operations.transition(operation.id, 'executing', 'uncertain', operation.version, 'Audit write failed after mutation; manual reconciliation required', this.#now());
    }
    return this.#operations.transition(operation.id, 'executing', status, operation.version, error, this.#now());
  }

  async #snapshot(action: Action, enforcePreflight: boolean): Promise<Snapshot> {
    const botId = await this.#currentBotId();
    const [guild, roles, bot] = await Promise.all([this.#discord.getGuild(action.guildId), this.#discord.listGuildRoles(action.guildId), this.#discord.getGuildMember(action.guildId, botId)]);
    const botRoleIds = new Set(strings(bot.roles)); let permissions = 0n; let botTop = 0;
    for (const role of roles) if (role.id === action.guildId || botRoleIds.has(role.id)) { permissions |= bits(role.permissions); botTop = Math.max(botTop, integer(role.position)); }
    const administrator = (permissions & ADMINISTRATOR) !== 0n; const required = action.type === 'message.send' ? (VIEW_CHANNEL | SEND_MESSAGES | (action.mentionEveryone ? MENTION_EVERYONE : 0n)) : action.type.startsWith('channel.') ? MANAGE_CHANNELS : action.type.startsWith('role.') || action.type.startsWith('overwrite.') ? MANAGE_ROLES : action.type.includes('timeout') ? MODERATE_MEMBERS : BAN_MEMBERS;
    if (enforcePreflight && !administrator && (permissions & required) === 0n) throw new DomainError('POLICY_DENIED', 'Bot lacks the Discord permission required by this action');
    const preconditions = [`bot permission ${required.toString()} is present`]; const warnings: string[] = [];
    const base: Record<string, unknown> = { botId, botTopRolePosition: botTop, botPermissions: permissions.toString(), guildOwnerId: text(guild.owner_id), guildId: action.guildId };

    if (action.type === 'role.add' || action.type === 'role.remove') {
      const [member] = await Promise.all([this.#discord.getGuildMember(action.guildId, action.memberId)]); const role = roles.find((item) => item.id === action.roleId);
      if (role === undefined) throw new DomainError('POLICY_DENIED', 'Target role does not exist');
      const targetTop = Math.max(0, ...roles.filter((item) => strings(member.roles).includes(item.id)).map((item) => integer(item.position)));
      if (enforcePreflight && (role.managed === true || (guild.owner_id !== botId && (botTop <= integer(role.position) || action.memberId === guild.owner_id || botTop <= targetTop)))) throw new DomainError('POLICY_DENIED', 'Discord role hierarchy prevents this action');
      return { state: { ...base, memberId: action.memberId, memberRoles: strings(member.roles), targetTopRolePosition: targetTop, roleId: role.id, rolePosition: integer(role.position), roleManaged: role.managed === true }, warnings, preconditions: [...preconditions, 'bot role is above target role and member'] };
    }
    if (action.type === 'member.timeout' || action.type === 'member.untimeout' || action.type === 'member.ban') {
      const member = await this.#discord.getGuildMember(action.guildId, action.memberId); const memberRoleIds = new Set(strings(member.roles));
      let targetPermissions = 0n; let targetTop = 0;
      for (const role of roles) if (role.id === action.guildId || memberRoleIds.has(role.id)) { targetPermissions |= bits(role.permissions); targetTop = Math.max(targetTop, integer(role.position)); }
      const targetAdministrator = (targetPermissions & ADMINISTRATOR) !== 0n;
      if (enforcePreflight && guild.owner_id !== botId && (action.memberId === guild.owner_id || action.memberId === botId || botTop <= targetTop)) throw new DomainError('POLICY_DENIED', 'Discord member hierarchy prevents this action');
      if (enforcePreflight && action.type.includes('timeout') && targetAdministrator) throw new DomainError('POLICY_DENIED', 'Discord does not permit timing out an administrator');
      let banned = false; if (action.type === 'member.ban') { try { await this.#discord.getGuildBan(action.guildId, action.memberId); banned = true; } catch (error) { if (!notFound(error)) throw error; } }
      return { state: { ...base, memberId: action.memberId, targetTopRolePosition: targetTop, targetPermissions: targetPermissions.toString(), timeoutUntil: timestamp(member.communication_disabled_until), banned }, warnings, preconditions: [...preconditions, 'bot role is above target member', ...(action.type.includes('timeout') ? ['target is not an administrator'] : [])] };
    }
    if (action.type === 'member.unban') {
      let banned = true; try { await this.#discord.getGuildBan(action.guildId, action.memberId); } catch (error) { if (notFound(error)) banned = false; else throw error; }
      return { state: { ...base, memberId: action.memberId, banned }, warnings, preconditions };
    }
    if (action.type === 'role.create') {
      const names = roles.map((role) => text(role.name));
      if (names.includes(action.name)) warnings.push(`A role named "${action.name}" already exists; Discord will create a duplicate.`);
      return { state: { ...base, roleNames: names }, warnings, preconditions: [...preconditions, 'bot can manage roles in the guild'] };
    }
    if (action.type === 'role.update' || action.type === 'role.delete' || action.type === 'role.reorder') {
      const role = roles.find((item) => item.id === action.roleId);
      if (role === undefined) throw new DomainError('POLICY_DENIED', 'Target role does not exist');
      if (enforcePreflight && (role.managed === true || (guild.owner_id !== botId && botTop <= integer(role.position)))) throw new DomainError('POLICY_DENIED', 'Discord role hierarchy prevents this action');
      // Discord also rejects a move that would place the role at or above the bot's highest role position.
      if (enforcePreflight && action.type === 'role.reorder' && guild.owner_id !== botId && action.position >= botTop) throw new DomainError('POLICY_DENIED', 'Discord role hierarchy prevents this action');
      return { state: { ...base, roleId: role.id, roleName: text(role.name), roleColor: integer(role.color), roleHoist: role.hoist === true, roleMentionable: role.mentionable === true, rolePosition: integer(role.position), roleManaged: role.managed === true }, warnings, preconditions: [...preconditions, 'bot role is above target role'] };
    }
    if (action.type === 'channel.create') {
      const channels = await this.#discord.listGuildChannels(action.guildId);
      const names = channels.map((channel) => text(channel.name));
      if (names.includes(action.name)) warnings.push(`A channel named "${action.name}" already exists; Discord will create a duplicate.`);
      if (action.parentId !== undefined) {
        const parent = channels.find((item) => item.id === action.parentId);
        if (parent === undefined) throw new DomainError('POLICY_DENIED', 'Parent channel does not exist');
        if (enforcePreflight && action.channelType !== 'category' && integer(parent.type) !== 4) throw new DomainError('POLICY_DENIED', 'Parent must be a category channel');
      }
      return { state: { ...base, channelNames: names }, warnings, preconditions: [...preconditions, 'bot can manage channels in the guild'] };
    }
    if (action.type === 'channel.update' || action.type === 'channel.delete' || action.type === 'channel.reorder') {
      const channels = await this.#discord.listGuildChannels(action.guildId); const channel = channels.find((item) => item.id === action.channelId);
      if (channel === undefined) throw new DomainError('POLICY_DENIED', 'Target channel does not exist');
      if (action.type === 'channel.update' && action.parentId !== null) {
        const parent = channels.find((item) => item.id === action.parentId);
        if (parent === undefined) throw new DomainError('POLICY_DENIED', 'Parent channel does not exist');
        if (enforcePreflight && integer(parent.type) !== 4) throw new DomainError('POLICY_DENIED', 'Parent must be a category channel');
      }
      return { state: { ...base, channelId: channel.id, channelName: text(channel.name), channelType: integer(channel.type), parentId: text(channel.parent_id), channelPosition: integer(channel.position) }, warnings, preconditions: [...preconditions, 'bot can manage channels in the guild'] };
    }
    if (action.type === 'message.send') {
      const channels = await this.#discord.listGuildChannels(action.guildId); const channel = channels.find((item) => item.id === action.channelId);
      if (channel === undefined) throw new DomainError('POLICY_DENIED', 'Target channel does not exist');
      const effectivePermissions = channelPermissions(channel, action.guildId, botId, botRoleIds, permissions);
      if (enforcePreflight && !administrator && (effectivePermissions & (VIEW_CHANNEL | SEND_MESSAGES)) !== (VIEW_CHANNEL | SEND_MESSAGES)) throw new DomainError('POLICY_DENIED', 'Bot cannot send messages in the target channel');
      if (enforcePreflight && action.mentionEveryone && !administrator && (effectivePermissions & MENTION_EVERYONE) === 0n) throw new DomainError('POLICY_DENIED', 'Bot cannot mention @everyone in the target channel');
      const sendWarnings = action.mentionEveryone ? [...warnings, 'This message will mention @everyone.'] : warnings;
      return { state: { ...base, channelId: channel.id, channelName: text(channel.name), botEffectiveChannelPermissions: effectivePermissions.toString() }, warnings: sendWarnings, preconditions: [...preconditions, 'bot can send messages in the target channel'] };
    }
    // The role.add|role.remove union member cannot be fully excluded by discriminant
    // narrowing, so this runtime guard is required before overwrite-only fields are read.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
    if (action.type !== 'overwrite.upsert' && action.type !== 'overwrite.delete') throw new DomainError('INTERNAL_ERROR', 'Unsupported action');
    const channels = await this.#discord.listGuildChannels(action.guildId); const channel = channels.find((item) => item.id === action.channelId);
    if (channel === undefined) throw new DomainError('POLICY_DENIED', 'Target channel does not exist');
    const effectivePermissions = channelPermissions(channel, action.guildId, botId, botRoleIds, permissions);
    if (enforcePreflight && !administrator && (effectivePermissions & MANAGE_ROLES) === 0n) throw new DomainError('POLICY_DENIED', 'A channel overwrite removes the bot permission required by this action');
    if (enforcePreflight && action.type === 'overwrite.upsert' && !administrator && ((BigInt(action.allow) | BigInt(action.deny)) & ~effectivePermissions) !== 0n) throw new DomainError('POLICY_DENIED', 'Bot cannot set channel permissions it does not have');
    const parent = channels.find((item) => item.id === channel.parent_id); const categorySynced = parent !== undefined && sameOverwriteSet(channel, parent);
    if (categorySynced) warnings.push('Channel permissions are synchronized with its category; this change will desynchronize them.');
    const currentOverwrite = overwrite(channel, action.targetId);
    if (enforcePreflight && currentOverwrite !== null && currentOverwrite.type !== action.targetType) throw new DomainError('POLICY_DENIED', 'Declared overwrite target type does not match Discord state');
    if (action.targetType === 'role') {
      const role = roles.find((item) => item.id === action.targetId);
      if (role === undefined) throw new DomainError('POLICY_DENIED', 'Overwrite target role does not exist');
      if (enforcePreflight && (role.managed === true || (guild.owner_id !== botId && botTop <= integer(role.position)))) throw new DomainError('POLICY_DENIED', 'Discord role hierarchy prevents this overwrite');
    } else {
      await this.#discord.getGuildMember(action.guildId, action.targetId);
    }
    return { state: { ...base, botEffectiveChannelPermissions: effectivePermissions.toString(), channelId: channel.id, parentId: text(channel.parent_id), categorySynced, targetId: action.targetId, overwrite: currentOverwrite }, warnings, preconditions: [...preconditions, 'bot has the required permission in the target channel'] };
  }

  #observable(action: Action, state: Record<string, unknown>): Record<string, unknown> {
    switch (action.type) {
      case 'role.add': case 'role.remove': return { roles: strings(state.memberRoles) };
      case 'member.timeout': case 'member.untimeout': return { timeoutUntil: state.timeoutUntil ?? null };
      case 'member.ban': case 'member.unban': return { banned: state.banned === true };
      case 'overwrite.upsert': case 'overwrite.delete': return { overwrite: state.overwrite ?? null };
      case 'role.create': return { createdRole: null };
      case 'role.update': case 'role.delete': return { role: state.roleName === undefined ? null : { id: state.roleId, name: state.roleName, color: state.roleColor, hoist: state.roleHoist, mentionable: state.roleMentionable } };
      case 'role.reorder': return { position: state.rolePosition ?? null };
      case 'channel.create': return { createdChannel: null };
      case 'channel.update': case 'channel.delete': return { channel: state.channelName === undefined ? null : { id: state.channelId, name: state.channelName, parentId: state.parentId ?? null } };
      case 'channel.reorder': return { position: state.channelPosition ?? null };
      case 'message.send': return { message: null };
      default: throw new DomainError('INTERNAL_ERROR', 'Unsupported action');
    }
  }
  #makePlan(action: Readonly<Action>, snapshot: Snapshot): ActionPlan {
    const before = this.#observable(action, snapshot.state); let after: Record<string, unknown>; let compensation: CompensationMetadata;
    switch (action.type) {
      case 'role.add': { const roles = strings(snapshot.state.memberRoles); after = { roles: [...new Set([...roles, action.roleId])].sort() }; compensation = { available: !roles.includes(action.roleId), ...(roles.includes(action.roleId) ? {} : { action: parseAction({ ...action, type: 'role.remove' }) }), note: roles.includes(action.roleId) ? 'No state change' : 'Remove the assigned role' }; break; }
      case 'role.remove': { const roles = strings(snapshot.state.memberRoles); after = { roles: roles.filter((id) => id !== action.roleId) }; compensation = { available: roles.includes(action.roleId), ...(roles.includes(action.roleId) ? { action: parseAction({ ...action, type: 'role.add' }) } : {}), note: roles.includes(action.roleId) ? 'Restore the removed role' : 'No state change' }; break; }
      case 'member.timeout': { after = { timeoutUntil: new Date(action.until).toISOString() }; const old = snapshot.state.timeoutUntil; compensation = old === null ? { available: true, action: parseAction({ type: 'member.untimeout', guildId: action.guildId, memberId: action.memberId, reason: 'Compensation for approved action' }), note: 'Clear timeout' } : { available: typeof old === 'string', ...(typeof old === 'string' ? { action: parseAction({ ...action, until: old }) } : {}), note: 'Restore previous timeout' }; break; }
      case 'member.untimeout': { after = { timeoutUntil: null }; const old = snapshot.state.timeoutUntil; compensation = { available: typeof old === 'string', ...(typeof old === 'string' ? { action: parseAction({ type: 'member.timeout', guildId: action.guildId, memberId: action.memberId, until: old, reason: 'Compensation for approved action' }) } : {}), note: 'Restore previous timeout if it has not expired' }; break; }
      case 'member.ban': after = { banned: true }; compensation = { available: true, action: parseAction({ type: 'member.unban', guildId: action.guildId, memberId: action.memberId, reason: 'Compensation for approved action' }), note: 'Unban member; deleted messages cannot be restored' }; break;
      case 'member.unban': after = { banned: false }; compensation = { available: false, note: 'Re-banning is not an automatic compensation' }; break;
      case 'overwrite.upsert': { after = { overwrite: { id: action.targetId, type: action.targetType, allow: action.allow, deny: action.deny } }; const old = snapshot.state.overwrite; compensation = old === null ? { available: true, action: parseAction({ type: 'overwrite.delete', guildId: action.guildId, channelId: action.channelId, targetId: action.targetId, targetType: action.targetType, reason: 'Compensation for approved action' }), note: 'Delete created overwrite' } : { available: true, action: parseAction({ ...action, allow: String(object(old).allow), deny: String(object(old).deny), reason: 'Compensation for approved action' }), note: 'Restore previous overwrite' }; break; }
      case 'overwrite.delete': { after = { overwrite: null }; const old = snapshot.state.overwrite; compensation = old === null ? { available: false, note: 'No state change' } : { available: true, action: parseAction({ type: 'overwrite.upsert', guildId: action.guildId, channelId: action.channelId, targetId: action.targetId, targetType: action.targetType, allow: String(object(old).allow), deny: String(object(old).deny), reason: 'Compensation for approved action' }), note: 'Restore deleted overwrite' }; break; }
      case 'role.create': after = { createdRole: { name: action.name, color: action.color, hoist: action.hoist, mentionable: action.mentionable } }; compensation = { available: false, note: 'Delete the created role manually after reviewing its ID in the operation record' }; break;
      case 'role.update': { const old = { name: text(snapshot.state.roleName) ?? action.name, color: integer(snapshot.state.roleColor), hoist: snapshot.state.roleHoist === true, mentionable: snapshot.state.roleMentionable === true }; after = { role: { id: action.roleId, name: action.name, color: action.color, hoist: action.hoist, mentionable: action.mentionable } }; compensation = { available: true, action: parseAction({ type: 'role.update', guildId: action.guildId, roleId: action.roleId, ...old, reason: 'Compensation for approved action' }), note: 'Restore previous role settings' }; break; }
      case 'role.delete': after = { role: null }; compensation = { available: false, note: 'Role deletion is not automatically reversible; recreate the role manually' }; break;
      case 'role.reorder': { const old = integer(snapshot.state.rolePosition); after = { position: action.position }; compensation = { available: true, action: parseAction({ type: 'role.reorder', guildId: action.guildId, roleId: action.roleId, position: old, reason: 'Compensation for approved action' }), note: 'Restore previous role position' }; break; }
      case 'channel.create': after = { createdChannel: { name: action.name, type: action.channelType, parentId: action.parentId ?? null } }; compensation = { available: false, note: 'Delete the created channel manually after reviewing its ID in the operation record' }; break;
      case 'channel.update': { const oldParent = snapshot.state.parentId === undefined || snapshot.state.parentId === null ? null : text(snapshot.state.parentId) ?? null; after = { channel: { id: action.channelId, name: action.name, parentId: action.parentId } }; compensation = { available: true, action: parseAction({ type: 'channel.update', guildId: action.guildId, channelId: action.channelId, name: text(snapshot.state.channelName) ?? action.name, parentId: oldParent, reason: 'Compensation for approved action' }), note: 'Restore previous channel name and parent' }; break; }
      case 'channel.delete': after = { channel: null }; compensation = { available: false, note: 'Restore the deleted channel manually via the Discord audit log within 7 days' }; break;
      case 'channel.reorder': { const old = integer(snapshot.state.channelPosition); after = { position: action.position }; compensation = { available: true, action: parseAction({ type: 'channel.reorder', guildId: action.guildId, channelId: action.channelId, position: old, reason: 'Compensation for approved action' }), note: 'Restore previous channel position' }; break; }
      case 'message.send': after = { message: { embedTitle: action.embed.title, mentionEveryone: action.mentionEveryone } }; compensation = { available: false, note: 'Delete the sent message manually' }; break;
      default: throw new DomainError('INTERNAL_ERROR', 'Unsupported action');
    }
    const diff = Object.keys(after).filter((path) => canonicalJson(before[path]) !== canonicalJson(after[path])).map((path) => StateDiffSchema.parse({ path, before: before[path] ?? null, after: after[path] ?? null }));
    const risk = action.type === 'member.ban' || action.type === 'role.delete' || action.type === 'channel.delete' ? 'high' : action.type === 'role.create' || action.type === 'channel.create' || action.type === 'member.timeout' || action.type === 'member.untimeout' || action.type === 'member.unban' || action.type.startsWith('overwrite.') ? 'medium' : 'low';
    const reversibility = action.type === 'member.unban' || (action.type === 'member.ban' && action.deleteMessageSeconds > 0) ? 'irreversible' : action.type === 'member.ban' || action.type === 'role.delete' || action.type === 'channel.delete' ? 'compensatable' : 'reversible';
    const consequences = diff.length === 0 ? ['No effective Discord membership-state change.'] : diff.map((item) => `${item.path} will change exactly as shown in the diff.`);
    if (action.type === 'member.ban' && action.deleteMessageSeconds > 0) consequences.push(`Messages from the preceding ${action.deleteMessageSeconds} seconds may be permanently deleted and cannot be restored.`);
    if (action.type === 'role.delete') consequences.push('Role-based overwrites and member assignments are removed with the role.');
    if (action.type === 'channel.delete') consequences.push('Channel messages are deleted with the channel; Discord keeps a 7-day audit restore window.');
    const warnings = diff.length === 0 ? snapshot.warnings.filter((warning) => !warning.includes('desynchronize')) : snapshot.warnings;
    return Object.freeze({ action, actionHash: actionHash(action), stateHash: stateHash(snapshot.state), risk, reversibility, consequences: Object.freeze(consequences), before: Object.freeze(before), after: Object.freeze(after), diff: Object.freeze(diff), warnings: Object.freeze(warnings), preconditions: Object.freeze(snapshot.preconditions), compensation: Object.freeze(compensation) });
  }
  async #verify(action: Action, expected: Readonly<Record<string, unknown>>, createdId?: string): Promise<boolean> {
    let actual: Record<string, unknown>;
    switch (action.type) {
      case 'role.add': case 'role.remove': {
        const member = await this.#discord.getGuildMember(action.guildId, action.memberId);
        actual = { roles: strings(member.roles) }; break;
      }
      case 'member.timeout': case 'member.untimeout': {
        const member = await this.#discord.getGuildMember(action.guildId, action.memberId);
        actual = { timeoutUntil: timestamp(member.communication_disabled_until) }; break;
      }
      case 'member.ban': {
        let banned = true; try { await this.#discord.getGuildBan(action.guildId, action.memberId); } catch (error) { if (notFound(error)) banned = false; else throw error; }
        actual = { banned }; break;
      }
      case 'member.unban': {
        let banned = true; try { await this.#discord.getGuildBan(action.guildId, action.memberId); } catch (error) { if (notFound(error)) banned = false; else throw error; }
        actual = { banned }; break;
      }
      case 'overwrite.upsert': case 'overwrite.delete': {
        const channels = await this.#discord.listGuildChannels(action.guildId);
        const channel = channels.find((item) => item.id === action.channelId);
        if (channel === undefined) return false;
        actual = { overwrite: overwrite(channel, action.targetId) }; break;
      }
      case 'role.create': {
        const roles = await this.#discord.listGuildRoles(action.guildId);
        const candidates = roles.filter((role) => role.name === action.name && integer(role.color) === action.color && role.hoist === action.hoist && role.mentionable === action.mentionable);
        const match = createdId === undefined ? candidates : candidates.filter((role) => role.id === createdId);
        actual = { createdRole: match.length === 1 ? { name: action.name, color: action.color, hoist: action.hoist, mentionable: action.mentionable } : null }; break;
      }
      case 'role.update': {
        const role = (await this.#discord.listGuildRoles(action.guildId)).find((item) => item.id === action.roleId);
        actual = role === undefined ? { role: null } : { role: { id: action.roleId, name: text(role.name) ?? '', color: integer(role.color), hoist: role.hoist === true, mentionable: role.mentionable === true } }; break;
      }
      case 'role.delete': {
        const exists = (await this.#discord.listGuildRoles(action.guildId)).some((item) => item.id === action.roleId);
        actual = { role: exists ? { id: action.roleId } : null }; break;
      }
      case 'role.reorder': {
        const role = (await this.#discord.listGuildRoles(action.guildId)).find((item) => item.id === action.roleId);
        actual = { position: role === undefined ? null : integer(role.position) }; break;
      }
      case 'channel.create': {
        const channels = await this.#discord.listGuildChannels(action.guildId);
        const type = { text: 0, voice: 2, category: 4, announcement: 5, stage: 13, forum: 15, media: 16 }[action.channelType];
        const candidates = channels.filter((channel) => channel.name === action.name && integer(channel.type) === type && (action.parentId === undefined ? channel.parent_id === undefined || channel.parent_id === null : channel.parent_id === action.parentId));
        const match = createdId === undefined ? candidates : candidates.filter((channel) => channel.id === createdId);
        actual = { createdChannel: match.length === 1 ? { name: action.name, type: action.channelType, parentId: action.parentId ?? null } : null }; break;
      }
      case 'channel.update': {
        const channel = (await this.#discord.listGuildChannels(action.guildId)).find((item) => item.id === action.channelId);
        actual = channel === undefined ? { channel: null } : { channel: { id: action.channelId, name: text(channel.name) ?? '', parentId: channel.parent_id === undefined || channel.parent_id === null ? null : text(channel.parent_id) ?? null } }; break;
      }
      case 'channel.delete': {
        const exists = (await this.#discord.listGuildChannels(action.guildId)).some((item) => item.id === action.channelId);
        actual = { channel: exists ? { id: action.channelId } : null }; break;
      }
      case 'channel.reorder': {
        const channel = (await this.#discord.listGuildChannels(action.guildId)).find((item) => item.id === action.channelId);
        actual = { position: channel === undefined ? null : integer(channel.position) }; break;
      }
      case 'message.send': {
        const messages = await this.#discord.getChannelMessages(action.channelId, 10);
        // Discord stores the wire nonce produced by nonceForWire, not the 36-character client UUID.
        const match = messages.find((message) => String(message.nonce ?? '') === nonceForWire(String(action.clientNonce)) && text((message.embeds ?? [])[0]?.title) === action.embed.title);
        actual = { message: match === undefined ? null : { embedTitle: action.embed.title, mentionEveryone: action.mentionEveryone } }; break;
      }
      default: throw new DomainError('INTERNAL_ERROR', 'Unsupported action');
    }
    return canonicalJson(actual) === canonicalJson(expected);
  }

  async #mutate(action: Action): Promise<string | undefined> {
    switch (action.type) {
      case 'role.add': await this.#discord.addMemberRole(action.guildId, action.memberId, action.roleId, action.reason); break;
      case 'role.remove': await this.#discord.removeMemberRole(action.guildId, action.memberId, action.roleId, action.reason); break;
      case 'member.timeout': await this.#discord.timeoutMember(action.guildId, action.memberId, action.until, action.reason); break;
      case 'member.untimeout': await this.#discord.clearMemberTimeout(action.guildId, action.memberId, action.reason); break;
      case 'member.ban': await this.#discord.banMember(action.guildId, action.memberId, action.deleteMessageSeconds, action.reason); break;
      case 'member.unban': await this.#discord.unbanMember(action.guildId, action.memberId, action.reason); break;
      case 'overwrite.upsert': await this.#discord.upsertChannelPermissionOverwrite(action.channelId, action.targetId, action.targetType, action.allow, action.deny, action.reason); break;
      case 'overwrite.delete': await this.#discord.deleteChannelPermissionOverwrite(action.channelId, action.targetId, action.reason); break;
      case 'role.create': { const role = await this.#discord.createGuildRole(action.guildId, action.name, action.color, action.hoist, action.mentionable, action.reason); return role.id; }
      case 'role.update': await this.#discord.updateGuildRole(action.guildId, action.roleId, action.name, action.color, action.hoist, action.mentionable, action.reason); return action.roleId;
      case 'role.delete': await this.#discord.deleteGuildRole(action.guildId, action.roleId, action.reason); break;
      case 'role.reorder': await this.#discord.reorderGuildRole(action.guildId, action.roleId, action.position, action.reason); break;
      case 'channel.create': { const channel = await this.#discord.createGuildChannel(action.guildId, action.name, action.channelType, action.parentId, action.reason); return channel.id; }
      case 'channel.update': await this.#discord.updateChannel(action.channelId, action.name, action.parentId, action.reason); return action.channelId;
      case 'channel.delete': await this.#discord.deleteChannel(action.channelId, action.reason); break;
      case 'channel.reorder': await this.#discord.reorderGuildChannel(action.guildId, action.channelId, action.position, action.reason); break;
      case 'message.send': {
        const payload: { readonly content?: string; readonly nonce?: string; readonly embeds: readonly Record<string, unknown>[]; readonly allowedMentions: readonly string[] } = {
          ...(action.content === undefined ? {} : { content: action.content }),
          ...(action.clientNonce === undefined ? {} : { nonce: action.clientNonce }),
          embeds: [{ title: action.embed.title, description: action.embed.description, color: action.embed.color, fields: action.embed.fields }],
          allowedMentions: action.allowedMentions,
        };
        await this.#discord.createMessage(action.channelId, payload, action.reason); break;
      }
      default: throw new DomainError('INTERNAL_ERROR', 'Unsupported action');
    }
    return undefined;
  }

  /** After a successful create, register the new resource so autonomous mode can manage it later. */
  #trackCreated(action: Action, createdId?: string): void {
    const guild = this.#policy.guilds[action.guildId];
    if (guild === undefined || createdId === undefined) return;
    if (action.type === 'role.create' && guild.trackCreatedRoles) this.#created.add(action.guildId, 'role', createdId);
    else if (action.type === 'channel.create' && guild.trackCreatedChannels) this.#created.add(action.guildId, 'channel', createdId);
  }
}
