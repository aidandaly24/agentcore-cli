/**
 * Tests for `handleLogsInterceptor` — the new error paths added in deep-research:
 *   - SIGINT/AbortSignal cleanly returns success
 *   - ResourceNotFoundException maps to a user-friendly remediation
 *   - `--limit` validates as positive integer
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnsureManagedForLogs = vi.fn();
const mockResolveTargets = vi.fn();
const mockStreamLogs = vi.fn();
const mockSearchLogs = vi.fn();

vi.mock('../../../../lib', () => ({
  ConfigIO: class {
    resolveAWSDeploymentTargets = mockResolveTargets;
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

vi.mock('../../../aws/cloudwatch', () => ({
  streamLogs: (opts: unknown) => mockStreamLogs(opts),
  searchLogs: (opts: unknown) => mockSearchLogs(opts),
}));

vi.mock('../../shared/interceptor-mode-check', () => ({
  ensureManagedForLogs: mockEnsureManagedForLogs,
}));

const { handleLogsInterceptor } = await import('../interceptor');

const baseEntry = {
  mode: 'managed' as const,
  interceptorArn: 'arn:aws:lambda:us-east-1:111111111111:function:p-interceptor-auth',
  interceptorFunctionName: 'p-interceptor-auth',
  interceptorRoleArn: 'arn:aws:iam::111111111111:role/auth-role',
};

const baseTarget = { name: 'default', account: '111111111111', region: 'us-east-1', profile: 'deploy' };

async function* yieldNothing() {
  // Empty async generator
}

// eslint-disable-next-line require-yield, @typescript-eslint/require-await -- async generator fixture that throws synchronously to simulate CloudWatch errors
async function* throwResourceNotFound() {
  const err = new Error('Log group does not exist.');
  err.name = 'ResourceNotFoundException';
  throw err;
}

// eslint-disable-next-line require-yield, @typescript-eslint/require-await -- async generator fixture that throws synchronously to simulate AbortController errors
async function* throwAbortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  throw err;
}

describe('handleLogsInterceptor', () => {
  beforeEach(() => {
    mockEnsureManagedForLogs.mockReset();
    mockResolveTargets.mockReset();
    mockStreamLogs.mockReset();
    mockSearchLogs.mockReset();

    mockEnsureManagedForLogs.mockResolvedValue({ entry: baseEntry, targetName: 'default' });
    mockResolveTargets.mockResolvedValue([baseTarget]);
  });

  afterEach(() => vi.clearAllMocks());

  it('returns failure with --name remediation when --name missing', async () => {
    const r = await handleLogsInterceptor({});
    expect(r.success).toBe(false);
  });

  it('returns failure when interceptorFunctionName missing in deployed-state', async () => {
    mockEnsureManagedForLogs.mockResolvedValue({
      entry: { ...baseEntry, interceptorFunctionName: undefined },
      targetName: 'default',
    });
    const r = await handleLogsInterceptor({ name: 'auth' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.message).toMatch(/has no Lambda function/);
      expect(r.error.message).toMatch(/agentcore deploy/);
    }
  });

  it('maps ResourceNotFoundException to a structured ResourceNotFoundError with gateway-traffic remediation', async () => {
    mockStreamLogs.mockImplementation(() => throwResourceNotFound());
    const r = await handleLogsInterceptor({ name: 'auth', follow: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.name).toBe('ResourceNotFoundError');
      expect(r.error.message).toMatch(/Log group/);
      expect(r.error.message).toMatch(/send a request through the gateway/);
    }
  });

  it('returns success when streamLogs aborts via AbortError (Ctrl-C path)', async () => {
    mockStreamLogs.mockImplementation(() => throwAbortError());
    const r = await handleLogsInterceptor({ name: 'auth', follow: true });
    expect(r.success).toBe(true);
  });

  it('rejects --limit when value is not a positive integer', async () => {
    mockSearchLogs.mockImplementation(() => yieldNothing());
    const r = await handleLogsInterceptor({ name: 'auth', since: '1h', limit: 'abc' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.message).toMatch(/--limit must be a positive integer/);
    }
  });

  it('rejects --limit when value is zero', async () => {
    mockSearchLogs.mockImplementation(() => yieldNothing());
    const r = await handleLogsInterceptor({ name: 'auth', since: '1h', limit: '0' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.message).toMatch(/--limit must be a positive integer/);
    }
  });

  it('removes the SIGINT listener after a successful streamLogs run', async () => {
    const before = process.listenerCount('SIGINT');
    mockStreamLogs.mockImplementation(() => yieldNothing());
    await handleLogsInterceptor({ name: 'auth', follow: true });
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });

  it('removes the SIGINT listener after streamLogs aborts', async () => {
    const before = process.listenerCount('SIGINT');
    mockStreamLogs.mockImplementation(() => throwAbortError());
    await handleLogsInterceptor({ name: 'auth', follow: true });
    const after = process.listenerCount('SIGINT');
    expect(after).toBe(before);
  });

  it('passes a populated abortSignal to streamLogs in follow mode', async () => {
    mockStreamLogs.mockImplementation(() => yieldNothing());
    await handleLogsInterceptor({ name: 'auth', follow: true });
    expect(mockStreamLogs).toHaveBeenCalledOnce();
    const arg = mockStreamLogs.mock.calls[0]![0] as { abortSignal?: AbortSignal };
    expect(arg.abortSignal).toBeDefined();
    // signal is fresh (not yet aborted) at the time of the call
    expect(arg.abortSignal!.aborted).toBe(false);
  });
});
