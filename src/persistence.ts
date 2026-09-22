import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ActionSchema, SnowflakeSchema, actionHash, canonicalJson, type Action } from './domain.js';
import { DomainError } from './errors.js';

export const OperationStatusSchema = z.enum(['proposed', 'approved', 'executing', 'succeeded', 'failed', 'uncertain']);
export type OperationStatus = z.infer<typeof OperationStatusSchema>;
export const OperationSchema = z.object({
  id: z.string().uuid(), action: ActionSchema, actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: OperationStatusSchema, version: z.number().int().nonnegative(), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  error: z.string().max(1000).optional(),
}).strict();
export type Operation = z.infer<typeof OperationSchema>;

const transitions: Readonly<Record<OperationStatus, readonly OperationStatus[]>> = Object.freeze({
  proposed: ['approved', 'failed'], approved: ['executing', 'failed'], executing: ['succeeded', 'failed', 'uncertain'],
  succeeded: [], failed: [], uncertain: ['succeeded', 'failed'],
});

export interface OperationStore {
  create(action: Action, now?: Date): Operation;
  get(id: string): Operation | undefined;
  transition(id: string, expectedStatus: OperationStatus, nextStatus: OperationStatus, expectedVersion?: number, error?: string, now?: Date): Operation;
}

function freezeDeep(value: unknown): void {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeDeep(child);
  Object.freeze(value);
}
function immutable<T extends object>(value: T): Readonly<T> {
  const copy: T = structuredClone(value);
  freezeDeep(copy);
  return copy;
}

/** Fail-closed cross-process lock used around every file-store read/modify/write CAS. */
export function writeAtomicFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`; let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600); writeFileSync(descriptor, content, 'utf8'); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, path);
    try { const directory = openSync(dirname(path), 'r'); try { fsyncSync(directory); } finally { closeSync(directory); } } catch { /* directory fsync is unavailable on some platforms */ }
  } catch {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* cleanup best effort */ }
    throw new DomainError('PERSISTENCE_WRITE_FAILED', 'Unable to atomically persist durable state');
  }
}

export function withFileStoreLock<T>(path: string, work: () => T): T {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  let descriptor: number;
  try { descriptor = openSync(lockPath, 'wx', 0o600); }
  catch { throw new DomainError('OPERATION_CONFLICT', 'Durable state is busy; retry the operation'); }
  try { writeFileSync(descriptor, canonicalJson({ pid: process.pid, resource: path, createdAt: new Date().toISOString() }), 'utf8'); fsyncSync(descriptor); }
  catch { closeSync(descriptor); try { unlinkSync(lockPath); } catch { /* cleanup best effort */ } throw new DomainError('PERSISTENCE_WRITE_FAILED', 'Unable to create durable-state lock'); }
  try { return work(); }
  finally {
    closeSync(descriptor);
    try { unlinkSync(lockPath); } catch { /* a missing lock is already released */ }
  }
}

export class InMemoryOperationStore implements OperationStore {
  protected readonly operations = new Map<string, Operation>();

  public create(action: Action, now = new Date()): Operation {
    const parsed = ActionSchema.parse(action);
    const timestamp = now.toISOString();
    const operation = OperationSchema.parse({ id: randomUUID(), action: parsed, actionHash: actionHash(parsed), status: 'proposed', version: 0, createdAt: timestamp, updatedAt: timestamp });
    this.operations.set(operation.id, operation);
    return immutable(operation);
  }
  public get(id: string): Operation | undefined { const value = this.operations.get(id); return value === undefined ? undefined : immutable(value); }
  public transition(id: string, expectedStatus: OperationStatus, nextStatus: OperationStatus, expectedVersion?: number, error?: string, now = new Date()): Operation {
    const current = this.operations.get(id);
    if (current === undefined) throw new DomainError('OPERATION_NOT_FOUND', 'Operation not found');
    if (current.status !== expectedStatus || (expectedVersion !== undefined && current.version !== expectedVersion)) throw new DomainError('OPERATION_CONFLICT', 'Operation state changed');
    if (!transitions[current.status].includes(nextStatus)) throw new DomainError('OPERATION_TRANSITION_INVALID', `Invalid operation transition: ${current.status} to ${nextStatus}`);
    if (actionHash(current.action) !== current.actionHash) throw new DomainError('ACTION_HASH_MISMATCH', 'Stored action hash does not match action');
    const next = OperationSchema.parse({ ...current, status: nextStatus, version: current.version + 1, updatedAt: now.toISOString(), ...(error === undefined ? {} : { error }) });
    this.operations.set(id, next);
    return immutable(next);
  }
}

const fileSchema = z.object({ operations: z.array(OperationSchema) }).strict();
/** Durable operation store using atomic replace after each successful CAS. */
export class FileOperationStore extends InMemoryOperationStore {
  readonly #path: string;
  public constructor(path: string) { super(); this.#path = resolve(path); this.refresh(); }
  public override get(id: string): Operation | undefined { this.refresh(); return super.get(id); }
  public override create(action: Action, now?: Date): Operation {
    return withFileStoreLock(this.#path, () => {
      this.refresh();
      try { const value = super.create(action, now); this.persist(); return value; }
      catch (error) { this.refresh(); throw error; }
    });
  }
  public override transition(id: string, expectedStatus: OperationStatus, nextStatus: OperationStatus, expectedVersion?: number, error?: string, now?: Date): Operation {
    return withFileStoreLock(this.#path, () => {
      this.refresh();
      try { const value = super.transition(id, expectedStatus, nextStatus, expectedVersion, error, now); this.persist(); return value; }
      catch (failure) { this.refresh(); throw failure; }
    });
  }
  private refresh(): void {
    this.operations.clear();
    if (!existsSync(this.#path)) return;
    let parsed: z.infer<typeof fileSchema>;
    try { parsed = fileSchema.parse(JSON.parse(readFileSync(this.#path, 'utf8'))); } catch { throw new DomainError('PERSISTENCE_CORRUPT', 'Operation store is invalid'); }
    for (const operation of parsed.operations) this.operations.set(operation.id, operation);
  }
  private persist(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeAtomicFile(this.#path, canonicalJson({ operations: [...this.operations.values()] }));
    } catch { throw new DomainError('PERSISTENCE_WRITE_FAILED', 'Unable to persist operation state'); }
  }
}

export const ConfirmationSchema = z.object({
  id: z.string().uuid(), operationId: z.string().uuid(), actionHash: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAt: z.string().datetime(), expiresAt: z.string().datetime(), usedAt: z.string().datetime().optional(),
}).strict();
export type Confirmation = z.infer<typeof ConfirmationSchema>;

export class ConfirmationStore {
  protected readonly records = new Map<string, Confirmation>();
  public issue(operation: Operation, ttlMs: number, now = new Date()): Confirmation {
    if (operation.status !== 'proposed') throw new DomainError('OPERATION_CONFLICT', 'Only proposed operations can be confirmed');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new DomainError('CONFIRMATION_INVALID', 'Confirmation lifetime must be positive');
    if (actionHash(operation.action) !== operation.actionHash) throw new DomainError('ACTION_HASH_MISMATCH', 'Action hash does not match operation');
    const record = ConfirmationSchema.parse({ id: randomUUID(), operationId: operation.id, actionHash: operation.actionHash, issuedAt: now.toISOString(), expiresAt: new Date(now.getTime() + ttlMs).toISOString() });
    this.records.set(record.id, record); this.didChange(); return immutable(record);
  }
  public consume(id: string, operation: Operation, suppliedHash: string, now = new Date()): Confirmation {
    const record = this.records.get(id);
    if (record === undefined) throw new DomainError('CONFIRMATION_INVALID', 'Confirmation not found');
    if (record.usedAt !== undefined) throw new DomainError('CONFIRMATION_REPLAYED', 'Confirmation was already used');
    if (now.getTime() >= Date.parse(record.expiresAt)) throw new DomainError('CONFIRMATION_EXPIRED', 'Confirmation has expired');
    const expected = Buffer.from(record.actionHash, 'utf8'); const supplied = Buffer.from(suppliedHash, 'utf8');
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied) || operation.id !== record.operationId || operation.actionHash !== record.actionHash || actionHash(operation.action) !== record.actionHash) throw new DomainError('ACTION_HASH_MISMATCH', 'Confirmation does not match the canonical action');
    const used = ConfirmationSchema.parse({ ...record, usedAt: now.toISOString() }); this.records.set(id, used); this.didChange(); return immutable(used);
  }
  protected didChange(): void { /* in-memory store needs no flush */ }
}

const confirmationFileSchema = z.object({ confirmations: z.array(ConfirmationSchema) }).strict();
/** Durable confirmation records preserve expiration and replay protection across restarts. */
export class FileConfirmationStore extends ConfirmationStore {
  readonly #path: string;
  public constructor(path: string) { super(); this.#path = resolve(path); this.refresh(); }
  public override issue(operation: Operation, ttlMs: number, now?: Date): Confirmation {
    return withFileStoreLock(this.#path, () => {
      this.refresh();
      try { return super.issue(operation, ttlMs, now); }
      catch (error) { this.refresh(); throw error; }
    });
  }
  public override consume(id: string, operation: Operation, suppliedHash: string, now?: Date): Confirmation {
    return withFileStoreLock(this.#path, () => {
      this.refresh();
      try { return super.consume(id, operation, suppliedHash, now); }
      catch (error) { this.refresh(); throw error; }
    });
  }
  private refresh(): void {
    this.records.clear();
    if (!existsSync(this.#path)) return;
    let parsed: z.infer<typeof confirmationFileSchema>;
    try { parsed = confirmationFileSchema.parse(JSON.parse(readFileSync(this.#path, 'utf8'))); } catch { throw new DomainError('PERSISTENCE_CORRUPT', 'Confirmation store is invalid'); }
    for (const confirmation of parsed.confirmations) this.records.set(confirmation.id, confirmation);
  }
  protected override didChange(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeAtomicFile(this.#path, canonicalJson({ confirmations: [...this.records.values()] }));
    } catch { throw new DomainError('PERSISTENCE_WRITE_FAILED', 'Unable to persist confirmation state'); }
  }
}

/** Process-local FIFO lock. It prevents overlapping mutations of the same target. */
export class TargetLockManager {
  readonly #tails = new Map<string, Promise<void>>();
  public async withLock<T>(targetKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(targetKey) ?? Promise.resolve();
    let release!: () => void; const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => current); this.#tails.set(targetKey, tail);
    await previous;
    try { return await work(); } finally { release(); if (this.#tails.get(targetKey) === tail) this.#tails.delete(targetKey); }
  }
}

/** Cross-process target lock layered over the in-process FIFO lock. */
export class FileTargetLockManager extends TargetLockManager {
  readonly #directory: string;
  public constructor(directory: string) { super(); this.#directory = resolve(directory); }
  public override withLock<T>(targetKey: string, work: () => Promise<T>): Promise<T> {
    return super.withLock(targetKey, async () => {
      mkdirSync(this.#directory, { recursive: true });
      const name = createHash('sha256').update(targetKey).digest('hex'); const path = resolve(this.#directory, `${name}.lock`);
      let descriptor: number;
      try { descriptor = openSync(path, 'wx', 0o600); }
      catch { throw new DomainError('OPERATION_CONFLICT', 'Target is being changed by another process; retry after it finishes'); }
      try { writeFileSync(descriptor, canonicalJson({ pid: process.pid, targetHash: name, createdAt: new Date().toISOString() }), 'utf8'); fsyncSync(descriptor); }
      catch { closeSync(descriptor); try { unlinkSync(path); } catch { /* cleanup best effort */ } throw new DomainError('PERSISTENCE_WRITE_FAILED', 'Unable to create target lock'); }
      try { return await work(); }
      finally { closeSync(descriptor); try { unlinkSync(path); } catch { /* stale lock is documented for operator recovery */ } }
    });
  }
}

export const AuditEventSchema = z.object({
  timestamp: z.string().datetime(), event: z.enum(['proposed', 'denied', 'approval_requested', 'approved', 'autonomous_approved', 'attempted', 'succeeded', 'failed', 'uncertain', 'recovery_requested', 'reconciliation_requested']),
  operationId: z.string().uuid(), actionHash: z.string().regex(/^[a-f0-9]{64}$/), details: z.record(z.unknown()).optional(),
}).strict();
export type AuditEvent = z.infer<typeof AuditEventSchema>;

export class JsonlAuditSink {
  readonly #path: string;
  public constructor(path: string) { this.#path = resolve(path); }
  public append(event: AuditEvent): void {
    const parsed = AuditEventSchema.parse(event);
    let descriptor: number | undefined;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      descriptor = openSync(this.#path, 'a', 0o600);
      appendFileSync(descriptor, `${canonicalJson(parsed)}\n`, 'utf8'); fsyncSync(descriptor);
    } catch { throw new DomainError('AUDIT_WRITE_FAILED', 'Audit event could not be persisted'); }
    finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
}

const createdResourcesFileSchema = z.object({ guilds: z.record(SnowflakeSchema, z.object({ roles: z.array(SnowflakeSchema), channels: z.array(SnowflakeSchema) }).strict()) }).strict();
/** Durable registry of resources created by this bot, used to authorize follow-up management in autonomous mode. */
export class FileCreatedResourceStore {
  readonly #path: string;
  readonly #records = new Map<string, { roles: string[]; channels: string[] }>();
  public constructor(path: string) { this.#path = resolve(path); this.refresh(); }
  public list(guildId: string): Readonly<{ roles: readonly string[]; channels: readonly string[] }> {
    this.refresh(); const value = this.#records.get(guildId);
    return value === undefined ? { roles: [], channels: [] } : { roles: Object.freeze([...value.roles]), channels: Object.freeze([...value.channels]) };
  }
  public add(guildId: string, kind: 'role' | 'channel', id: string): void {
    withFileStoreLock(this.#path, () => {
      this.refresh();
      try {
        const current = this.#records.get(guildId) ?? { roles: [], channels: [] };
        const list = kind === 'role' ? current.roles : current.channels;
        if (!list.includes(id)) list.push(id);
        this.#records.set(guildId, current); this.persist();
      } catch (error) { this.refresh(); throw error; }
    });
  }
  private refresh(): void {
    this.#records.clear();
    if (!existsSync(this.#path)) return;
    let parsed: z.infer<typeof createdResourcesFileSchema>;
    try { parsed = createdResourcesFileSchema.parse(JSON.parse(readFileSync(this.#path, 'utf8'))); }
    catch { throw new DomainError('PERSISTENCE_CORRUPT', 'Created-resource store is invalid'); }
    for (const [guildId, value] of Object.entries(parsed.guilds)) this.#records.set(guildId, { roles: [...value.roles], channels: [...value.channels] });
  }
  private persist(): void {
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeAtomicFile(this.#path, canonicalJson({ guilds: Object.fromEntries(this.#records) }));
    } catch { throw new DomainError('PERSISTENCE_WRITE_FAILED', 'Unable to persist created-resource state'); }
  }
}
