/**
 * Regression test for issue #1267.
 *
 * In the TUI deploy flow a multi-target project synthesizes one stack per configured target.
 * The deploy was calling `cdkToolkitWrapper.deploy()` with no stacks selector, which the wrapper
 * forwards as `{ stacks: undefined }` — toolkit-lib defaults that to ALL_STACKS and provisions
 * infrastructure to EVERY configured account/region, ignoring the picker selection.
 *
 * These tests render `useDeployFlow` with a mocked preflight + CDK wrapper and assert the deploy
 * is scoped to ONLY the selected target's stack name via PATTERN_MUST_MATCH.
 */
import { toStackName } from '../../../../commands/import/import-utils';
import { useDeployFlow } from '../useDeployFlow';
import { StackSelectionStrategy } from '@aws-cdk/toolkit-lib';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---- Module mocks -----------------------------------------------------------

const deploySpy = vi.fn().mockResolvedValue(undefined);
const diffSpy = vi.fn().mockResolvedValue(undefined);
const disposeSpy = vi.fn().mockResolvedValue(undefined);

const fakeWrapper = {
  deploy: deploySpy,
  diff: diffSpy,
  dispose: disposeSpy,
};

// switchableIoHost: noop setters so the deploy effect can wire callbacks without crashing.
const fakeIoHost = {
  setOnRawMessage: vi.fn(),
  setOnMessage: vi.fn(),
  setVerbose: vi.fn(),
};

// preflightState is mutated per-test before render so the same mock can vary phase/context.
let preflightState: any;

vi.mock('../../../hooks', async () => {
  const actual = await vi.importActual<any>('../../../hooks');
  return {
    ...actual,
    useCdkPreflight: () => preflightState,
  };
});

// Telemetry wrapper: just run the deploy closure so deploy() actually fires.
vi.mock('../../../../telemetry/cli-command-run.js', () => ({
  withCommandRunTelemetry: async (_cmd: string, _attrs: unknown, fn: () => Promise<unknown>) => fn(),
}));

// persistDeployedState polls getStackOutputs; make it throw fast so the (caught) post-deploy path
// resolves immediately instead of polling for 15s. The deploy() call has already happened by then.
vi.mock('../../../../cloudformation', async () => {
  const actual = await vi.importActual<any>('../../../../cloudformation');
  return {
    ...actual,
    getStackOutputs: vi.fn().mockRejectedValue(new Error('test: skip persist')),
  };
});

// Managed-memory notice does a config read; short-circuit it.
vi.mock('../../../../operations/deploy', async () => {
  const actual = await vi.importActual<any>('../../../../operations/deploy');
  return {
    ...actual,
    hasManagedMemoryHarness: vi.fn().mockResolvedValue(false),
    setupTransactionSearch: vi.fn().mockResolvedValue({ success: true }),
  };
});

// ---- Fixtures ---------------------------------------------------------------

const TARGET_A = { name: 'prod-east', account: '111111111111', region: 'us-east-1' as const };
const TARGET_B = { name: 'prod-west', account: '222222222222', region: 'us-west-2' as const };
const PROJECT_NAME = 'myproj';

function makePreflight(opts: { awsTargets: any[]; projectName?: string }) {
  const stackNames = opts.awsTargets.map(t => toStackName(opts.projectName ?? PROJECT_NAME, t.name));
  return {
    phase: 'complete',
    steps: [],
    context: {
      projectSpec: { name: opts.projectName ?? PROJECT_NAME, runtimes: [] },
      awsTargets: opts.awsTargets,
      isTeardownDeploy: false,
      isFirstDeploy: true, // skip the pre-deploy diff branch
    },
    cdkToolkitWrapper: fakeWrapper,
    stackNames,
    switchableIoHost: fakeIoHost,
    hasTokenExpiredError: false,
    hasCredentialsError: false,
    missingCredentials: [],
    allCredentials: {},
    identityKmsKeyArn: undefined,
    startPreflight: vi.fn().mockResolvedValue(undefined),
    confirmTeardown: vi.fn(),
    cancelTeardown: vi.fn(),
    confirmBootstrap: vi.fn(),
    skipBootstrap: vi.fn(),
    clearTokenExpiredError: vi.fn(),
    clearCredentialsError: vi.fn(),
    useEnvLocalCredentials: vi.fn(),
    useManualCredentials: vi.fn(),
    skipCredentials: vi.fn(),
  };
}

// Harness component: mounts the hook so its effects fire under ink-testing-library.
function Harness({ selectedTargets }: { selectedTargets?: any[] }) {
  useDeployFlow({ isInteractive: true, selectedTargets });
  return null as unknown as React.ReactElement;
}

async function flush() {
  // Let queued microtasks + effect timers settle.
  for (let i = 0; i < 10; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// ---- Tests ------------------------------------------------------------------

describe('useDeployFlow target scoping (issue #1267)', () => {
  beforeEach(() => {
    deploySpy.mockClear();
    diffSpy.mockClear();
    disposeSpy.mockClear();
    fakeIoHost.setOnRawMessage.mockClear();
    fakeIoHost.setOnMessage.mockClear();
    fakeIoHost.setVerbose.mockClear();
  });
  afterEach(() => {
    vi.clearAllTimers();
  });

  it('scopes deploy to ONLY the single selected target stack (not ALL_STACKS)', async () => {
    preflightState = makePreflight({ awsTargets: [TARGET_A, TARGET_B] });

    const { unmount } = render(<Harness selectedTargets={[TARGET_B]} />);
    await flush();
    unmount();

    expect(deploySpy).toHaveBeenCalledTimes(1);
    const arg = deploySpy.mock.calls[0]![0];

    // Must NOT be called with stacks undefined (the pre-fix behavior → ALL_STACKS).
    expect(arg).toBeDefined();
    expect(arg.stacks).toBeDefined();
    expect(arg.stacks.strategy).toBe(StackSelectionStrategy.PATTERN_MUST_MATCH);
    expect(arg.stacks.patterns).toEqual([toStackName(PROJECT_NAME, TARGET_B.name)]);

    // Regression: selecting B must never produce a pattern for A.
    expect(arg.stacks.patterns).not.toContain(toStackName(PROJECT_NAME, TARGET_A.name));
  });

  it('selecting target A produces only A’s stack (no cross-leak to B)', async () => {
    preflightState = makePreflight({ awsTargets: [TARGET_A, TARGET_B] });

    const { unmount } = render(<Harness selectedTargets={[TARGET_A]} />);
    await flush();
    unmount();

    expect(deploySpy).toHaveBeenCalledTimes(1);
    const arg = deploySpy.mock.calls[0]![0];
    expect(arg.stacks.patterns).toEqual([toStackName(PROJECT_NAME, TARGET_A.name)]);
    expect(arg.stacks.patterns).not.toContain(toStackName(PROJECT_NAME, TARGET_B.name));
  });

  it('selecting ALL targets yields a selector covering every target stack', async () => {
    preflightState = makePreflight({ awsTargets: [TARGET_A, TARGET_B] });

    const { unmount } = render(<Harness selectedTargets={[TARGET_A, TARGET_B]} />);
    await flush();
    unmount();

    expect(deploySpy).toHaveBeenCalledTimes(1);
    const arg = deploySpy.mock.calls[0]![0];
    expect(arg.stacks.strategy).toBe(StackSelectionStrategy.PATTERN_MUST_MATCH);
    expect(arg.stacks.patterns).toEqual([
      toStackName(PROJECT_NAME, TARGET_A.name),
      toStackName(PROJECT_NAME, TARGET_B.name),
    ]);
  });

  it('single-target project still deploys (unscoped → the lone synthesized stack)', async () => {
    preflightState = makePreflight({ awsTargets: [TARGET_A] });

    // Single-target picker selects the one target.
    const { unmount } = render(<Harness selectedTargets={[TARGET_A]} />);
    await flush();
    unmount();

    expect(deploySpy).toHaveBeenCalledTimes(1);
    const arg = deploySpy.mock.calls[0]![0];
    // Either a pattern selector for the single stack, or undefined (assembly's lone stack) — both
    // deploy exactly one stack. Must never resolve to a broader set.
    if (arg.stacks) {
      expect(arg.stacks.patterns).toEqual([toStackName(PROJECT_NAME, TARGET_A.name)]);
    }
  });

  it('no picker selection falls back to the unscoped assembly (undefined selector)', async () => {
    preflightState = makePreflight({ awsTargets: [TARGET_A, TARGET_B] });

    const { unmount } = render(<Harness selectedTargets={[]} />);
    await flush();
    unmount();

    expect(deploySpy).toHaveBeenCalledTimes(1);
    const arg = deploySpy.mock.calls[0]![0];
    expect(arg.stacks).toBeUndefined();
  });
});
