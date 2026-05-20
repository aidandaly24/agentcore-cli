/**
 * Tests for `validateInterceptors` in preflight.
 *
 * Cardinality / unique-point / gateway-name reference are covered in the
 * schema-level tests; this file focuses on the deploy-time-only checks:
 *   - managed-mode codeLocation must exist on disk
 *   - external-mode cross-account WARNS (not errors) and prints the snippet
 *   - account IDs in user-visible output go through maskAccountId
 */
import { validateInterceptors } from '../preflight';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const baseTarget = {
  name: 'default',
  account: '603141041947',
  region: 'us-east-1',
  profile: 'deploy',
} as unknown as Parameters<typeof validateInterceptors>[1][number];

function projectWithInterceptors(interceptors: unknown[]) {
  return {
    name: 'TestProject',
    version: 1,
    managedBy: 'CDK' as const,
    runtimes: [],
    memories: [],
    credentials: [],
    evaluators: [],
    onlineEvalConfigs: [],
    agentCoreGateways: [{ name: 'my-gw', targets: [] }],
    policyEngines: [],
    configBundles: [],
    abTests: [],
    httpGateways: [],
    interceptors,
  } as unknown as Parameters<typeof validateInterceptors>[0];
}

describe('validateInterceptors', () => {
  let tmp: string;
  let configRoot: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'preflight-interceptors-'));
    configRoot = join(tmp, 'agentcore');
    mkdirSync(configRoot, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('throws when a managed interceptor codeLocation is missing', async () => {
    const project = projectWithInterceptors([
      {
        name: 'auth-check',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { managed: { codeLocation: 'app/auth-check/' } },
      },
    ]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).rejects.toThrow(/codeLocation.*not found/);
  });

  it('passes when a managed interceptor codeLocation exists', async () => {
    mkdirSync(join(tmp, 'app', 'auth-check'), { recursive: true });
    const project = projectWithInterceptors([
      {
        name: 'auth-check',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { managed: { codeLocation: 'app/auth-check/' } },
      },
    ]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).resolves.toBeUndefined();
  });

  it('warns and continues for cross-account external interceptor', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const project = projectWithInterceptors([
      {
        name: 'central-auth',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:central-auth-prod' } },
      },
    ]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toMatch(/Cross-account interceptor detected/);
    expect(msg).toMatch(/aws lambda add-permission/);
    // Account IDs are masked.
    expect(msg).toMatch(/\*{4}1947/); // gateway account
    expect(msg).toMatch(/\*{4}1111/); // lambda account
    // Raw 12-digit IDs do NOT appear in the warning.
    expect(msg).not.toMatch(/\b603141041947\b/);
    expect(msg).not.toMatch(/\b111111111111\b/);
  });

  it('does not warn for same-account external interceptor', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const project = projectWithInterceptors([
      {
        name: 'in-account',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:603141041947:function:in-account' } },
      },
    ]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('is a no-op when there are no interceptors', async () => {
    const project = projectWithInterceptors([]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).resolves.toBeUndefined();
  });

  it('warns exactly once per cross-account interceptor across multiple targets', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const project = projectWithInterceptors([
      {
        name: 'central-auth',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:central-auth-prod' } },
      },
    ]);
    const secondTarget = { ...baseTarget, name: 'staging', account: '999999999999' } as typeof baseTarget;
    await expect(validateInterceptors(project, [baseTarget, secondTarget], configRoot)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('does NOT warn when at least one deploy target shares the Lambda account', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Lambda is in account 111111111111. baseTarget is 603141041947 (different).
    // sameAccountTarget shares the Lambda account — should suppress the warning.
    const project = projectWithInterceptors([
      {
        name: 'shared-auth',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: { external: { lambdaArn: 'arn:aws:lambda:us-east-1:111111111111:function:shared-auth' } },
      },
    ]);
    const sameAccountTarget = { ...baseTarget, name: 'lambda-account', account: '111111111111' } as typeof baseTarget;
    await expect(validateInterceptors(project, [baseTarget, sameAccountTarget], configRoot)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
