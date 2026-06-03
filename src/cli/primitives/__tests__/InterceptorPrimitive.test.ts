/**
 * InterceptorPrimitive unit tests — schema + add/remove for both modes.
 *
 * Uses vi.mock to stub ConfigIO + findConfigRoot, mirroring the pattern in
 * EvaluatorPrimitive.test.ts so tests don't depend on a real filesystem.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadProjectSpec = vi.fn();
const mockWriteProjectSpec = vi.fn();
const renderInterceptorTemplateMock = vi.fn(() => Promise.resolve(undefined));

vi.mock('../../../lib/index.js', () => ({
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = mockWriteProjectSpec;
  },
  findConfigRoot: () => '/fake/root/agentcore',
  toError: (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
  serializeResult: (r: unknown) => r,
  ResourceNotFoundError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ResourceNotFoundError';
    }
  },
  ConflictError: class extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'ConflictError';
    }
  },
}));

vi.mock('../../templates/InterceptorRenderer', () => ({
  renderInterceptorTemplate: renderInterceptorTemplateMock,
}));

// Run the action callback inline (no telemetry, no process.exit) so command
// parsing — comma splitting and cross-flag rejection — can be asserted directly.
vi.mock('../../telemetry/cli-command-run.js', () => ({
  runCliCommand: async (_command: string, _json: boolean, fn: () => Promise<unknown>) => {
    await fn();
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(() => false) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rm: vi.fn(() => Promise.resolve(undefined)) };
});

const { InterceptorPrimitive } = await import('../InterceptorPrimitive');

function makeProject(interceptors: unknown[] = []) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [
      { name: 'my-gw', targets: [], authorizerType: 'NONE', enableSemanticSearch: true, exceptionLevel: 'NONE' },
    ],
    policyEngines: [],
    configBundles: [],
    abTests: [],
    httpGateways: [],
    interceptors,
  };
}

const primitive = new InterceptorPrimitive();

describe('InterceptorPrimitive', () => {
  beforeEach(() => {
    mockReadProjectSpec.mockReset();
    mockWriteProjectSpec.mockReset();
    renderInterceptorTemplateMock.mockReset();
    renderInterceptorTemplateMock.mockResolvedValue(undefined);
  });

  afterEach(() => vi.clearAllMocks());

  it('has correct kind/label/article', () => {
    expect(primitive.kind).toBe('interceptor');
    expect(primitive.label).toBe('Interceptor');
    // eslint-disable-next-line @typescript-eslint/dot-notation
    expect(primitive['article']).toBe('an');
  });

  describe('add', () => {
    it('rejects an unknown gateway reference', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      const result = await primitive.add({
        name: 'orphan',
        gatewayName: 'does-not-exist',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { managed: { codeLocation: 'app/orphan/' } },
      });
      expect(result.success).toBe(false);
    });

    it('adds an external interceptor without scaffolding code', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      const result = await primitive.add({
        name: 'central-auth',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: {
          external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:central-auth-prod' },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.interceptorName).toBe('central-auth');
        expect(result.codePath).toBeUndefined();
      }
      expect(renderInterceptorTemplateMock).not.toHaveBeenCalled();
      expect(mockWriteProjectSpec).toHaveBeenCalled();
    });

    it('renders a managed interceptor template (default pass-through)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      const result = await primitive.add({
        name: 'auth-check',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { managed: { codeLocation: 'app/auth-check/', runtime: 'python3.12' } },
      });
      expect(result.success).toBe(true);
      expect(renderInterceptorTemplateMock).toHaveBeenCalledWith(
        'auth-check',
        'python3.12',
        'pass-through',
        expect.stringContaining('app/auth-check')
      );
    });

    it('addWithTemplate forwards the explicit template (jwt-scope-authorizer)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      const result = await primitive.addWithTemplate(
        {
          name: 'jwt-auth',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          passRequestHeaders: true,
          config: { managed: { codeLocation: 'app/jwt-auth/', runtime: 'python3.12' } },
        },
        'jwt-scope-authorizer'
      );
      expect(result.success).toBe(true);
      expect(renderInterceptorTemplateMock).toHaveBeenCalledWith(
        'jwt-auth',
        'python3.12',
        'jwt-scope-authorizer',
        expect.stringContaining('app/jwt-auth')
      );
    });

    it('rejects a 3rd interceptor on the same gateway', async () => {
      const existing = [
        {
          name: 'one',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          passRequestHeaders: true,
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:one' } },
        },
        {
          name: 'two',
          gatewayName: 'my-gw',
          interceptionPoints: ['RESPONSE'],
          passRequestHeaders: true,
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:two' } },
        },
      ];
      mockReadProjectSpec.mockResolvedValue(makeProject(existing));
      const third = await primitive.add({
        name: 'three',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:three' } },
      });
      expect(third.success).toBe(false);
    });

    it('rejects a duplicate interception point on the same gateway', async () => {
      const existing = [
        {
          name: 'one',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          passRequestHeaders: true,
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:one' } },
        },
      ];
      mockReadProjectSpec.mockResolvedValue(makeProject(existing));
      const dup = await primitive.add({
        name: 'two',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:two' } },
      });
      expect(dup.success).toBe(false);
    });

    it('rejects a duplicate interceptor name', async () => {
      const existing = [
        {
          name: 'one',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          passRequestHeaders: true,
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:one' } },
        },
      ];
      mockReadProjectSpec.mockResolvedValue(makeProject(existing));
      const dup = await primitive.add({
        name: 'one', // duplicate
        gatewayName: 'my-gw',
        interceptionPoints: ['RESPONSE'],
        passRequestHeaders: true,
        config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:two' } },
      });
      expect(dup.success).toBe(false);
    });
  });

  describe('remove', () => {
    it('returns ResourceNotFoundError for unknown interceptor', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      const result = await primitive.remove('nope');
      expect(result.success).toBe(false);
    });

    it('removes an external interceptor without filesystem side effects', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          {
            name: 'central-auth',
            gatewayName: 'my-gw',
            interceptionPoints: ['REQUEST'],
            passRequestHeaders: true,
            config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:central-auth' } },
          },
        ])
      );
      const result = await primitive.remove('central-auth');
      expect(result.success).toBe(true);

      // Verify the spec written back has the interceptor stripped.
      const written = mockWriteProjectSpec.mock.calls[0]?.[0];
      expect(written?.interceptors).toEqual([]);
    });
  });

  describe('previewRemove', () => {
    it('reports no directoriesToDelete for external interceptors', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          {
            name: 'central-auth',
            gatewayName: 'my-gw',
            interceptionPoints: ['REQUEST'],
            passRequestHeaders: true,
            config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:central-auth' } },
          },
        ])
      );
      const preview = await primitive.previewRemove('central-auth');
      expect(preview.directoriesToDelete).toEqual([]);
    });
  });

  describe('add interceptor command (--additional-policies)', () => {
    async function runAdd(args: string[]) {
      const { Command } = await import('@commander-js/extra-typings');
      const program = new Command();
      program.exitOverride();
      const addCmd = program.command('add');
      const removeCmd = program.command('remove');
      primitive.registerCommands(addCmd, removeCmd);
      await program.parseAsync(['add', 'interceptor', ...args], { from: 'user' });
    }

    it('parses comma-separated --additional-policies into config.managed.additionalPolicies', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      await runAdd([
        '--name',
        'auth-check',
        '--gateway',
        'my-gw',
        '--interception-points',
        'REQUEST',
        '--additional-policies',
        'execution-role-policy.json, arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
      ]);

      const written = mockWriteProjectSpec.mock.calls[0]?.[0];
      const added = written?.interceptors?.find((i: { name: string }) => i.name === 'auth-check');
      expect(added.config.managed.additionalPolicies).toEqual([
        'execution-role-policy.json',
        'arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess',
      ]);
    });

    it('omits additionalPolicies from agentcore.json when not provided', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      await runAdd(['--name', 'auth-check', '--gateway', 'my-gw', '--interception-points', 'REQUEST']);

      const written = mockWriteProjectSpec.mock.calls[0]?.[0];
      const added = written?.interceptors?.find((i: { name: string }) => i.name === 'auth-check');
      expect(added.config.managed).not.toHaveProperty('additionalPolicies');
    });

    it('rejects --additional-policies with --lambda-arn (external mode)', async () => {
      mockReadProjectSpec.mockResolvedValue(makeProject());
      await expect(
        runAdd([
          '--name',
          'central-auth',
          '--gateway',
          'my-gw',
          '--interception-points',
          'REQUEST',
          '--lambda-arn',
          'arn:aws:lambda:us-east-1:111111111111:function:central-auth',
          '--additional-policies',
          'execution-role-policy.json',
        ])
      ).rejects.toThrow('--additional-policies cannot be used with --lambda-arn');
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });
  });

  describe('getRemovable / getAllNames', () => {
    it('returns the names list', async () => {
      mockReadProjectSpec.mockResolvedValue(
        makeProject([
          {
            name: 'a',
            gatewayName: 'my-gw',
            interceptionPoints: ['REQUEST'],
            passRequestHeaders: true,
            config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:a' } },
          },
          {
            name: 'b',
            gatewayName: 'my-gw',
            interceptionPoints: ['RESPONSE'],
            passRequestHeaders: true,
            config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:b' } },
          },
        ])
      );
      const names = await primitive.getAllNames();
      expect(names).toEqual(['a', 'b']);
      const removable = await primitive.getRemovable();
      expect(removable).toEqual([{ name: 'a' }, { name: 'b' }]);
    });
  });
});
