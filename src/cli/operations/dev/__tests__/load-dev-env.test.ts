import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadDeployedState, mockReadAWSDeploymentTargets, mockReadProjectSpec, mockFindConfigRoot, mockReadEnvFile } =
  vi.hoisted(() => ({
    mockReadDeployedState: vi.fn(),
    mockReadAWSDeploymentTargets: vi.fn(),
    mockReadProjectSpec: vi.fn(),
    mockFindConfigRoot: vi.fn(),
    mockReadEnvFile: vi.fn(),
  }));

const libMock = {
  ConfigIO: class {
    readDeployedState = mockReadDeployedState;
    readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    readProjectSpec = mockReadProjectSpec;
  },
  findConfigRoot: mockFindConfigRoot,
  readEnvFile: mockReadEnvFile,
};

vi.mock('../../../../lib', () => libMock);
vi.mock('../../../../lib/index.js', () => libMock);

const { loadDevEnv } = await import('../load-dev-env.js');

const deployedStateInUsWest2 = {
  targets: { default: { resources: { memories: {} } } },
};
const usWest2Targets = [{ name: 'default', region: 'us-west-2' }];

describe('loadDevEnv region injection (issue #1457)', () => {
  beforeEach(() => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadEnvFile.mockResolvedValue({});
    mockReadProjectSpec.mockResolvedValue({ agentCoreGateways: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
  });

  it('injects the deployed target region even when the shell region differs', async () => {
    process.env.AWS_REGION = 'us-east-1';
    mockReadDeployedState.mockResolvedValue(deployedStateInUsWest2);
    mockReadAWSDeploymentTargets.mockResolvedValue(usWest2Targets);

    const { envVars } = await loadDevEnv('/project');

    expect(envVars.AWS_REGION).toBe('us-west-2');
    expect(envVars.AWS_DEFAULT_REGION).toBe('us-west-2');
  });

  it('lets an explicit AWS_REGION in the project .env override the target region', async () => {
    mockReadDeployedState.mockResolvedValue(deployedStateInUsWest2);
    mockReadAWSDeploymentTargets.mockResolvedValue(usWest2Targets);
    mockReadEnvFile.mockResolvedValue({ AWS_REGION: 'eu-west-1' });

    const { envVars } = await loadDevEnv('/project');

    expect(envVars.AWS_REGION).toBe('eu-west-1');
  });

  it('omits region vars (and does not throw) when aws-targets is unreadable', async () => {
    mockReadDeployedState.mockRejectedValue(new Error('no state'));
    mockReadAWSDeploymentTargets.mockRejectedValue(new Error('no targets'));

    const { envVars } = await loadDevEnv('/project');

    expect(envVars.AWS_REGION).toBeUndefined();
    expect(envVars.AWS_DEFAULT_REGION).toBeUndefined();
  });
});
