import { createProgram } from '../cli.js';
import { PACKAGE_VERSION } from '../constants.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('CLI version flag', () => {
  let mockExit: ReturnType<typeof vi.spyOn>;
  let mockStdoutWrite: ReturnType<typeof vi.spyOn>;
  let stdoutOutput: string;

  beforeEach(() => {
    stdoutOutput = '';
    mockExit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockStdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdoutOutput += chunk.toString();
      return true;
    });
  });

  afterEach(() => {
    mockExit.mockRestore();
    mockStdoutWrite.mockRestore();
  });

  it('should output version with --version flag', async () => {
    const program = createProgram();
    program.configureOutput({
      writeOut: (str: string) => {
        stdoutOutput += str;
      },
    });

    try {
      await program.parseAsync(['node', 'agentcore', '--version']);
    } catch {
      // Expected: process.exit is called
    }

    expect(stdoutOutput).toContain(PACKAGE_VERSION);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('should output version with -V flag', async () => {
    const program = createProgram();
    program.configureOutput({
      writeOut: (str: string) => {
        stdoutOutput += str;
      },
    });

    try {
      await program.parseAsync(['node', 'agentcore', '-V']);
    } catch {
      // Expected: process.exit is called
    }

    expect(stdoutOutput).toContain(PACKAGE_VERSION);
    expect(mockExit).toHaveBeenCalledWith(0);
  });

  it('should have version option configured correctly', () => {
    const program = createProgram();
    const versionOption = program.options.find(opt => opt.long === '--version');

    expect(versionOption).toBeDefined();
    expect(versionOption?.short).toBe('-V');
    expect(versionOption?.description).toBe('Output the current version');
  });
});
