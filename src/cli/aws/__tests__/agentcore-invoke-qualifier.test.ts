import { invokeAgentRuntime, invokeAgentRuntimeStreaming } from '../agentcore.js';
import type { InvokeAgentRuntimeOptions } from '../agentcore.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const commandArgs: Record<string, unknown>[] = [];
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-bedrock-agentcore', () => {
  class MockBedrockAgentCoreClient {
    send = mockSend;
    middlewareStack = { add: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    constructor(_config: unknown) {}
  }
  class MockInvokeAgentRuntimeCommand {
    input: Record<string, unknown>;
    constructor(args: Record<string, unknown>) {
      this.input = args;
      commandArgs.push(args);
    }
  }
  return {
    BedrockAgentCoreClient: MockBedrockAgentCoreClient,
    InvokeAgentRuntimeCommand: MockInvokeAgentRuntimeCommand,
  };
});

vi.mock('../account.js', () => ({
  getCredentialProvider: vi
    .fn()
    .mockReturnValue(() => Promise.resolve({ accessKeyId: 'test', secretAccessKey: 'test' })),
}));

function makeByteResponse(body: string) {
  return {
    runtimeSessionId: 'sess-1',
    response: {
      transformToByteArray: () => Promise.resolve(new TextEncoder().encode(body)),
    },
  };
}

function makeStreamResponse(body: string) {
  return {
    runtimeSessionId: 'sess-1',
    response: {
      transformToWebStream: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
    },
  };
}

const BASE: InvokeAgentRuntimeOptions = {
  region: 'us-east-1',
  runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:123:runtime/r',
  payload: 'hi',
};

describe('SigV4 invoke qualifier', () => {
  beforeEach(() => {
    commandArgs.length = 0;
    mockSend.mockReset();
  });

  it('sets qualifier on the non-streaming command when endpoint is provided', async () => {
    mockSend.mockResolvedValue(makeByteResponse('{"result":"ok"}'));
    await invokeAgentRuntime({ ...BASE, endpoint: 'prod' });
    expect(commandArgs[0]?.qualifier).toBe('prod');
  });

  it('omits qualifier on the non-streaming command when no endpoint is provided', async () => {
    mockSend.mockResolvedValue(makeByteResponse('{"result":"ok"}'));
    await invokeAgentRuntime({ ...BASE });
    expect(commandArgs[0]).not.toHaveProperty('qualifier');
  });

  it('sets qualifier on the streaming command when endpoint is provided', async () => {
    mockSend.mockResolvedValue(makeStreamResponse('data: "hi"\n'));
    const { stream } = await invokeAgentRuntimeStreaming({ ...BASE, endpoint: 'staging' });
    for await (const _ of stream) {
      // drain
    }
    expect(commandArgs[0]?.qualifier).toBe('staging');
  });

  it('omits qualifier on the streaming command when no endpoint is provided', async () => {
    mockSend.mockResolvedValue(makeStreamResponse('data: "hi"\n'));
    const { stream } = await invokeAgentRuntimeStreaming({ ...BASE });
    for await (const _ of stream) {
      // drain
    }
    expect(commandArgs[0]).not.toHaveProperty('qualifier');
  });
});
