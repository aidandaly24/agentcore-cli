import { runCLI } from '../../../../test-utils/index.js';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `run eval --runtime-arn` is standalone (ARN) mode and must not require an
 * agentcore project. Builtin.* evaluators are supported in ARN mode via
 * -e/--evaluator, so supplying --runtime-arn alone (without --evaluator-arn)
 * must pass the project gate. These tests drive the built CLI from a non-project
 * directory so they exercise the real commander registration and in-action guard.
 */
describe('run eval command — ARN-mode project gating', () => {
  let testDir: string;
  const arn = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my-runtime-abc123';

  beforeAll(async () => {
    testDir = join(tmpdir(), `agentcore-run-eval-arn-${randomUUID()}`);
    await mkdir(testDir, { recursive: true });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('does not require a project for --runtime-arn with a Builtin.* evaluator', async () => {
    const result = await runCLI(
      ['run', 'eval', '--runtime-arn', arn, '--evaluator', 'Builtin.Correctness', '--region', 'us-east-1', '--json'],
      testDir
    );
    expect(`${result.stdout} ${result.stderr}`).not.toContain('No agentcore project found.');
  });

  it('rejects a custom evaluator in ARN mode with the resolveFromArn error, not the project-missing error', async () => {
    const result = await runCLI(
      ['run', 'eval', '--runtime-arn', arn, '--evaluator', 'my-custom-eval', '--region', 'us-east-1', '--json'],
      testDir
    );
    const combined = `${result.stdout} ${result.stderr}`;
    expect(combined).not.toContain('No agentcore project found.');
    expect(combined).toContain('cannot be resolved in ARN mode');
  });
});
