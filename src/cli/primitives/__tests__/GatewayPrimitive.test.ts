import type { AgentCoreProjectSpec } from '../../../schema';
import { GatewayPrimitive } from '../GatewayPrimitive';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const defaultProject: AgentCoreProjectSpec = {
  name: 'test',
  version: 1,
  managedBy: 'CDK' as const,
  runtimes: [],
  memories: [],
  credentials: [],
  evaluators: [],
  onlineEvalConfigs: [],
  agentCoreGateways: [],
  policyEngines: [],
  configBundles: [],
  abTests: [],
  httpGateways: [],
  harnesses: [],
  datasets: [],
  payments: [],
  interceptors: [],
};

const { mockConfigExists, mockReadProjectSpec, mockWriteProjectSpec, mockRm } = vi.hoisted(() => ({
  mockConfigExists: vi.fn().mockReturnValue(true),
  mockReadProjectSpec: vi.fn(),
  mockWriteProjectSpec: vi.fn().mockResolvedValue(undefined),
  mockRm: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../lib', () => {
  const MockConfigIO = vi.fn(function (this: Record<string, unknown>) {
    this.configExists = mockConfigExists;
    this.readProjectSpec = mockReadProjectSpec;
    this.writeProjectSpec = mockWriteProjectSpec;
  });
  return {
    ConfigIO: MockConfigIO,
    findConfigRoot: vi.fn().mockReturnValue('/fake/root'),
    setEnvVar: vi.fn().mockResolvedValue(undefined),
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
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: vi.fn(() => true) };
});

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rm: mockRm };
});

/** Extract the first gateway written to writeProjectSpec. */
function getWrittenGateway() {
  expect(mockWriteProjectSpec).toHaveBeenCalledTimes(1);
  const spec = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
  const gw = spec.agentCoreGateways[0];
  expect(gw).toBeDefined();
  return gw!;
}

describe('GatewayPrimitive', () => {
  let primitive: GatewayPrimitive;

  beforeEach(() => {
    vi.clearAllMocks();
    mockReadProjectSpec.mockImplementation(() => Promise.resolve({ ...defaultProject, agentCoreGateways: [] }));
    primitive = new GatewayPrimitive();
  });

  describe('customClaims pipeline', () => {
    const SAMPLE_CLAIMS = [
      {
        inboundTokenClaimName: 'department',
        inboundTokenClaimValueType: 'STRING_ARRAY' as const,
        authorizingClaimMatchValue: {
          claimMatchOperator: 'CONTAINS_ANY' as const,
          claimMatchValue: { matchValueStringList: ['engineering', 'sales'] },
        },
      },
    ];

    it('custom claims from TUI flow are written to authorizerConfiguration', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: 'aud1',
        customClaims: SAMPLE_CLAIMS,
      });

      const gw = getWrittenGateway();
      expect(gw.authorizerConfiguration?.customJwtAuthorizer).toBeDefined();
      expect(gw.authorizerConfiguration!.customJwtAuthorizer!.customClaims).toEqual(SAMPLE_CLAIMS);
    });

    it('custom claims are preserved alongside audience and clients', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: 'aud1,aud2',
        allowedClients: 'client1',
        customClaims: SAMPLE_CLAIMS,
      });

      const gw = getWrittenGateway();
      const jwtConfig = gw.authorizerConfiguration!.customJwtAuthorizer!;
      expect(jwtConfig.allowedAudience).toEqual(['aud1', 'aud2']);
      expect(jwtConfig.allowedClients).toEqual(['client1']);
      expect(jwtConfig.customClaims).toEqual(SAMPLE_CLAIMS);
    });

    it('omits customClaims from authorizerConfiguration when not provided', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        allowedAudience: 'aud1',
      });

      const gw = getWrittenGateway();
      expect(gw.authorizerConfiguration!.customJwtAuthorizer!.customClaims).toBeUndefined();
    });

    it('custom claims only (no audience/clients/scopes) produces valid config', async () => {
      await primitive.add({
        name: 'jwt-gw',
        authorizerType: 'CUSTOM_JWT',
        discoveryUrl: 'https://example.com/.well-known/openid-configuration',
        customClaims: SAMPLE_CLAIMS,
      });

      const gw = getWrittenGateway();
      const jwtConfig = gw.authorizerConfiguration!.customJwtAuthorizer!;
      expect(jwtConfig.allowedAudience).toBeUndefined();
      expect(jwtConfig.allowedClients).toBeUndefined();
      expect(jwtConfig.allowedScopes).toBeUndefined();
      expect(jwtConfig.customClaims).toEqual(SAMPLE_CLAIMS);
    });
  });

  describe('exceptionLevel', () => {
    it('defaults to exceptionLevel NONE', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('NONE');
    });

    it('exceptionLevel DEBUG passes through', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE', exceptionLevel: 'DEBUG' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('DEBUG');
    });

    it('invalid exceptionLevel falls back to NONE', async () => {
      await primitive.add({ name: 'test-gw', authorizerType: 'NONE', exceptionLevel: 'VERBOSE' });

      const gw = getWrittenGateway();
      expect(gw.exceptionLevel).toBe('NONE');
    });
  });

  describe('remove with attached interceptors', () => {
    const projectWithInterceptors = (deleteReady = true) => ({
      ...defaultProject,
      agentCoreGateways: [{ name: 'my-gw', targets: [] }],
      interceptors: [
        {
          name: 'auth',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          config: { managed: { codeLocation: 'app/auth/' } },
        },
        {
          name: 'ext',
          gatewayName: 'my-gw',
          interceptionPoints: ['RESPONSE'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:ext' } },
        },
        ...(deleteReady ? [] : []),
      ],
    });

    it('blocks removal by default with a ConflictError naming the interceptors', async () => {
      mockReadProjectSpec.mockResolvedValue(projectWithInterceptors());
      const result = await primitive.remove('my-gw');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.name).toBe('ConflictError');
        expect(result.error.message).toMatch(/attached interceptor/);
        expect(result.error.message).toMatch(/auth, ext/);
        expect(result.error.message).toMatch(/--delete-interceptors/);
      }
      expect(mockWriteProjectSpec).not.toHaveBeenCalled();
    });

    it('cascades removal with --delete-interceptors: drops entries + deletes managed dirs', async () => {
      mockReadProjectSpec.mockResolvedValue(projectWithInterceptors());
      const result = await primitive.remove('my-gw', { deleteInterceptors: true });
      expect(result.success).toBe(true);

      const written = mockWriteProjectSpec.mock.calls[0]![0] as AgentCoreProjectSpec;
      expect(written.agentCoreGateways).toHaveLength(0);
      expect(written.interceptors).toHaveLength(0);
      // Only the managed interceptor has a scaffolded dir to delete (external has none).
      expect(mockRm).toHaveBeenCalledTimes(1);
      expect(mockRm).toHaveBeenCalledWith(expect.stringContaining('app/auth'), expect.anything());
    });

    it('removes a gateway with no interceptors without blocking', async () => {
      mockReadProjectSpec.mockResolvedValue({
        ...defaultProject,
        agentCoreGateways: [{ name: 'lonely-gw', targets: [] }],
        interceptors: [],
      });
      const result = await primitive.remove('lonely-gw');
      expect(result.success).toBe(true);
    });

    it('previewRemove lists attached interceptors and their directories', async () => {
      mockReadProjectSpec.mockResolvedValue(projectWithInterceptors());
      const preview = await primitive.previewRemove('my-gw');
      expect(preview.summary.some(s => s.includes('attached interceptor'))).toBe(true);
      expect(preview.summary.some(s => s.includes('auth, ext'))).toBe(true);
      expect(preview.directoriesToDelete).toContain('app/auth/');
    });
  });
});
