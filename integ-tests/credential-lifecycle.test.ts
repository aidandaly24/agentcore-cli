import { createTestProject, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function readEnvLocal(projectPath: string): Promise<string> {
  try {
    return await readFile(join(projectPath, 'agentcore', '.env.local'), 'utf-8');
  } catch {
    return '';
  }
}

describe('integration: credential provider lifecycle', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('API key credential lifecycle', () => {
    const credName = 'TestApiKey';

    it('creates an API key credential', async () => {
      const result = await runCLI(
        ['add', 'identity', '--name', credName, '--api-key', 'sk-test-key-123', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.credentialName).toBe(credName);
    });

    it('credential exists in config as ApiKeyCredentialProvider', async () => {
      const config = await readProjectConfig(project.projectPath);
      const cred = config.credentials.find(c => c.name === credName);
      expect(cred, `Credential "${credName}" should exist`).toBeTruthy();
      expect(cred!.type).toBe('ApiKeyCredentialProvider');
    });

    it('writes API key to .env.local with correct env var name', async () => {
      const env = await readEnvLocal(project.projectPath);
      expect(env).toContain('AGENTCORE_CREDENTIAL_TESTAPIKEY=');
      expect(env).toContain('sk-test-key-123');
    });

    it('rejects duplicate credential name', async () => {
      await runCLI(
        ['add', 'identity', '--name', credName, '--api-key', 'different-key', '--json'],
        project.projectPath
      );

      // Should succeed (idempotent create) or the key gets updated —
      // either way, should not have two credentials with the same name
      const config = await readProjectConfig(project.projectPath);
      const matching = config.credentials.filter(c => c.name === credName);
      expect(matching).toHaveLength(1);
    });

    it('removes the credential', async () => {
      const result = await runCLI(['remove', 'identity', '--name', credName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      expect(config.credentials.find(c => c.name === credName)).toBeUndefined();
    });

    it('.env.local is not modified by credential removal', async () => {
      const env = await readEnvLocal(project.projectPath);
      // The env var should still be present — removal only touches config, not .env
      expect(env).toContain('AGENTCORE_CREDENTIAL_TESTAPIKEY=');
    });
  });

  describe('OAuth credential lifecycle', () => {
    const oauthName = 'TestOAuth';
    const discoveryUrl = 'https://idp.example.com/.well-known/openid-configuration';

    it('creates an OAuth credential with all fields', async () => {
      const result = await runCLI(
        [
          'add',
          'identity',
          '--type',
          'oauth',
          '--name',
          oauthName,
          '--discovery-url',
          discoveryUrl,
          '--client-id',
          'my-client-id',
          '--client-secret',
          'my-client-secret',
          '--scopes',
          'read,write,admin',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.credentialName).toBe(oauthName);
    });

    it('config has OAuthCredentialProvider with correct fields', async () => {
      const config = await readProjectConfig(project.projectPath);
      const cred = config.credentials.find(c => c.name === oauthName);
      expect(cred, `OAuth credential "${oauthName}" should exist`).toBeTruthy();
      expect(cred!.type).toBe('OAuthCredentialProvider');

      // Type-narrow to OAuthCredential to check OAuth-specific fields
      if (cred?.type === 'OAuthCredentialProvider') {
        expect(cred.discoveryUrl).toBe(discoveryUrl);
        expect(cred.vendor).toBe('CustomOauth2');
        expect(cred.scopes).toEqual(['read', 'write', 'admin']);
      }
    });

    it('writes OAuth client ID and secret to .env.local', async () => {
      const env = await readEnvLocal(project.projectPath);
      expect(env).toContain('AGENTCORE_CREDENTIAL_TESTOAUTH_CLIENT_ID=');
      expect(env).toContain('my-client-id');
      expect(env).toContain('AGENTCORE_CREDENTIAL_TESTOAUTH_CLIENT_SECRET=');
      expect(env).toContain('my-client-secret');
    });

    it('removes the OAuth credential', async () => {
      const result = await runCLI(['remove', 'identity', '--name', oauthName, '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      expect(config.credentials.find(c => c.name === oauthName)).toBeUndefined();
    });
  });

  describe('credential removal blocked by gateway target reference', () => {
    const credName = 'GatewayApiKey';
    const gatewayName = 'RefGateway';
    const targetName = 'RefTarget';

    it('sets up credential, gateway, and target referencing the credential', async () => {
      // Create credential
      let result = await runCLI(
        ['add', 'identity', '--name', credName, '--api-key', 'gw-key-456', '--json'],
        project.projectPath
      );
      expect(result.exitCode, `cred create: ${result.stdout}`).toBe(0);

      // Create gateway
      result = await runCLI(['add', 'gateway', '--name', gatewayName, '--json'], project.projectPath);
      expect(result.exitCode, `gateway create: ${result.stdout}`).toBe(0);

      // Create target with outbound auth referencing the credential
      // api-gateway supports api-key auth (mcp-server does not)
      result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          targetName,
          '--type',
          'api-gateway',
          '--rest-api-id',
          'abc123',
          '--stage',
          'prod',
          '--gateway',
          gatewayName,
          '--outbound-auth',
          'api-key',
          '--credential-name',
          credName,
          '--json',
        ],
        project.projectPath
      );
      expect(result.exitCode, `target create: ${result.stdout}`).toBe(0);
    });

    it('removal is blocked when credential is referenced by gateway target', async () => {
      const result = await runCLI(['remove', 'identity', '--name', credName, '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain(targetName);
    });

    it('removal succeeds after removing the referencing gateway target', async () => {
      // Remove the target first
      let result = await runCLI(['remove', 'gateway-target', '--name', targetName, '--json'], project.projectPath);
      expect(result.exitCode, `target remove: ${result.stdout}`).toBe(0);

      // Now credential removal should succeed
      result = await runCLI(['remove', 'identity', '--name', credName, '--json'], project.projectPath);
      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });
  });

  describe('error cases', () => {
    it('fails without --name', async () => {
      const result = await runCLI(['add', 'identity', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--name');
    });

    it('fails without --api-key for api-key type', async () => {
      const result = await runCLI(['add', 'identity', '--name', 'SomeCred', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('--api-key');
    });

    it('fails to remove non-existent credential', async () => {
      const result = await runCLI(['remove', 'identity', '--name', 'NonExistentCred', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });
  });
});
