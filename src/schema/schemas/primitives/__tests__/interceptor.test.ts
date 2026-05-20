/**
 * Schema-level tests for InterceptorSchema and project-level cross-references.
 */
import { AgentCoreProjectSpecSchema } from '../../agentcore-project';
import { InterceptorSchema } from '../interceptor';
import { describe, expect, it } from 'vitest';

describe('InterceptorSchema', () => {
  it('accepts a managed entry with required defaults applied', () => {
    const r = InterceptorSchema.safeParse({
      name: 'auth-check',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: { managed: { codeLocation: 'app/auth-check/' } },
    });
    expect(r.success).toBe(true);
    if (r.success) {
      // Defaults apply
      expect(r.data.passRequestHeaders).toBe(true);
      expect(r.data.config.managed?.runtime).toBe('python3.12');
      expect(r.data.config.managed?.timeoutSeconds).toBe(30);
    }
  });

  it('accepts an external entry with a literal Lambda ARN', () => {
    const r = InterceptorSchema.safeParse({
      name: 'central-auth',
      gatewayName: 'my-gw',
      interceptionPoints: ['RESPONSE'],
      config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:central-auth-prod' } },
    });
    expect(r.success).toBe(true);
  });

  it('accepts both REQUEST and RESPONSE on a single entry', () => {
    const r = InterceptorSchema.safeParse({
      name: 'dual',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST', 'RESPONSE'],
      config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:dual' } },
    });
    expect(r.success).toBe(true);
  });

  it('rejects when both managed and external are set', () => {
    const r = InterceptorSchema.safeParse({
      name: 'broken',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: {
        managed: { codeLocation: 'app/broken/' },
        external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:broken' },
      },
    });
    expect(r.success).toBe(false);
  });

  it('rejects when neither managed nor external is set', () => {
    const r = InterceptorSchema.safeParse({
      name: 'empty',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: {},
    });
    expect(r.success).toBe(false);
  });

  it('rejects a malformed Lambda ARN', () => {
    const r = InterceptorSchema.safeParse({
      name: 'bad-arn',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: { external: { lambdaArn: 'not-an-arn' } },
    });
    expect(r.success).toBe(false);
  });

  it('rejects a Lambda ARN with a version qualifier', () => {
    const r = InterceptorSchema.safeParse({
      name: 'qualified',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:my-fn:1' } },
    });
    expect(r.success).toBe(false);
  });

  it('rejects names longer than 24 chars', () => {
    const r = InterceptorSchema.safeParse({
      name: 'a'.repeat(25),
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:a' } },
    });
    expect(r.success).toBe(false);
  });

  it('rejects names that start with a digit', () => {
    const r = InterceptorSchema.safeParse({
      name: '1leading',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:a' } },
    });
    expect(r.success).toBe(false);
  });

  it('accepts ARNs from non-aws partitions', () => {
    const r = InterceptorSchema.safeParse({
      name: 'gov',
      gatewayName: 'my-gw',
      interceptionPoints: ['REQUEST'],
      config: { external: { lambdaArn: 'arn:aws-us-gov:lambda:us-gov-west-1:111111111111:function:gov-auth' } },
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Project-level cross-field rules
// ---------------------------------------------------------------------------

const baseProject = {
  name: 'TestProject',
  version: 1,
  managedBy: 'CDK',
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
};

describe('AgentCoreProjectSpec — interceptor cross-field rules', () => {
  it('rejects an unknown gatewayName reference', () => {
    const r = AgentCoreProjectSpecSchema.safeParse({
      ...baseProject,
      interceptors: [
        {
          name: 'orphan',
          gatewayName: 'does-not-exist',
          interceptionPoints: ['REQUEST'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:a' } },
        },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.message).toMatch(/unknown gateway/);
    }
  });

  it('rejects a 3rd interceptor on the same gateway', () => {
    const r = AgentCoreProjectSpecSchema.safeParse({
      ...baseProject,
      interceptors: [
        {
          name: 'one',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:one' } },
        },
        {
          name: 'two',
          gatewayName: 'my-gw',
          interceptionPoints: ['RESPONSE'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:two' } },
        },
        {
          name: 'three',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:three' } },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate interception points on the same gateway', () => {
    const r = AgentCoreProjectSpecSchema.safeParse({
      ...baseProject,
      interceptors: [
        {
          name: 'one',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:one' } },
        },
        {
          name: 'two',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:two' } },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('rejects duplicate interceptor names', () => {
    const r = AgentCoreProjectSpecSchema.safeParse({
      ...baseProject,
      interceptors: [
        {
          name: 'one',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:one' } },
        },
        {
          name: 'one', // duplicate
          gatewayName: 'my-gw',
          interceptionPoints: ['RESPONSE'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:two' } },
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it('accepts an empty interceptors array (default-empty)', () => {
    const r = AgentCoreProjectSpecSchema.safeParse({ ...baseProject, interceptors: [] });
    expect(r.success).toBe(true);
  });

  it('accepts a valid mixed-mode pair on the same gateway', () => {
    const r = AgentCoreProjectSpecSchema.safeParse({
      ...baseProject,
      interceptors: [
        {
          name: 'managed-req',
          gatewayName: 'my-gw',
          interceptionPoints: ['REQUEST'],
          config: { managed: { codeLocation: 'app/managed-req/' } },
        },
        {
          name: 'ext-resp',
          gatewayName: 'my-gw',
          interceptionPoints: ['RESPONSE'],
          config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:ext-resp' } },
        },
      ],
    });
    expect(r.success).toBe(true);
  });
});
