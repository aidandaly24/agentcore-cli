import { createTestProject, exists, readProjectConfig, runCLI } from '../src/test-utils/index.js';
import type { TestProject } from '../src/test-utils/index.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('integration: multi-agent project workflows', () => {
  let project: TestProject;

  beforeAll(async () => {
    project = await createTestProject({ noAgent: true });
  });

  afterAll(async () => {
    await project.cleanup();
  });

  describe('adding multiple agents to a single project', () => {
    it('adds a Strands/Bedrock agent', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'StrandsAgent',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.agentName).toBe('StrandsAgent');
    });

    it('adds a LangGraph/Bedrock agent', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'LangGraphAgent',
          '--language',
          'Python',
          '--framework',
          'LangChain_LangGraph',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
      expect(json.agentName).toBe('LangGraphAgent');
    });

    it('adds an MCP protocol agent', async () => {
      const result = await runCLI(
        ['add', 'agent', '--name', 'McpAgent', '--protocol', 'MCP', '--language', 'Python', '--json'],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('adds a BYO agent alongside template agents', async () => {
      const byoDir = join(project.projectPath, 'app', 'ByoAgent');
      await mkdir(byoDir, { recursive: true });
      await writeFile(join(byoDir, 'main.py'), '# BYO agent entry point');

      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'ByoAgent',
          '--type',
          'byo',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--code-location',
          'app/ByoAgent/',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('has all four agents in config with correct attributes', async () => {
      const config = await readProjectConfig(project.projectPath);
      expect(config.agents).toHaveLength(4);

      const strands = config.agents.find(a => a.name === 'StrandsAgent');
      expect(strands, 'StrandsAgent should exist').toBeTruthy();
      expect(strands!.protocol).toBe('HTTP');

      const langgraph = config.agents.find(a => a.name === 'LangGraphAgent');
      expect(langgraph, 'LangGraphAgent should exist').toBeTruthy();
      expect(langgraph!.protocol).toBe('HTTP');

      const mcp = config.agents.find(a => a.name === 'McpAgent');
      expect(mcp, 'McpAgent should exist').toBeTruthy();
      expect(mcp!.protocol).toBe('MCP');

      const byo = config.agents.find(a => a.name === 'ByoAgent');
      expect(byo, 'ByoAgent should exist').toBeTruthy();
      expect(byo!.codeLocation).toBe('app/ByoAgent/');
    });

    it('MCP agent creates no credentials', async () => {
      const config = await readProjectConfig(project.projectPath);
      const credNames = config.credentials.map(c => c.name);
      const mcpCreds = credNames.filter(n => n.toLowerCase().includes('mcp'));
      expect(mcpCreds, 'MCP agent should not create any credentials').toHaveLength(0);
    });

    it('creates separate code directories for each agent', async () => {
      expect(await exists(join(project.projectPath, 'app', 'StrandsAgent')), 'StrandsAgent dir').toBe(true);
      expect(await exists(join(project.projectPath, 'app', 'LangGraphAgent')), 'LangGraphAgent dir').toBe(true);
      expect(await exists(join(project.projectPath, 'app', 'McpAgent')), 'McpAgent dir').toBe(true);
      expect(await exists(join(project.projectPath, 'app', 'ByoAgent')), 'ByoAgent dir').toBe(true);
    });

    it('rejects duplicate agent name', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'StrandsAgent',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('already exists');
    });
  });

  describe('mixed agents with shared resources', () => {
    it('adds a memory resource', async () => {
      const result = await runCLI(['add', 'memory', '--name', 'SharedMemory', '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('adds a gateway', async () => {
      const result = await runCLI(['add', 'gateway', '--name', 'SharedGateway', '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('adds a gateway target', async () => {
      const result = await runCLI(
        [
          'add',
          'gateway-target',
          '--name',
          'McpTarget',
          '--type',
          'mcp-server',
          '--endpoint',
          'https://example.com/mcp',
          '--gateway',
          'SharedGateway',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('config contains all agents and shared resources together', async () => {
      const config = await readProjectConfig(project.projectPath);

      expect(config.agents).toHaveLength(4);

      const memories = config.memories as { name: string }[];
      expect(
        memories.some(m => m.name === 'SharedMemory'),
        'SharedMemory should exist'
      ).toBe(true);

      const gateways = config.agentCoreGateways as { name: string; targets?: { name: string }[] }[];
      const gw = gateways.find(g => g.name === 'SharedGateway');
      expect(gw, 'SharedGateway should exist').toBeTruthy();
      expect(
        gw!.targets!.some(t => t.name === 'McpTarget'),
        'McpTarget should exist in gateway'
      ).toBe(true);
    });

    it('validates the multi-agent project successfully', async () => {
      const result = await runCLI(['validate'], project.projectPath);

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    });
  });

  describe('selective agent removal preserves other agents and resources', () => {
    it('removes the MCP agent', async () => {
      const result = await runCLI(['remove', 'agent', '--name', 'McpAgent', '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);
    });

    it('remaining agents and resources are intact', async () => {
      const config = await readProjectConfig(project.projectPath);

      // 3 agents remain (StrandsAgent, LangGraphAgent, ByoAgent)
      expect(config.agents).toHaveLength(3);
      expect(
        config.agents.find(a => a.name === 'StrandsAgent'),
        'StrandsAgent should remain'
      ).toBeTruthy();
      expect(
        config.agents.find(a => a.name === 'LangGraphAgent'),
        'LangGraphAgent should remain'
      ).toBeTruthy();
      expect(
        config.agents.find(a => a.name === 'ByoAgent'),
        'ByoAgent should remain'
      ).toBeTruthy();
      expect(
        config.agents.find(a => a.name === 'McpAgent'),
        'McpAgent should be gone'
      ).toBeFalsy();

      // Shared resources preserved
      const memories = config.memories as { name: string }[];
      expect(
        memories.some(m => m.name === 'SharedMemory'),
        'Memory should remain'
      ).toBe(true);

      const gateways = config.agentCoreGateways as { name: string }[];
      expect(
        gateways.some(g => g.name === 'SharedGateway'),
        'Gateway should remain'
      ).toBe(true);
    });

    it('project still validates after selective removal', async () => {
      const result = await runCLI(['validate'], project.projectPath);

      expect(result.exitCode, `stderr: ${result.stderr}`).toBe(0);
    });

    it('can re-add an agent with a previously removed name', async () => {
      // Re-add with Strands/Bedrock + memory:none to avoid resource collisions
      // from the original MCP template's auto-created resources (which are preserved on removal)
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'McpAgent',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      expect(config.agents).toHaveLength(4);
      expect(
        config.agents.find(a => a.name === 'McpAgent'),
        'Re-added McpAgent should exist'
      ).toBeTruthy();
    });
  });

  describe('mixed model providers with credential isolation', () => {
    it('adds a Gemini agent (creates project-scoped credential)', async () => {
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'GeminiAgent1',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Gemini',
          '--api-key',
          'GEMINI_KEY_1',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      const credNames = config.credentials.map(c => c.name);
      expect(
        credNames.some(n => n.includes('Gemini')),
        'Should have a Gemini credential'
      ).toBe(true);
    });

    it('adds a second Gemini agent with same key (reuses credential)', async () => {
      const configBefore = await readProjectConfig(project.projectPath);
      const credCountBefore = configBefore.credentials.length;

      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'GeminiAgent2',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Gemini',
          '--api-key',
          'GEMINI_KEY_1',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      expect(config.credentials).toHaveLength(credCountBefore);
    });

    it('adds an OpenAI agent with different key (creates separate credential)', async () => {
      const configBefore = await readProjectConfig(project.projectPath);
      const credCountBefore = configBefore.credentials.length;

      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'OpenAIAgent',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'OpenAI',
          '--api-key',
          'OPENAI_KEY_1',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      expect(config.credentials.length).toBeGreaterThan(credCountBefore);

      const credNames = config.credentials.map(c => c.name);
      expect(
        credNames.some(n => n.includes('OpenAI')),
        'Should have an OpenAI credential'
      ).toBe(true);
    });

    it('removing an agent preserves its credential for potential reuse', async () => {
      const configBefore = await readProjectConfig(project.projectPath);
      const credCountBefore = configBefore.credentials.length;

      const result = await runCLI(['remove', 'agent', '--name', 'OpenAIAgent', '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);

      const config = await readProjectConfig(project.projectPath);
      expect(config.credentials).toHaveLength(credCountBefore);
      expect(
        config.agents.find(a => a.name === 'OpenAIAgent'),
        'OpenAIAgent should be removed'
      ).toBeFalsy();
    });
  });

  describe('remove all clears agents but preserves project structure', () => {
    it('remove all clears all agents and resources', async () => {
      const result = await runCLI(['remove', 'all', '--force', '--json'], project.projectPath);

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const config = await readProjectConfig(project.projectPath);
      expect(config.agents, 'agents should be cleared').toHaveLength(0);
      expect(config.agentCoreGateways, 'gateways should be cleared').toHaveLength(0);
      expect(config.memories, 'memories should be cleared').toHaveLength(0);
      expect(config.credentials, 'credentials should be cleared').toHaveLength(0);
    });

    it('project is still valid and reusable after remove all', async () => {
      const config = await readProjectConfig(project.projectPath);
      expect(config.name, 'Project name should still exist').toBeTruthy();

      // Can add a new agent to the empty project
      const result = await runCLI(
        [
          'add',
          'agent',
          '--name',
          'FreshAgent',
          '--language',
          'Python',
          '--framework',
          'Strands',
          '--model-provider',
          'Bedrock',
          '--memory',
          'none',
          '--json',
        ],
        project.projectPath
      );

      expect(result.exitCode, `stdout: ${result.stdout}, stderr: ${result.stderr}`).toBe(0);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(true);

      const configAfter = await readProjectConfig(project.projectPath);
      expect(configAfter.agents).toHaveLength(1);
      expect(configAfter.agents[0]!.name).toBe('FreshAgent');
    });
  });

  describe('error cases', () => {
    it('fails to remove a non-existent agent', async () => {
      const result = await runCLI(['remove', 'agent', '--name', 'NonExistentAgent', '--json'], project.projectPath);

      expect(result.exitCode).toBe(1);
      const json = JSON.parse(result.stdout);
      expect(json.success).toBe(false);
      expect(json.error).toContain('not found');
    });
  });
});
