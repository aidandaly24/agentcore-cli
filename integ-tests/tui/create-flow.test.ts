/**
 * Integration tests for the TUI create-project wizard.
 *
 * These tests launch the agentcore CLI in a headless PTY session and drive
 * through the interactive project creation flow: entering a project name,
 * optionally adding an agent (stepping through the full agent wizard), and
 * verifying that the project is created successfully on disk.
 *
 * All tests are wrapped in describe.skipIf(!isAvailable) so they are
 * gracefully skipped when node-pty is not available.
 */
import { TuiSession, isAvailable } from '../../src/tui-harness/index.js';
import { realpathSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

describe.skipIf(!isAvailable)('create wizard TUI flow', () => {
  const CLI_ENTRY = join(process.cwd(), 'dist/cli/index.mjs');

  let session: TuiSession | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (session?.alive) await session.close();
    session = undefined;
    if (tempDir) {
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // (a) Full create wizard — create project with agent
  // ---------------------------------------------------------------------------
  it('creates a project with an agent through the full wizard', async () => {
    tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'tui-create-')));

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: tempDir,
      cols: 120,
      rows: 40,
    });

    // Step 1: HomeScreen — no project found
    await session.waitFor('No AgentCore project found', 15000);

    // Step 2: Press enter to navigate to CreateScreen
    await session.sendSpecialKey('enter');

    // Step 3: Wait for the project name prompt
    await session.waitFor('Project name', 10000);

    // Step 4: Type the project name and submit
    await session.sendKeys('testproject');
    await session.sendSpecialKey('enter');

    // Step 5: Wait for the "add agent" prompt
    await session.waitFor('Would you like to add an agent now?', 10000);

    // Step 6: Select "Yes, add an agent" (first option — just press enter)
    await session.sendSpecialKey('enter');

    // Step 7: Agent name prompt
    await session.waitFor('Agent name', 10000);

    // Step 8: Accept default agent name
    await session.sendSpecialKey('enter');

    // Step 9: Agent type selection
    await session.waitFor('Select agent type', 10000);

    // Step 10: Select first option (Create new agent)
    await session.sendSpecialKey('enter');

    // Step 11: Language selection
    await session.waitFor(/Python|Select language/, 10000);

    // Step 12: Select Python (first option)
    await session.sendSpecialKey('enter');

    // Step 13: Build type selection
    await session.waitFor(/build|CodeZip|Container|Direct Code Deploy/i, 10000);

    // Step 14: Select first build type
    await session.sendSpecialKey('enter');

    // Step 15: Protocol selection (HTTP, MCP, A2A)
    await session.waitFor(/protocol|HTTP|MCP|A2A/i, 10000);

    // Step 16: Select first protocol
    await session.sendSpecialKey('enter');

    // Step 17: Framework selection
    await session.waitFor(/Strands|Select.*framework/i, 10000);

    // Step 18: Select first framework
    await session.sendSpecialKey('enter');

    // Step 19: Model provider selection
    await session.waitFor(/Bedrock|Select.*model|model.*provider/i, 10000);

    // Step 20: Select first model provider
    await session.sendSpecialKey('enter');

    // Step 21: Network selection or API key or memory or review — the wizard
    // may show different steps depending on model provider choice.
    const nextScreen = await session.waitFor(/network|memory|api.?key|Review Configuration/i, 10000);
    const nextText = nextScreen.lines.join('\n');

    // Walk through any intermediate steps until we reach Review Configuration
    if (/api.?key/i.test(nextText)) {
      await session.sendSpecialKey('enter');
      await session.waitFor(/network|memory|Review Configuration/i, 10000);
    }

    // Keep advancing through remaining steps (network, memory) until Review
    const currentScreen = session.readScreen();
    let currentText = currentScreen.lines.join('\n');

    while (!/Review Configuration/i.test(currentText)) {
      await session.sendSpecialKey('enter');
      const screen = await session.waitFor(/network|memory|Review Configuration/i, 10000);
      currentText = screen.lines.join('\n');
    }

    // Step 22: Review and confirm
    await session.waitFor('Review Configuration', 10000);
    await session.sendSpecialKey('enter');

    // Step 21: Wait for project creation to complete (generous timeout —
    // CDK scaffolding + git init can take >30s under load)
    const successScreen = await session.waitFor('Project created successfully', 60000);

    const successText = successScreen.lines.join('\n');
    expect(successText).toContain('Project created successfully');
  }, 120_000);

  // ---------------------------------------------------------------------------
  // (b) Create wizard — skip agent creation
  // ---------------------------------------------------------------------------
  it('creates a project without adding an agent', async () => {
    tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'tui-create-skip-')));

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: tempDir,
      cols: 120,
      rows: 40,
    });

    // HomeScreen
    await session.waitFor('No AgentCore project found', 15000);

    // Navigate to CreateScreen
    await session.sendSpecialKey('enter');

    // Project name prompt
    await session.waitFor('Project name', 10000);

    // Type project name and submit
    await session.sendKeys('skiptest');
    await session.sendSpecialKey('enter');

    // Wait for the "add agent" prompt
    await session.waitFor('Would you like to add an agent now?', 10000);

    // Move to "No, I'll do it later" and select it
    await session.sendSpecialKey('down');
    await session.sendSpecialKey('enter');

    // Wait for project creation to complete
    const successScreen = await session.waitFor('Project created successfully', 60000);

    const successText = successScreen.lines.join('\n');
    expect(successText).toContain('Project created successfully');
  });

  // ---------------------------------------------------------------------------
  // (c) Back navigation during wizard
  // ---------------------------------------------------------------------------
  it('navigates back from CreateScreen to HelpScreen with escape', async () => {
    tempDir = realpathSync(await mkdtemp(join(tmpdir(), 'tui-create-back-')));

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: tempDir,
      cols: 120,
      rows: 40,
    });

    // HomeScreen
    await session.waitFor('No AgentCore project found', 15000);

    // Navigate to CreateScreen
    await session.sendSpecialKey('enter');

    // Confirm we are on the CreateScreen
    await session.waitFor('Project name', 10000);

    // Press escape to go back
    await session.sendSpecialKey('escape');

    // Verify we are back on HelpScreen
    const homeScreen = await session.waitFor('Commands', 10000);

    const homeText = homeScreen.lines.join('\n');
    expect(homeText).toContain('Commands');
  });
});
