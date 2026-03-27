import { addPythonDependencies } from '../toml-deps.js';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SAMPLE_TOML = `[project]
name = "my-agent"
version = "0.1.0"
dependencies = [
    "bedrock-agentcore >= 0.1.0",
    "strands-agents >= 1.13.0",
]
`;

describe('addPythonDependencies', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'toml-deps-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('adds a new dependency to pyproject.toml', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), SAMPLE_TOML, 'utf-8');

    const result = await addPythonDependencies(tempDir, ['mcp >= 1.19.0']);

    expect(result.success).toBe(true);
    const content = await readFile(join(tempDir, 'pyproject.toml'), 'utf-8');
    expect(content).toContain('"mcp >= 1.19.0"');
  });

  it('adds multiple dependencies at once', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), SAMPLE_TOML, 'utf-8');

    const result = await addPythonDependencies(tempDir, ['mcp >= 1.19.0', 'mcp-proxy-for-aws >= 1.1.0']);

    expect(result.success).toBe(true);
    const content = await readFile(join(tempDir, 'pyproject.toml'), 'utf-8');
    expect(content).toContain('"mcp >= 1.19.0"');
    expect(content).toContain('"mcp-proxy-for-aws >= 1.1.0"');
  });

  it('skips duplicate dependencies', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), SAMPLE_TOML, 'utf-8');

    const result = await addPythonDependencies(tempDir, ['strands-agents >= 2.0.0']);

    expect(result.success).toBe(true);
    const content = await readFile(join(tempDir, 'pyproject.toml'), 'utf-8');
    // Original entry preserved, no second strands-agents line added
    expect(content).toContain('"strands-agents >= 1.13.0"');
    const matches = content.match(/strands-agents/g);
    expect(matches).toHaveLength(1);
  });

  it('returns success with no changes when all deps already exist', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), SAMPLE_TOML, 'utf-8');

    const result = await addPythonDependencies(tempDir, ['bedrock-agentcore >= 0.2.0']);

    expect(result.success).toBe(true);
    // File content should not have changed
    const content = await readFile(join(tempDir, 'pyproject.toml'), 'utf-8');
    expect(content).toBe(SAMPLE_TOML);
  });

  it('returns error when pyproject.toml does not exist', async () => {
    const result = await addPythonDependencies(join(tempDir, 'nonexistent'), ['mcp >= 1.19.0']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not read');
  });

  it('returns error when dependencies array is missing', async () => {
    await writeFile(join(tempDir, 'pyproject.toml'), '[project]\nname = "test"\n', 'utf-8');

    const result = await addPythonDependencies(tempDir, ['mcp >= 1.19.0']);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not find dependencies array');
  });
});
