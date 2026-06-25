import { registerExport } from '../index';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireTTY = vi.fn();
const mockRenderTUI = vi.fn();

vi.mock('../../../tui/guards', () => ({
  requireTTY: () => mockRequireTTY(),
}));

vi.mock('../../../tui/render', () => ({
  renderTUI: (...args: unknown[]) => mockRenderTUI(...args),
}));

describe('export harness TTY guard', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerExport(program);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls requireTTY and never renders the TUI in a non-TTY context', async () => {
    mockRequireTTY.mockImplementation(() => {
      throw new Error('process.exit');
    });

    await expect(program.parseAsync(['export', 'harness'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockRequireTTY).toHaveBeenCalled();
    expect(mockRenderTUI).not.toHaveBeenCalled();
  });

  it('renders the TUI when a TTY is present', async () => {
    await program.parseAsync(['export', 'harness'], { from: 'user' });

    expect(mockRequireTTY).toHaveBeenCalled();
    expect(mockRenderTUI).toHaveBeenCalled();
  });
});
