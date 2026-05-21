/**
 * Tests for the shared interceptor-mode-check helper.
 *
 * Verifies:
 *   - lookupInterceptor finds entries under any target's mcp.interceptors map
 *   - ResourceNotFoundError when the name is missing
 *   - ensureManagedForLogs / ensureManagedForInvoke throw for external mode
 *     with the canonical remediation messages
 *   - Account IDs in remediation strings are masked
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadDeployedState = vi.fn();

vi.mock('../../../../lib', () => ({
  ConfigIO: class {
    readDeployedState = mockReadDeployedState;
  },
  ResourceNotFoundError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ResourceNotFoundError';
    }
  },
  ValidationError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ValidationError';
    }
  },
}));

const { ensureManagedForInvoke, ensureManagedForLogs, lookupInterceptor } = await import('../interceptor-mode-check');

function deployedState(interceptors: Record<string, unknown>) {
  return {
    targets: {
      default: {
        resources: {
          mcp: {
            interceptors,
          },
        },
      },
    },
  };
}

describe('lookupInterceptor', () => {
  beforeEach(() => mockReadDeployedState.mockReset());
  afterEach(() => vi.clearAllMocks());

  it('finds a managed entry', async () => {
    mockReadDeployedState.mockResolvedValue(
      deployedState({
        'auth-check': {
          mode: 'managed',
          interceptorArn: 'arn:aws:lambda:us-east-1:111111111111:function:auth-check',
          interceptorFunctionName: 'auth-check',
          interceptorRoleArn: 'arn:aws:iam::111111111111:role/auth-check',
        },
      })
    );
    const result = await lookupInterceptor('auth-check');
    expect(result.entry.mode).toBe('managed');
    expect(result.targetName).toBe('default');
  });

  it('throws ResourceNotFoundError when name is missing', async () => {
    mockReadDeployedState.mockResolvedValue(deployedState({}));
    await expect(lookupInterceptor('nope')).rejects.toThrow(/is not deployed/);
  });
});

describe('ensureManagedForLogs', () => {
  beforeEach(() => mockReadDeployedState.mockReset());

  it('returns the entry for managed mode', async () => {
    mockReadDeployedState.mockResolvedValue(
      deployedState({
        'auth-check': {
          mode: 'managed',
          interceptorArn: 'arn:aws:lambda:us-east-1:111111111111:function:auth-check',
          interceptorFunctionName: 'auth-check',
        },
      })
    );
    const result = await ensureManagedForLogs('auth-check');
    expect(result.entry.mode).toBe('managed');
  });

  it('throws ValidationError with masked account ID for external mode', async () => {
    mockReadDeployedState.mockResolvedValue(
      deployedState({
        'central-auth': {
          mode: 'external',
          interceptorArn: 'arn:aws:lambda:us-east-1:222222222222:function:central-auth',
        },
      })
    );
    await expect(ensureManagedForLogs('central-auth')).rejects.toThrowError(/external interceptor/);
    await expect(ensureManagedForLogs('central-auth')).rejects.toThrowError(/aws logs tail/);
    await expect(ensureManagedForLogs('central-auth')).rejects.toThrowError(/\*{4}2222/);
    // Raw 12-digit ID should NOT appear
    try {
      await ensureManagedForLogs('central-auth');
    } catch (err) {
      expect((err as Error).message).not.toMatch(/\b222222222222\b/);
    }
  });
});

describe('ensureManagedForInvoke', () => {
  beforeEach(() => mockReadDeployedState.mockReset());

  it('returns the entry for managed mode', async () => {
    mockReadDeployedState.mockResolvedValue(
      deployedState({
        'auth-check': {
          mode: 'managed',
          interceptorArn: 'arn:aws:lambda:us-east-1:111111111111:function:auth-check',
        },
      })
    );
    const result = await ensureManagedForInvoke('auth-check');
    expect(result.entry.mode).toBe('managed');
  });

  it('throws ValidationError with masked account ID for external mode', async () => {
    mockReadDeployedState.mockResolvedValue(
      deployedState({
        'central-auth': {
          mode: 'external',
          interceptorArn: 'arn:aws:lambda:us-east-1:222222222222:function:central-auth',
        },
      })
    );
    await expect(ensureManagedForInvoke('central-auth')).rejects.toThrowError(/external interceptor/);
    await expect(ensureManagedForInvoke('central-auth')).rejects.toThrowError(/aws lambda invoke/);
    await expect(ensureManagedForInvoke('central-auth')).rejects.toThrowError(/\*{4}2222/);
  });
});
