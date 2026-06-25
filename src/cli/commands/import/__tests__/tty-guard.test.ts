import { registerImport } from '../command';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireTTY = vi.fn();
const mockRequireProject = vi.fn();
const mockRender = vi.fn();

vi.mock('../../../tui/guards/tty', () => ({
  requireTTY: () => mockRequireTTY(),
}));

vi.mock('../../../tui/guards/project', () => ({
  requireProject: () => mockRequireProject(),
}));

vi.mock('ink', () => ({
  render: (...args: unknown[]) => {
    mockRender(...args);
    return { clear: vi.fn(), unmount: vi.fn() };
  },
}));

vi.mock('../../../tui/screens/import', () => ({ ImportFlow: () => null }));

describe('import non-source TTY guard', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerImport(program);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls requireTTY and does not render when the guard exits in a non-TTY context', async () => {
    mockRequireTTY.mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(program.parseAsync(['import'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockRequireTTY).toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('renders the interactive flow when a TTY is present', async () => {
    await program.parseAsync(['import'], { from: 'user' });

    expect(mockRequireTTY).toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalled();
  });
});
