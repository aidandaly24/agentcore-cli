// Regression test for #1376: launching dev from the interactive `agentcore`
// menu must render the harness deploy inside the alt-screen DevScreen TUI (the
// same path `agentcore dev` uses) instead of plain inline console.log lines.
import type { AgentCoreProjectSpec } from '../../../../schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harnessOnlyProject = {
  runtimes: [],
  harnesses: [{ name: 'my-harness' }],
} as unknown as AgentCoreProjectSpec;

const { mockRunCliDeploy, mockRunWebUI, mockIsDeploySkippable, mockLoadProjectConfig, mockRender } = vi.hoisted(() => ({
  mockRunCliDeploy: vi.fn().mockResolvedValue(undefined),
  mockRunWebUI: vi.fn().mockResolvedValue(undefined),
  mockIsDeploySkippable: vi.fn(),
  mockLoadProjectConfig: vi.fn(),
  mockRender: vi.fn(),
}));

vi.mock('../../deploy/progress', () => ({ runCliDeploy: mockRunCliDeploy }));
vi.mock('../../../operations/deploy/change-detection', () => ({ isDeploySkippable: mockIsDeploySkippable }));
vi.mock('../../../tui/screens/dev/DevScreen', () => ({ DevScreen: 'DevScreen' }));
vi.mock('../../../tui/context', () => ({ LayoutProvider: 'LayoutProvider' }));
vi.mock('ink', () => ({ render: (...args: unknown[]) => mockRender(...args) }));

vi.mock('../../../lib', () => ({
  getWorkingDirectory: () => '/proj',
  findConfigRoot: () => '/proj',
  ConfigIO: class {
    configExists() {
      return false;
    }
  },
}));
vi.mock('../../../operations/dev', () => ({
  loadProjectConfig: mockLoadProjectConfig,
  getDevSupportedAgents: () => [],
  getDevConfig: () => undefined,
  loadDevEnv: vi.fn().mockResolvedValue({ envVars: {} }),
}));
vi.mock('../../../operations/dev/otel', () => ({
  startOtelCollector: vi.fn().mockResolvedValue({ collector: undefined, otelEnvVars: {} }),
}));
vi.mock('../../../operations/dev/web-ui', () => ({ runWebUI: mockRunWebUI }));

import { launchBrowserDev } from '../browser-mode';

/** Drive the rendered DevScreen by invoking the prop callback the picker passes. */
function driveDevScreen(invoke: (props: Record<string, unknown>) => void): void {
  mockRender.mockImplementation((element: { props: { children: { props: Record<string, unknown> } } }) => {
    // Defer so the picker's `unmount` binding is initialized before the callback runs.
    const exited = Promise.resolve().then(() => invoke(element.props.children.props));
    return { unmount: vi.fn(), waitUntilExit: () => exited };
  });
}

describe('launchBrowserDev (#1376 entry-path consistency)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadProjectConfig.mockResolvedValue(harnessOnlyProject);
  });

  afterEach(() => {
    mockRender.mockReset();
  });

  it('shows the alt-screen DevScreen TUI for a harness deploy instead of inline runCliDeploy', async () => {
    mockIsDeploySkippable.mockResolvedValue(false);
    driveDevScreen(props => (props.onLaunchBrowser as (s: unknown) => void)({ harnessName: 'my-harness' }));

    await launchBrowserDev();

    expect(mockRunCliDeploy).not.toHaveBeenCalled();
    expect(mockRender).toHaveBeenCalledOnce();
    expect(mockRunWebUI).toHaveBeenCalledOnce();
    const webUiArgs = mockRunWebUI.mock.calls[0]?.[0] as { serverOptions: { selectedHarness?: string } };
    expect(webUiArgs.serverOptions.selectedHarness).toBe('my-harness');
  });

  it('returns early without launching the web UI when the picker is cancelled', async () => {
    mockIsDeploySkippable.mockResolvedValue(false);
    // Picker resolves with no selection (waitUntilExit resolves, onLaunchBrowser never fires).
    driveDevScreen(() => undefined);

    await launchBrowserDev();

    expect(mockRunCliDeploy).not.toHaveBeenCalled();
    expect(mockRunWebUI).not.toHaveBeenCalled();
  });
});
