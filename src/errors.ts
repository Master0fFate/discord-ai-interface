import { ZodError } from 'zod';

export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_IO'
  | 'POLICY_DENIED'
  | 'OPERATION_NOT_FOUND'
  | 'OPERATION_CONFLICT'
  | 'OPERATION_TRANSITION_INVALID'
  | 'ACTION_HASH_MISMATCH'
  | 'CONFIRMATION_INVALID'
  | 'CONFIRMATION_EXPIRED'
  | 'CONFIRMATION_REPLAYED'
  | 'PERSISTENCE_CORRUPT'
  | 'PERSISTENCE_WRITE_FAILED'
  | 'AUDIT_WRITE_FAILED'
  | 'DISCORD_HTTP_ERROR'
  | 'DISCORD_NETWORK_ERROR'
  | 'DISCORD_RATE_LIMITED'
  | 'DISCORD_TIMEOUT'
  | 'DISCORD_INVALID_RESPONSE'
  | 'INTERNAL_ERROR';

/** An error whose message is safe to present to an operator. */
export class DomainError extends Error {
  public readonly code: ErrorCode;
  public readonly details: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: ErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = details;
  }
}

export interface PublicError {
  readonly name: string;
  readonly code: ErrorCode;
  readonly message: string;
}

/** Convert an unknown failure without reflecting exception internals or causes. */
export function toPublicError(error: unknown): PublicError {
  if (error instanceof DomainError) {
    return { name: error.name, code: error.code, message: error.message };
  }
  if (error instanceof ZodError) {
    const fields = [...new Set(error.issues.map((issue) => issue.path.join('.') || 'root'))].slice(0, 5);
    return { name: 'DomainError', code: 'CONFIG_INVALID', message: `Input validation failed at: ${fields.join(', ')}` };
  }
  if (error instanceof TypeError) {
    return { name: 'DomainError', code: 'CONFIG_INVALID', message: error.message.slice(0, 500) };
  }

  return {
    name: 'DomainError',
    code: 'INTERNAL_ERROR',
    message: 'An unexpected internal error occurred.',
  };
}
