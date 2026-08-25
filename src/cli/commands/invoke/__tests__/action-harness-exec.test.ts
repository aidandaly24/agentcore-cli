import { executeBashCommand } from '../../../aws';
import { invokeHarness } from '../../../aws/agentcore-harness';
import type { InvokeContext } from '../action';
import { handleHarnessInvokeByArn, handleInvoke } from '../action';
import type { InvokeOptions } from '../types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolveInvokeTarget = vi.fn();

vi.mock('../resolve', () => ({
  resolveInvokeTarget: (...args: unknown[]) => mockResolveInvokeTarget(...args),
}));

vi.mock('../../../aws', () => ({
  DEFAULT_RUNTIME_USER_ID: 'default-user',
  buildAguiRunInput: vi.fn(),
  executeBashCommand: vi.fn(),
  extractResult: vi.fn(),
  getOrCreatePaymentSession: vi.fn(),
  invokeA2ARuntime: vi.fn(),
  invokeAgentRuntime: vi.fn(),
  invokeAgentRuntimeStreaming: vi.fn(),
  invokeAguiRuntime: vi.fn(),
  mcpCallTool: vi.fn(),
  mcpInitSession: vi.fn(),
  mcpListTools: vi.fn(),
  parseSSE: vi.fn(),
}));

vi.mock('../../../aws/agentcore-harness', () => ({
  invokeHarness: vi.fn(),
}));

vi.mock('../../../logging', () => ({
  InvokeLogger: class {
    logFilePath = '/tmp/fake.log';
    logPrompt = vi.fn();
    logResponse = vi.fn();
    logError = vi.fn();
    logInfo = vi.fn();
  },
}));

vi.mock('../../../operations/fetch-access', () => ({
  canFetchHarnessToken: vi.fn().mockResolvedValue(false),
  fetchHarnessToken: vi.fn(),
}));

const HARNESS_NAME = 'OrderResearchAgent';
const HARNESS_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/OrderResearchAgent-abc123';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';

function commandStream() {
  return (async function* () {
    await Promise.resolve();
    yield { type: 'stdout' as const, data: 'report contents\n' };
    yield { type: 'stop' as const, exitCode: 0, status: 'COMPLETED' };
  })();
}

function harnessStream() {
  return (async function* () {
    await Promise.resolve();
    yield {
      type: 'contentBlockDelta' as const,
      delta: { type: 'text' as const, text: 'model response' },
    };
  })();
}

function makeContext(): InvokeContext {
  return {
    project: {
      name: 'HarnessExecTest',
      runtimes: [],
      harnesses: [{ name: HARNESS_NAME }],
    } as never,
    deployedState: {
      targets: {
        default: {
          resources: {
            harnesses: {
              [HARNESS_NAME]: {
                harnessArn: HARNESS_ARN,
              },
            },
          },
        },
      },
    } as never,
    awsTargets: [{ name: 'default', region: 'us-east-1' }] as never,
  };
}

function makeRuntimeContext(): InvokeContext {
  return {
    project: {
      name: 'RuntimeExecTest',
      runtimes: [{ name: 'CustomerSupport', protocol: 'HTTP' }],
      harnesses: [],
    } as never,
    deployedState: { targets: { default: { resources: {} } } } as never,
    awsTargets: [{ name: 'default', region: 'us-east-1' }] as never,
  };
}

function makeOptions(overrides: Partial<InvokeOptions> = {}): InvokeOptions {
  return {
    exec: true,
    prompt: 'cat /tmp/warranty_report.md',
    sessionId: SESSION_ID,
    timeout: 30,
    headers: { 'x-test-header': 'value' },
    bearerToken: 'test-token',
    json: true,
    ...overrides,
  };
}

describe('handleInvoke — Harness exec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveInvokeTarget.mockResolvedValue({
      success: true,
      agentSpec: { name: 'CustomerSupport', protocol: 'HTTP' },
      targetName: 'default',
      targetConfig: { name: 'default', region: 'us-east-1' },
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/CustomerSupport-abc123',
      baggage: undefined,
    });
    vi.mocked(executeBashCommand).mockResolvedValue({ stream: commandStream(), sessionId: SESSION_ID });
    vi.mocked(invokeHarness).mockReturnValue(harnessStream() as never);
  });

  it('executes against a configured Harness instead of sending a model message', async () => {
    const result = await handleInvoke(makeContext(), makeOptions({ harnessName: HARNESS_NAME }));

    expect(executeBashCommand).toHaveBeenCalledWith({
      region: 'us-east-1',
      runtimeArn: HARNESS_ARN,
      command: 'cat /tmp/warranty_report.md',
      sessionId: SESSION_ID,
      timeout: 30,
      headers: { 'x-test-header': 'value' },
      bearerToken: 'test-token',
    });
    expect(invokeHarness).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      agentName: HARNESS_NAME,
      targetName: 'default',
      response: JSON.stringify({
        stdout: 'report contents\n',
        stderr: '',
        exitCode: 0,
        status: 'COMPLETED',
      }),
    });
  });

  it('executes against a Harness ARN instead of sending a model message', async () => {
    const result = await handleHarnessInvokeByArn(HARNESS_ARN, 'us-east-1', makeOptions());

    expect(executeBashCommand).toHaveBeenCalledWith({
      region: 'us-east-1',
      runtimeArn: HARNESS_ARN,
      command: 'cat /tmp/warranty_report.md',
      sessionId: SESSION_ID,
      timeout: 30,
      headers: { 'x-test-header': 'value' },
      bearerToken: 'test-token',
    });
    expect(invokeHarness).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      agentName: 'external-harness',
    });
  });

  it('preserves Runtime exec behavior through the shared execution path', async () => {
    const result = await handleInvoke(makeRuntimeContext(), makeOptions());

    expect(executeBashCommand).toHaveBeenCalledWith({
      region: 'us-east-1',
      runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/CustomerSupport-abc123',
      command: 'cat /tmp/warranty_report.md',
      sessionId: SESSION_ID,
      timeout: 30,
      headers: { 'x-test-header': 'value' },
      bearerToken: 'test-token',
    });
    expect(invokeHarness).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      exitCode: 0,
      agentName: 'CustomerSupport',
      targetName: 'default',
    });
  });
});
