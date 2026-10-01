import { copyAndRenderDir } from '../../cli/templates/render';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ASSETS_DIR = resolve(__dirname, '..');

describe('generated Python dependency constraints', () => {
  let outputDir: string;

  beforeAll(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'python-dependencies-'));
  });

  afterAll(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  it.each([
    ['python/http/strands/base', 'mcp'],
    ['python/http/langchain_langgraph/base', 'mcp'],
    ['python/mcp/standalone/base', 'mcp'],
    ['mcp/python', 'mcp[cli]'],
  ])('%s permits patched MCP 1.x releases', async (assetDir, dependency) => {
    const destination = join(outputDir, assetDir);
    await copyAndRenderDir(join(ASSETS_DIR, assetDir), destination, {
      name: 'dependency_probe',
      modelProvider: 'Bedrock',
    });

    const pyproject = readFileSync(join(destination, 'pyproject.toml'), 'utf-8');
    expect(pyproject).toContain(`"${dependency} >= 1.28.1, < 2.0.0"`);
  });

  it.each([
    ['python/http/strands/base', 'bedrock-agentcore'],
    ['python/http/langchain_langgraph/base', 'bedrock-agentcore'],
    ['python/http/googleadk/base', 'bedrock-agentcore'],
    ['python/http/openaiagents/base', 'bedrock-agentcore'],
    ['python/http/autogen/base', 'bedrock-agentcore'],
    ['python/a2a/strands/base', 'bedrock-agentcore[a2a]'],
    ['python/agui/strands/base', 'bedrock-agentcore'],
    ['python/agui/langchain_langgraph/base', 'bedrock-agentcore'],
    ['python/agui/googleadk/base', 'bedrock-agentcore'],
  ])('%s requires an AgentCore SDK with the package-installation fix', async (assetDir, dependency) => {
    const destination = join(outputDir, assetDir);
    await copyAndRenderDir(join(ASSETS_DIR, assetDir), destination, {
      name: 'dependency_probe',
      modelProvider: 'Bedrock',
    });

    const pyproject = readFileSync(join(destination, 'pyproject.toml'), 'utf-8');
    expect(pyproject).toContain(`"${dependency} >= 1.18.1"`);
  });
});
