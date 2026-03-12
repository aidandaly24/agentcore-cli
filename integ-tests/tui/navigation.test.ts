/**
 * Integration tests for TUI navigation flows.
 *
 * These tests exercise the real agentcore CLI TUI to verify navigation
 * between screens: HomeScreen (no project), HelpScreen (with project),
 * forward navigation into sub-screens, backward navigation via Escape,
 * and process exit via double-Escape and Ctrl+C.
 *
 * All tests are wrapped in describe.skipIf(!isAvailable) so they are
 * gracefully skipped when node-pty is not available.
 */
import { TuiSession, isAvailable } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

// The CLI entry point. Tests are run from the repo root, so resolve to
// an absolute path to be safe with different cwd values.
const CLI_ENTRY = join(process.cwd(), 'dist/cli/index.mjs');

describe.skipIf(!isAvailable)('TUI navigation flows', () => {
  let session: TuiSession | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (session?.alive) await session.close();
    session = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  // ---------------------------------------------------------------------------
  // (a) HomeScreen renders when no project exists
  // ---------------------------------------------------------------------------
  it('renders HomeScreen when launched in a directory without a project', async () => {
    const bareDir = await mkdtemp(join(tmpdir(), 'tui-nav-bare-'));
    cleanup = () => rm(bareDir, { recursive: true, force: true });

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: bareDir,
    });

    const screen = await session.waitFor('No AgentCore project found', 10_000);
    const text = screen.lines.join('\n');
    expect(text).toContain('Press Enter to create a new project');
  });

  // ---------------------------------------------------------------------------
  // (b) HelpScreen renders when project exists
  // ---------------------------------------------------------------------------
  it('renders HelpScreen when launched in a directory with a project', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    const screen = await session.waitFor('Commands', 10_000);
    const text = screen.lines.join('\n');
    expect(text).toContain('add');
    expect(text).toContain('deploy');
    expect(text).toContain('status');
  });

  // ---------------------------------------------------------------------------
  // (c) HomeScreen -> CreateScreen forward navigation
  // ---------------------------------------------------------------------------
  it('navigates from HomeScreen to CreateScreen on Enter', async () => {
    const bareDir = await mkdtemp(join(tmpdir(), 'tui-nav-create-'));
    cleanup = () => rm(bareDir, { recursive: true, force: true });

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: bareDir,
    });

    await session.waitFor('No AgentCore project found', 10_000);

    await session.sendSpecialKey('enter');

    // The CreateScreen should ask for the project name or show the create title.
    await session.waitFor(/Project name|AgentCore Create/, 10_000);
  });

  // ---------------------------------------------------------------------------
  // (d) CreateScreen -> back with Escape
  // ---------------------------------------------------------------------------
  it('navigates back from CreateScreen to HelpScreen on Escape', async () => {
    const bareDir = await mkdtemp(join(tmpdir(), 'tui-nav-back-'));
    cleanup = () => rm(bareDir, { recursive: true, force: true });

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: bareDir,
    });

    await session.waitFor('No AgentCore project found', 10_000);

    // Navigate forward to CreateScreen
    await session.sendSpecialKey('enter');
    await session.waitFor(/Project name|AgentCore Create/, 10_000);

    // Navigate back with Escape
    await session.sendSpecialKey('escape');
    // Escape from CreateScreen goes to HelpScreen (command list), not HomeScreen.
    // This is the expected TUI behavior — the router navigates back to 'help'.
    await session.waitFor('Commands', 5_000);
  });

  // ---------------------------------------------------------------------------
  // (e) HelpScreen -> command screen forward navigation
  // ---------------------------------------------------------------------------
  it('navigates from HelpScreen into a command screen on Enter', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10_000);

    // Press Enter to select the first highlighted command
    await session.sendSpecialKey('enter');

    // Wait for a different screen to appear. The first command in the list
    // is typically 'add', which shows an "Add Resource" or similar screen.
    // Use a regex to match common sub-screen indicators.
    await session.waitFor(/Add Resource|add|Select/, 10_000);
  });

  // ---------------------------------------------------------------------------
  // (f) Command screen -> back with Escape
  // ---------------------------------------------------------------------------
  it('navigates back from a command screen to HelpScreen on Escape', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10_000);

    // Navigate into a command screen
    await session.sendSpecialKey('enter');
    await session.waitFor(/Add Resource|add|Select/, 10_000);

    // Navigate back with Escape
    await session.sendSpecialKey('escape');
    await session.waitFor('Commands', 5_000);
  });

  // ---------------------------------------------------------------------------
  // (g) Exit via double-Escape from HelpScreen
  // ---------------------------------------------------------------------------
  it('exits the TUI via double-Escape from HelpScreen', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10_000);

    // First Escape: should show a warning prompt
    await session.sendSpecialKey('escape');
    await session.waitFor('Press Esc again to exit', 3_000);

    // Second Escape: should exit the TUI process
    await session.sendSpecialKey('escape');

    // Wait briefly for the process to terminate
    const deadline = Date.now() + 5_000;
    while (session.alive && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(session.alive).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // (h) Exit via Ctrl+C
  // ---------------------------------------------------------------------------
  it('exits the TUI via Ctrl+C', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10_000);

    // Ctrl+C should terminate the process
    await session.sendSpecialKey('ctrl+c');

    // Wait briefly for the process to terminate
    const deadline = Date.now() + 5_000;
    while (session.alive && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(session.alive).toBe(false);
  });
});
