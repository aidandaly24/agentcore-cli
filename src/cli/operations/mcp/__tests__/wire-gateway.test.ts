import { detectAgentFramework, getWiringInstructions } from '../wire-gateway.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('detectAgentFramework', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wire-gw-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('detects Strands from pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "strands-agents >= 1.13.0",\n]\n`);
    expect(detectAgentFramework(tempDir)).toBe('Strands');
  });

  it('detects LangChain_LangGraph from pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "langchain >= 0.3.0",\n]\n`);
    expect(detectAgentFramework(tempDir)).toBe('LangChain_LangGraph');
  });

  it('detects GoogleADK from pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "google-adk >= 0.5.0",\n]\n`);
    expect(detectAgentFramework(tempDir)).toBe('GoogleADK');
  });

  it('detects OpenAIAgents from pyproject.toml', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "openai-agents >= 0.1.0",\n]\n`);
    expect(detectAgentFramework(tempDir)).toBe('OpenAIAgents');
  });

  it('returns undefined for BYO agent with no known framework', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "boto3 >= 1.35.0",\n]\n`);
    expect(detectAgentFramework(tempDir)).toBeUndefined();
  });

  it('returns undefined when pyproject.toml is missing', () => {
    expect(detectAgentFramework(tempDir)).toBeUndefined();
  });
});

describe('getWiringInstructions', () => {
  it('returns Strands-specific instructions', () => {
    const instructions = getWiringInstructions('Strands');
    expect(instructions).toContain('get_gateway_tools');
    expect(instructions).toContain('capabilities.gateway');
  });

  it('returns LangChain-specific instructions', () => {
    const instructions = getWiringInstructions('LangChain_LangGraph');
    expect(instructions).toContain('get_gateway_mcp_client');
  });

  it('returns GoogleADK-specific instructions', () => {
    const instructions = getWiringInstructions('GoogleADK');
    expect(instructions).toContain('get_gateway_toolsets');
  });

  it('returns OpenAIAgents-specific instructions', () => {
    const instructions = getWiringInstructions('OpenAIAgents');
    expect(instructions).toContain('get_gateway_mcp_servers');
  });

  it('returns generic instructions for unknown frameworks', () => {
    const instructions = getWiringInstructions('unknown');
    expect(instructions).toContain('initialize');
    expect(instructions).toContain('get_gateway_tools');
  });
});

// --- Integration tests for wireGatewayToAgent ---

const { mockFindProjectRoot } = vi.hoisted(() => ({
  mockFindProjectRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../../../lib/index.js')>();
  return {
    ...original,
    findProjectRoot: mockFindProjectRoot,
  };
});

// Import wireGatewayToAgent AFTER mock setup
const { wireGatewayToAgent } = await import('../wire-gateway.js');

describe('wireGatewayToAgent', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wire-integ-'));
    mockFindProjectRoot.mockReturnValue(tempDir);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns error when no agentcore project found', async () => {
    mockFindProjectRoot.mockReturnValue(undefined);
    const result = await wireGatewayToAgent('my-agent', false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('No agentcore project found');
  });

  it('returns error when agent directory does not exist', async () => {
    const result = await wireGatewayToAgent('nonexistent-agent', false);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent directory not found');
  });

  it('skips if capabilities/gateway.py already exists', async () => {
    const agentDir = join(tempDir, 'app', 'my-agent', 'capabilities');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'gateway.py'), '# existing');

    const result = await wireGatewayToAgent('my-agent', false);
    expect(result.success).toBe(true);
    expect(result.error).toContain('already exists');
  });

  it('generates capabilities/gateway.py for Strands agent', async () => {
    const agentDir = join(tempDir, 'app', 'my-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'pyproject.toml'),
      `[project]\ndependencies = [\n    "strands-agents >= 1.13.0",\n]\n`
    );

    const result = await wireGatewayToAgent('my-agent', false);

    expect(result.success).toBe(true);
    expect(result.framework).toBe('Strands');
    expect(result.filesCreated).toContain('app/my-agent/capabilities/gateway.py');

    // Verify file was actually created
    const gatewayPath = join(agentDir, 'capabilities', 'gateway.py');
    expect(existsSync(gatewayPath)).toBe(true);

    // Verify it's the Strands template (has MCPClient import)
    const content = readFileSync(gatewayPath, 'utf-8');
    expect(content).toContain('MCPClient');
    expect(content).toContain('strands');
  });

  it('generates capabilities/gateway.py for LangChain agent', async () => {
    const agentDir = join(tempDir, 'app', 'lc-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "langchain >= 0.3.0",\n]\n`);

    const result = await wireGatewayToAgent('lc-agent', false);

    expect(result.success).toBe(true);
    expect(result.framework).toBe('LangChain_LangGraph');
    const content = readFileSync(join(agentDir, 'capabilities', 'gateway.py'), 'utf-8');
    expect(content).toContain('MultiServerMCPClient');
  });

  it('generates generic template for BYO agent', async () => {
    const agentDir = join(tempDir, 'app', 'byo-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "boto3 >= 1.35.0",\n]\n`);

    const result = await wireGatewayToAgent('byo-agent', false);

    expect(result.success).toBe(true);
    expect(result.framework).toBe('generic');
    const content = readFileSync(join(agentDir, 'capabilities', 'gateway.py'), 'utf-8');
    expect(content).toContain('ClientSession');
  });

  it('adds MCP dependencies to pyproject.toml', async () => {
    const agentDir = join(tempDir, 'app', 'deps-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "langchain >= 0.3.0",\n]\n`);

    await wireGatewayToAgent('deps-agent', false);

    const toml = readFileSync(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(toml).toContain('mcp >= 1.19.0');
  });

  it('adds mcp-proxy-for-aws when hasIamGateway is true', async () => {
    const agentDir = join(tempDir, 'app', 'iam-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'pyproject.toml'), `[project]\ndependencies = [\n    "langchain >= 0.3.0",\n]\n`);

    await wireGatewayToAgent('iam-agent', true);

    const toml = readFileSync(join(agentDir, 'pyproject.toml'), 'utf-8');
    expect(toml).toContain('mcp-proxy-for-aws >= 1.1.0');
  });

  it('does not add raw mcp dep for Strands (handles it internally)', async () => {
    const agentDir = join(tempDir, 'app', 'strands-nodep');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'pyproject.toml'),
      `[project]\ndependencies = [\n    "strands-agents >= 1.13.0",\n]\n`
    );

    await wireGatewayToAgent('strands-nodep', false);

    const toml = readFileSync(join(agentDir, 'pyproject.toml'), 'utf-8');
    // Strands doesn't need the raw mcp dep (MCPClient handles it)
    // No deps to add, so file should be unchanged
    expect(toml).not.toContain('"mcp >= 1.19.0"');
  });
});
