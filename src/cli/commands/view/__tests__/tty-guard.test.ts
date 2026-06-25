import { registerView } from '../command';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRequireTTY = vi.fn();
const mockRequireProject = vi.fn();
const mockRender = vi.fn();

vi.mock('../../../tui/guards', () => ({
  requireProject: () => mockRequireProject(),
  requireTTY: () => mockRequireTTY(),
}));

vi.mock('ink', () => ({
  render: (...args: unknown[]) => mockRender(...args),
}));

vi.mock('../../../tui/screens/recommendation', () => ({ RecommendationHistoryScreen: () => null }));
vi.mock('../JobDetailScreen', () => ({ JobDetailScreen: () => null }));

describe('view TTY guard', () => {
  let program: Command;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    registerView(program);
    mockRequireTTY.mockImplementation(() => {
      throw new Error('process.exit');
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('guards the interactive list and never renders in a non-TTY context', async () => {
    await expect(program.parseAsync(['view', 'recommendation'], { from: 'user' })).rejects.toThrow('process.exit');

    expect(mockRequireTTY).toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('guards the interactive detail and never renders in a non-TTY context', async () => {
    await expect(program.parseAsync(['view', 'recommendation', 'rec-1'], { from: 'user' })).rejects.toThrow(
      'process.exit'
    );

    expect(mockRequireTTY).toHaveBeenCalled();
    expect(mockRender).not.toHaveBeenCalled();
  });
});
