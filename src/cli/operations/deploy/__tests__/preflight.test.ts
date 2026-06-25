import { ValidationError } from '../../../../lib/errors/types.js';
import { formatError, validateProject } from '../preflight.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockReadProjectSpec, mockReadAWSDeploymentTargets, mockReadDeployedState, mockConfigExists } = vi.hoisted(
  () => ({
    mockReadProjectSpec: vi.fn(),
    mockReadAWSDeploymentTargets: vi.fn(),
    mockReadDeployedState: vi.fn(),
    mockConfigExists: vi.fn(),
  })
);

const { mockValidate } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
}));

const { mockValidateAwsCredentials, mockDetectAccount } = vi.hoisted(() => ({
  mockValidateAwsCredentials: vi.fn(),
  mockDetectAccount: vi.fn(),
}));

const { mockRequireConfigRoot } = vi.hoisted(() => ({
  mockRequireConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => ({
  ConfigIO: class {
    constructor(_options?: { baseDir?: string }) {
      // mock constructor
    }
    readProjectSpec = mockReadProjectSpec;
    readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    resolveAWSDeploymentTargets = mockReadAWSDeploymentTargets;
    readDeployedState = mockReadDeployedState;
    configExists = mockConfigExists;
    getPathResolver = () => ({ getAgentConfigPath: () => '/tmp/mock-agentcore.json' });
  },
  requireConfigRoot: mockRequireConfigRoot,
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: () => JSON.stringify({}),
    writeFileSync: vi.fn(),
  };
});

vi.mock('../../../cdk/local-cdk-project.js', () => ({
  LocalCdkProject: class {
    validate = mockValidate;
  },
}));

vi.mock('../../../aws/account.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../aws/account.js')>();
  return {
    ...actual,
    validateAwsCredentials: mockValidateAwsCredentials,
    detectAccount: mockDetectAccount,
    // Re-derive the helper from the mocked detectAccount so the test controls the caller account.
    assertCallerAccountMatchesTarget: async (target: { name: string; account?: string }) => {
      const callerAccount = await mockDetectAccount();
      if (callerAccount && target.account && callerAccount !== target.account) {
        throw new ValidationError(
          `Your AWS credentials are for account ${callerAccount}, but the target "${target.name}" is configured for account ${target.account}.\nEnsure your credentials match the deployment target.`
        );
      }
    },
  };
});

describe('validateProject', () => {
  afterEach(() => vi.clearAllMocks());

  it('allows deploy when gateways exist but no agents', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [{ name: 'test-gateway' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('blocks deploy when no agents and no gateways', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockReadDeployedState.mockRejectedValue(new Error('No deployed state'));

    await expect(validateProject()).rejects.toThrow(
      'No resources defined in project. Add at least one resource (agent, memory, knowledge base, evaluator, or gateway) before deploying.'
    );
  });

  it('allows deploy when only a knowledge base is defined (no agents or gateways)', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      memories: [],
      knowledgeBases: [
        {
          type: 'AgentCoreKnowledgeBase',
          name: 'docs',
          dataSources: [{ type: 'S3', uri: 's3://my-bucket/' }],
        },
      ],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('allows deploy when memories exist but no agents or gateways', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      memories: [{ name: 'test-memory', strategies: [] }],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('allows deploy when datasets exist but no agents or gateways', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [],
      memories: [],
      knowledgeBases: [],
      datasets: [
        {
          name: 'test-dataset',
          schemaType: 'AGENTCORE_EVALUATION_PREDEFINED_V1',
          config: { managed: { location: 'datasets/test.jsonl' } },
        },
      ],
      agentCoreGateways: [],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('allows deploy when both agents and gateways exist', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({
      name: 'test-project',
      runtimes: [{ name: 'test-agent' }],
      agentCoreGateways: [{ name: 'test-gateway' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();

    expect(result.projectSpec.name).toBe('test-project');
    expect(result.isTeardownDeploy).toBe(false);
  });

  it('fails fast when caller account differs from the selected target account', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({ name: 'test-project', runtimes: [{ name: 'agent' }] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);
    mockDetectAccount.mockResolvedValue('111111111111');

    await expect(
      validateProject({ name: 'prod', account: '222222222222', region: 'us-east-1' } as never)
    ).rejects.toThrow(/account 111111111111.*target "prod".*account 222222222222/s);
  });

  it('does not throw when caller account matches the selected target account', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({ name: 'test-project', runtimes: [{ name: 'agent' }] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);
    mockDetectAccount.mockResolvedValue('222222222222');

    const result = await validateProject({ name: 'prod', account: '222222222222', region: 'us-east-1' } as never);
    expect(result.projectSpec.name).toBe('test-project');
  });

  it('skips the account comparison when detectAccount returns null', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    mockReadProjectSpec.mockResolvedValue({ name: 'test-project', runtimes: [{ name: 'agent' }] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);
    mockDetectAccount.mockResolvedValue(null);

    const result = await validateProject({ name: 'prod', account: '222222222222', region: 'us-east-1' } as never);
    expect(result.projectSpec.name).toBe('test-project');
  });

  it('accepts gateway target name within 48 chars when prefixed with project name', async () => {
    mockRequireConfigRoot.mockReturnValue('/project/agentcore');
    mockValidate.mockReturnValue(undefined);
    // projectName "myproject" (9) + "-" (1) + targetName (38) = 48 == limit
    mockReadProjectSpec.mockResolvedValue({
      name: 'myproject',
      runtimes: [],
      agentCoreGateways: [{ name: 'gw' }],
    });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockValidateAwsCredentials.mockResolvedValue(undefined);

    const result = await validateProject();
    expect(result.projectSpec.name).toBe('myproject');
  });
});

describe('formatError', () => {
  it('formats a simple Error', () => {
    const err = new Error('Something went wrong');
    const result = formatError(err);
    expect(result).toContain('Something went wrong');
  });

  it('omits the stack trace by default but includes it under AGENTCORE_DEBUG', () => {
    const err = new Error('oops');
    expect(formatError(err)).not.toContain('Stack trace:');
    expect(formatError(err)).toContain('oops');

    const prev = process.env.AGENTCORE_DEBUG;
    process.env.AGENTCORE_DEBUG = '1';
    try {
      expect(formatError(new Error('oops'))).toContain('Stack trace:');
    } finally {
      if (prev === undefined) delete process.env.AGENTCORE_DEBUG;
      else process.env.AGENTCORE_DEBUG = prev;
    }
  });

  it('formats nested cause errors', () => {
    const cause = new Error('root cause');
    const err = new Error('outer error', { cause });
    const result = formatError(err);
    expect(result).toContain('outer error');
    expect(result).toContain('Caused by:');
    expect(result).toContain('root cause');
  });

  it('formats non-Error values using String()', () => {
    expect(formatError('string error')).toBe('string error');
    expect(formatError(42)).toBe('42');
    expect(formatError(null)).toBe('null');
    expect(formatError(undefined)).toBe('undefined');
  });

  it('handles Error without stack', () => {
    const err = new Error('no stack');
    err.stack = undefined;
    const result = formatError(err);
    expect(result).toBe('no stack');
    expect(result).not.toContain('Stack trace:');
  });

  it('handles deeply nested causes', () => {
    const inner = new Error('inner');
    const mid = new Error('mid', { cause: inner });
    const outer = new Error('outer', { cause: mid });
    const result = formatError(outer);
    expect(result).toContain('outer');
    expect(result).toContain('mid');
    expect(result).toContain('inner');
  });
});
