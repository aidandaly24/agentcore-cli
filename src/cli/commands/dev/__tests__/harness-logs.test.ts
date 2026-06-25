// Regression test for #1406: `dev --logs` on a harness-only project must exit 1
// (ValidationError), not print guidance and exit 0.
import { registerDev } from '../command.js';
import * as devOps from '../../../operations/dev';
import { Command } from '@commander-js/extra-typings';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../tui/guards', () => ({
  requireProject: vi.fn(),
  requireTTY: vi.fn(),
}));

vi.mock('../../../telemetry/cli-command-run.js', () => ({
  withCommandRunTelemetry: vi.fn((_key: string, _attrs: unknown, fn: (recorder: { set: () => void }) => unknown) =>
    fn({ set: vi.fn() })
  ),
}));

vi.mock('../../../operations/dev', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../operations/dev')>()),
  loadProjectConfig: vi.fn(),
  getDevSupportedAgents: vi.fn(),
}));

describe('dev --logs on a harness-only project (#1406)', () => {
  let exitCodes: (number | undefined)[];
  let errors: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    exitCodes = [];
    errors = [];
    // Harness-only project: no runtimes, one harness, zero dev-supported agents.
    vi.mocked(devOps.loadProjectConfig).mockResolvedValue({
      runtimes: [],
      harnesses: [{ name: 'my-harness' }],
    } as never);
    vi.mocked(devOps.getDevSupportedAgents).mockReturnValue([]);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.join(' '));
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      exitCodes.push(typeof code === 'number' ? code : undefined);
      return undefined as never;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 1 (ValidationError) instead of returning success and exiting 0', async () => {
    const program = new Command();
    program.exitOverride();
    registerDev(program);

    await program.parseAsync(['dev', '--logs', '--skip-deploy', '--no-traces'], { from: 'user' }).catch(() => undefined);

    expect(exitCodes).toContain(1);
    expect(exitCodes).not.toContain(0);
  });

  it('errors directing the user to `agentcore invoke --harness <name>`', async () => {
    const program = new Command();
    program.exitOverride();
    registerDev(program);

    await program.parseAsync(['dev', '--logs', '--skip-deploy', '--no-traces'], { from: 'user' }).catch(() => undefined);

    expect(errors.join('\n')).toContain('agentcore invoke --harness my-harness');
  });
});
