import { fetchRuntimeAccess } from '../fetch-runtime-access';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../lib', () => ({
  ConfigIO: vi.fn(),
}));

const RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-agent-abc123';
const EXPECTED_URL = `https://bedrock-agentcore.us-east-1.amazonaws.com/runtimes/${encodeURIComponent(RUNTIME_ARN)}/invocations`;

const deployedState = {
  targets: {
    default: {
      resources: {
        runtimes: {
          'my-agent': { runtimeId: 'rt-1', runtimeArn: RUNTIME_ARN, roleArn: 'arn:aws:iam::123:role/r' },
        },
      },
    },
  },
};

const projectSpec = {
  runtimes: [{ name: 'my-agent', authorizerType: 'AWS_IAM' }],
  credentials: [],
};

const awsTargets = [{ name: 'default', region: 'us-east-1', account: '123456789012' }];

function createMockConfigIO() {
  return {
    readDeployedState: vi.fn().mockResolvedValue(deployedState),
    readProjectSpec: vi.fn().mockResolvedValue(projectSpec),
    readAWSDeploymentTargets: vi.fn().mockResolvedValue(awsTargets),
  } as any;
}

describe('fetchRuntimeAccess', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns the runtime invocation URL and SigV4 message for an AWS_IAM agent, with no token', async () => {
    const result = await fetchRuntimeAccess('my-agent', { configIO: createMockConfigIO() });

    expect(result.url).toBe(EXPECTED_URL);
    expect(result.authType).toBe('AWS_IAM');
    expect(result.token).toBeUndefined();
    expect(result.message).toContain('SigV4');
  });
});
