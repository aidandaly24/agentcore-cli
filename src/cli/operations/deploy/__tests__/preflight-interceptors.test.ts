/**
 * Tests for `validateInterceptors` in preflight.
 *
 * Cardinality / unique-point / gateway-name reference are covered in the
 * schema-level tests; this file focuses on the deploy-time-only checks:
 *   - managed-mode codeLocation must exist on disk
 *   - external-mode cross-account WARNS (not errors) and prints the snippet
 *   - account IDs in user-visible output go through maskAccountId
 */
import { buildCrossAccountInterceptorWarnings, validateInterceptors } from '../preflight';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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
    // Preflight emits a concise heads-up; the full resolved add-permission
    // snippet is produced post-deploy by buildCrossAccountInterceptorWarnings.
    expect(msg).toMatch(/Cross-account interceptor "central-auth"/);
    expect(msg).toMatch(/add-permission/);
    // The foreign Lambda account is masked; raw 12-digit ID never appears.
    expect(msg).toMatch(/\*{4}1111/);
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

  /** Scaffold a managed interceptor's handler file with the given source. */
  function writeHandler(codeLocation: string, file: string, source: string) {
    const dir = join(tmp, codeLocation);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), source);
  }

  it('warns when passRequestHeaders is disabled but the handler reads headers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeHandler(
      'app/auth-check/',
      'handler.py',
      'def lambda_handler(event, ctx):\n    return event["mcp"]["gatewayRequest"]["headers"]["authorization"]\n'
    );
    const project = projectWithInterceptors([
      {
        name: 'auth-check',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: false,
        config: {
          managed: { codeLocation: 'app/auth-check/', entrypoint: 'handler.lambda_handler', runtime: 'python3.12' },
        },
      },
    ]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0]![0] as string).toMatch(/passRequestHeaders disabled.*reads request headers/s);
  });

  it('does NOT warn when passRequestHeaders is disabled and the handler ignores headers', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeHandler(
      'app/noop/',
      'handler.py',
      'def lambda_handler(event, ctx):\n    return {"interceptorOutputVersion": "1.0", "mcp": {}}\n'
    );
    const project = projectWithInterceptors([
      {
        name: 'noop',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: false,
        config: { managed: { codeLocation: 'app/noop/', entrypoint: 'handler.lambda_handler', runtime: 'python3.12' } },
      },
    ]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when the handler reads headers but passRequestHeaders is enabled', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeHandler(
      'app/auth-on/',
      'handler.py',
      'def lambda_handler(event, ctx):\n    return event["mcp"]["gatewayRequest"]["headers"]["authorization"]\n'
    );
    const project = projectWithInterceptors([
      {
        name: 'auth-on',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        passRequestHeaders: true,
        config: {
          managed: { codeLocation: 'app/auth-on/', entrypoint: 'handler.lambda_handler', runtime: 'python3.12' },
        },
      },
    ]);
    await expect(validateInterceptors(project, [baseTarget], configRoot)).resolves.toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('buildCrossAccountInterceptorWarnings', () => {
  const extInterceptor = (gatewayName: string, account: string) => ({
    name: 'central-auth',
    gatewayName,
    interceptionPoints: ['REQUEST'],
    config: { external: { lambdaArn: `arn:aws:lambda:us-east-1:${account}:function:central-auth` } },
  });

  it('emits a resolved add-permission snippet for a cross-account external interceptor', () => {
    const project = projectWithInterceptors([extInterceptor('my-gw', '111111111111')]);
    const warnings = buildCrossAccountInterceptorWarnings(project, [baseTarget], {
      'my-gw': 'arn:aws:iam::603141041947:role/gw-exec',
    });
    expect(warnings).toHaveLength(1);
    // The OWN-account gateway role ARN is printed UNMASKED (must be copy-pasteable).
    expect(warnings[0]).toContain('arn:aws:iam::603141041947:role/gw-exec');
    expect(warnings[0]).toMatch(/aws lambda add-permission/);
    // The FOREIGN Lambda account is masked.
    expect(warnings[0]).toMatch(/\*{4}1111/);
    expect(warnings[0]).not.toMatch(/\b111111111111\b/);
  });

  it('falls back to a placeholder when the gateway role ARN is unresolved', () => {
    const project = projectWithInterceptors([extInterceptor('my-gw', '111111111111')]);
    const warnings = buildCrossAccountInterceptorWarnings(project, [baseTarget], { 'my-gw': undefined });
    expect(warnings[0]).toMatch(/<gateway-role-arn/);
  });

  it('emits nothing for same-account or managed interceptors', () => {
    const sameAccount = projectWithInterceptors([extInterceptor('my-gw', '603141041947')]);
    expect(buildCrossAccountInterceptorWarnings(sameAccount, [baseTarget], {})).toHaveLength(0);

    const managed = projectWithInterceptors([
      {
        name: 'm',
        gatewayName: 'my-gw',
        interceptionPoints: ['REQUEST'],
        config: { managed: { codeLocation: 'app/m/' } },
      },
    ]);
    expect(buildCrossAccountInterceptorWarnings(managed, [baseTarget], {})).toHaveLength(0);
  });
});
