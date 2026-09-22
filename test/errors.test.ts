import { describe, expect, it } from 'vitest';
import { DomainError, toPublicError } from '../src/errors.js';

describe('public errors', () => {
  it('preserves explicitly safe domain errors', () => {
    expect(toPublicError(new DomainError('CONFIG_INVALID', 'Configuration is invalid.'))).toEqual({
      name: 'DomainError',
      code: 'CONFIG_INVALID',
      message: 'Configuration is invalid.',
    });
  });

  it('does not reflect unknown error content', () => {
    const secret = 'private-upstream-content';
    expect(JSON.stringify(toPublicError(new Error(secret)))).not.toContain(secret);
  });
});
