import { DevScreen } from '../DevScreen.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockLoadProjectConfig, mockGetDevSupportedAgents } = vi.hoisted(() => ({
  mockLoadProjectConfig: vi.fn(),
  mockGetDevSupportedAgents: vi.fn(),
}));

vi.mock('../../../../operations/dev', () => ({
  loadProjectConfig: mockLoadProjectConfig,
  getDevSupportedAgents: mockGetDevSupportedAgents,
  getEndpointUrl: vi.fn(),
}));

// The dev hooks would otherwise try to spin up a real dev server / deploy.
vi.mock('../../../hooks/useDevServer', () => ({
  useDevServer: () => ({
    logs: [],
    status: 'idle',
    isStreaming: false,
    conversation: [],
    streamingResponse: null,
    config: null,
    configLoaded: true,
    actualPort: 8080,
    invoke: vi.fn(),
    execCommand: vi.fn(),
    execInContainer: vi.fn(),
    isContainer: false,
    clearConversation: vi.fn(),
    restart: vi.fn(),
    stop: vi.fn(),
    logFilePath: undefined,
    hasUndeployedMemory: false,
    hasVpc: false,
    protocol: undefined,
    mcpTools: [],
    fetchMcpTools: vi.fn(),
    showMcpHint: false,
    a2aAgentCard: undefined,
    a2aStatus: undefined,
    fetchAgentCard: vi.fn(),
  }),
}));

vi.mock('../../../hooks/useDevDeploy', () => ({
  useDevDeploy: () => ({ steps: [], deployMessages: [], isComplete: false, error: undefined }),
}));

const noop = () => undefined;

describe('DevScreen', () => {
  afterEach(() => vi.clearAllMocks());

  // Regression: selecting "dev" in a project with no agents/harnesses must render
  // the in-TUI error screen (not crash the TUI out to the shell). See issue #1588.
  it('renders the in-TUI error when no agents or harnesses are defined', async () => {
    mockLoadProjectConfig.mockResolvedValue({ runtimes: [], harnesses: [] });
    mockGetDevSupportedAgents.mockReturnValue([]);

    const onLaunchBrowser = vi.fn();
    const { lastFrame } = render(<DevScreen onBack={noop} onLaunchBrowser={onLaunchBrowser} />);
    await new Promise(r => setTimeout(r, 50));

    expect(lastFrame()).toContain('No agents or harnesses defined in project.');
    expect(onLaunchBrowser).not.toHaveBeenCalled();
  });
});
