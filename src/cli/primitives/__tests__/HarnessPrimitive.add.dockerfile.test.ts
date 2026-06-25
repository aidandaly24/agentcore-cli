import { HarnessPrimitive } from '../HarnessPrimitive';
import { access, copyFile } from 'fs/promises';
import { join, resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Relative Dockerfile resolution during `create`: configBaseDir points at the freshly-created
// project subdir (cwd/<projectName>/agentcore), so a relative --container path must resolve against
// the INVOCATION cwd (passed as dockerfileBaseDir), not dirname(configBaseDir). Without
// dockerfileBaseDir, resolution falls back to projectRoot so standalone `add harness` is unchanged.

const mockReadProjectSpec = vi.fn();

vi.mock('../../../lib', () => ({
  APP_DIR: 'app',
  ConfigIO: class {
    readProjectSpec = mockReadProjectSpec;
    writeProjectSpec = vi.fn();
    writeHarnessSpec = vi.fn();
    getPathResolver = () => ({ getHarnessDir: (name: string) => `/invocation/cwd/proj/agentcore/app/${name}` });
  },
  findConfigRoot: () => '/invocation/cwd/proj/agentcore',
}));

vi.mock('fs/promises', () => ({
  access: vi.fn(),
  copyFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

const INVOCATION_CWD = '/invocation/cwd';
const CONFIG_BASE_DIR = '/invocation/cwd/proj/agentcore';

function baseProject() {
  return { name: 'proj', harnesses: [], memories: [], runtimes: [] };
}

/** access() succeeds only for the Dockerfile sitting at the invocation cwd, and nowhere else. */
function onlyExistsAtInvocationCwd() {
  vi.mocked(access).mockImplementation(async (p: Parameters<typeof access>[0]) => {
    if (String(p) === resolve(INVOCATION_CWD, './Dockerfile')) return;
    throw new Error('ENOENT');
  });
}

describe('HarnessPrimitive.add — relative Dockerfile base dir', () => {
  afterEach(() => vi.clearAllMocks());

  it('resolves a relative dockerfilePath against dockerfileBaseDir (invocation cwd), not projectRoot', async () => {
    mockReadProjectSpec.mockResolvedValue(baseProject());
    onlyExistsAtInvocationCwd();

    const result = await new HarnessPrimitive().add({
      name: 'support',
      modelProvider: 'bedrock',
      modelId: 'anthropic.claude-3',
      configBaseDir: CONFIG_BASE_DIR,
      dockerfilePath: './Dockerfile',
      dockerfileBaseDir: INVOCATION_CWD,
    } as never);

    expect(result.success).toBe(true);
    const [src, dest] = vi.mocked(copyFile).mock.calls.at(-1)!;
    expect(src).toBe(resolve(INVOCATION_CWD, './Dockerfile'));
    // Destination still lands under the project: agentcore/app/<name>/Dockerfile.
    expect(dest).toBe(join('/invocation/cwd/proj', 'app', 'support', 'Dockerfile'));
  });

  it('falls back to projectRoot when dockerfileBaseDir is omitted (standalone add harness unchanged)', async () => {
    mockReadProjectSpec.mockResolvedValue(baseProject());
    onlyExistsAtInvocationCwd();

    const result = await new HarnessPrimitive().add({
      name: 'support',
      modelProvider: 'bedrock',
      modelId: 'anthropic.claude-3',
      configBaseDir: CONFIG_BASE_DIR,
      dockerfilePath: './Dockerfile',
    } as never);

    expect(result.success).toBe(false);
    expect((result as { error: Error }).error.name).toBe('ResourceNotFoundError');
    expect((result as { error: Error }).error.message).toContain('Dockerfile not found at');
  });
});
