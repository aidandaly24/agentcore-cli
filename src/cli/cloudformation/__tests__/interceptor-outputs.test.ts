/**
 * Tests for parseInterceptorOutputs and the interceptor branch of buildDeployedState.
 *
 * The CDK construct emits the following CFN outputs (per Phase 1 wiring):
 *   - Interceptor{PascalName}ArnOutput
 *   - Interceptor{PascalName}ModeOutput
 *   - Interceptor{PascalName}RoleArnOutput      (managed-only)
 *   - Interceptor{PascalName}FunctionNameOutput (managed-only)
 *
 * The CFN output keys carry an auto-deduplication hash suffix ("Output3E11FAB4").
 * The parser uses startsWith to find the right key.
 */
import { buildDeployedState, parseInterceptorOutputs } from '../outputs';
import { describe, expect, it } from 'vitest';

describe('parseInterceptorOutputs', () => {
  it('parses managed-mode entries with all four fields', () => {
    const outputs = {
      InterceptorAuthCheckArnOutputAAAA: 'arn:aws:lambda:us-east-1:111111111111:function:p-interceptor-auth-check',
      InterceptorAuthCheckModeOutputBBBB: 'managed',
      InterceptorAuthCheckRoleArnOutputCCCC: 'arn:aws:iam::111111111111:role/auth-check-role',
      InterceptorAuthCheckFunctionNameOutputDDDD: 'p-interceptor-auth-check',
    };
    const result = parseInterceptorOutputs(outputs, [{ name: 'auth-check', mode: 'managed' }]);
    expect(result['auth-check']).toEqual({
      mode: 'managed',
      interceptorArn: 'arn:aws:lambda:us-east-1:111111111111:function:p-interceptor-auth-check',
      interceptorRoleArn: 'arn:aws:iam::111111111111:role/auth-check-role',
      interceptorFunctionName: 'p-interceptor-auth-check',
    });
  });

  it('parses external-mode entries with only mode + ARN', () => {
    const outputs = {
      InterceptorCentralAuthArnOutputAAAA: 'arn:aws:lambda:us-east-1:222222222222:function:central-auth',
      InterceptorCentralAuthModeOutputBBBB: 'external',
    };
    const result = parseInterceptorOutputs(outputs, [{ name: 'central-auth', mode: 'external' }]);
    expect(result['central-auth']).toEqual({
      mode: 'external',
      interceptorArn: 'arn:aws:lambda:us-east-1:222222222222:function:central-auth',
    });
    expect(result['central-auth']?.interceptorRoleArn).toBeUndefined();
    expect(result['central-auth']?.interceptorFunctionName).toBeUndefined();
  });

  it('returns an empty record when no interceptor outputs are present', () => {
    expect(parseInterceptorOutputs({}, [{ name: 'absent', mode: 'managed' }])).toEqual({});
  });

  it('skips entries missing the Arn or Mode output', () => {
    const outputs = {
      InterceptorIncompleteArnOutputAAAA: 'arn:aws:lambda:us-east-1:111111111111:function:incomplete',
      // Mode missing
    };
    expect(parseInterceptorOutputs(outputs, [{ name: 'incomplete', mode: 'managed' }])).toEqual({});
  });
});

describe('buildDeployedState — interceptor placement', () => {
  it('writes interceptors under mcp.interceptors when present', () => {
    const state = buildDeployedState({
      targetName: 'default',
      stackName: 'MyStack',
      agents: {},
      gateways: {},
      interceptors: {
        'auth-check': {
          mode: 'managed',
          interceptorArn: 'arn:aws:lambda:us-east-1:111111111111:function:auth-check',
          interceptorRoleArn: 'arn:aws:iam::111111111111:role/auth-check-role',
          interceptorFunctionName: 'auth-check',
        },
      },
    });
    expect(state.targets.default?.resources?.mcp?.interceptors?.['auth-check']?.mode).toBe('managed');
  });

  it('does not create an mcp block when both gateways and interceptors are empty', () => {
    const state = buildDeployedState({
      targetName: 'default',
      stackName: 'MyStack',
      agents: {},
      gateways: {},
    });
    expect(state.targets.default?.resources?.mcp).toBeUndefined();
  });

  it('co-locates gateways and interceptors under mcp', () => {
    const state = buildDeployedState({
      targetName: 'default',
      stackName: 'MyStack',
      agents: {},
      gateways: {
        'my-gw': { gatewayId: 'g-1', gatewayArn: 'arn:gw' },
      },
      interceptors: {
        'auth-check': {
          mode: 'external',
          interceptorArn: 'arn:aws:lambda:us-east-1:111111111111:function:auth-check',
        },
      },
    });
    expect(state.targets.default?.resources?.mcp?.gateways?.['my-gw']).toBeDefined();
    expect(state.targets.default?.resources?.mcp?.interceptors?.['auth-check']).toBeDefined();
  });
});
