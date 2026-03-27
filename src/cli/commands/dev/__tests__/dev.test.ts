import { runCLI } from '../../../../test-utils/index.js';
import { describe, expect, it } from 'vitest';

describe('dev command', () => {
  describe('--help', () => {
    it('shows all options', async () => {
      const result = await runCLI(['dev', '--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('[prompt]'), 'Should show [prompt] positional argument').toBeTruthy();
      expect(result.stdout.includes('--port'), 'Should show --port option').toBeTruthy();
      expect(result.stdout.includes('--agent'), 'Should show --agent option').toBeTruthy();
      expect(result.stdout.includes('--stream'), 'Should show --stream option').toBeTruthy();
      expect(result.stdout.includes('--logs'), 'Should show --logs option').toBeTruthy();
      expect(result.stdout.includes('8080'), 'Should show default port').toBeTruthy();
    });

    it('does not show --invoke flag', async () => {
      const result = await runCLI(['dev', '--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('--invoke'), 'Should not show removed --invoke option').toBeFalsy();
    });
  });

  describe('requires project context', () => {
    it('exits with error when run outside project', async () => {
      const result = await runCLI(['dev'], process.cwd());

      expect(result.exitCode).toBe(1);
      expect(
        result.stdout.toLowerCase().includes('project') || result.stderr.toLowerCase().includes('project'),
        `Should mention project requirement, got: ${result.stdout}`
      ).toBeTruthy();
    });
  });

  describe('positional prompt invoke', () => {
    it('attempts invoke when positional prompt is provided', async () => {
      // With no dev server running, the invoke path triggers a connection error
      const result = await runCLI(['dev', 'Hello agent'], process.cwd());

      expect(result.exitCode).toBe(1);
      // Should attempt to connect to dev server and fail — not show a project error
      const output = result.stderr.toLowerCase();
      expect(
        output.includes('fetch failed') || output.includes('econnrefused') || output.includes('dev server not running'),
        `Should attempt invoke and fail with connection error, got: ${result.stderr}`
      ).toBeTruthy();
    });

    it('does not require project context when invoking', async () => {
      // Invoke path loads config but does not call requireProject()
      // So the error should be about connection, not missing project
      const result = await runCLI(['dev', 'test prompt'], process.cwd());

      expect(result.exitCode).toBe(1);
      const output = result.stderr.toLowerCase();
      expect(
        !output.includes('no agentcore project found'),
        `Should not fail with project error when prompt is provided, got: ${result.stderr}`
      ).toBeTruthy();
    });
  });

  describe('flag validation', () => {
    it('rejects invalid port number', async () => {
      const result = await runCLI(['dev', '--port', 'abc'], process.cwd());

      expect(result.exitCode).toBe(1);
    });

    it('rejects negative port number', async () => {
      const result = await runCLI(['dev', '--port', '-1'], process.cwd());

      expect(result.exitCode).toBe(1);
    });

    it('stream flag is documented in help', async () => {
      const result = await runCLI(['dev', '--help'], process.cwd());

      expect(result.exitCode).toBe(0);
      expect(result.stdout.includes('--stream'), 'Should show --stream option').toBeTruthy();
    });
  });
});
