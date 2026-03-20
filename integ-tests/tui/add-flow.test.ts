/**
 * Integration tests for TUI add-resource flow.
 *
 * Verifies navigation into the Add Resource screen, drilling into the
 * Add Agent wizard, and backing out via Escape at each level.
 *
 * These tests launch the real CLI entry point against a minimal project
 * directory (no npm install required) and interact with the Ink-based TUI
 * through the headless PTY harness.
 */
import { TuiSession, isAvailable } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_ENTRY = join(process.cwd(), 'dist/cli/index.mjs');

describe.skipIf(!isAvailable)('TUI add-resource flow', () => {
  let session: TuiSession | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (session?.alive) await session.close();
    session = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  // ---------------------------------------------------------------------------
  // (a) Navigate to Add Resource screen
  // ---------------------------------------------------------------------------
  it('navigates from HelpScreen to Add Resource screen', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    // Wait for the HelpScreen to render with its command list.
    await session.waitFor('Commands', 10000);

    // Type 'add' to filter the command list, then press Enter to select it.
    await session.sendKeys('add');
    await session.waitFor('add', 1500);
    await session.sendSpecialKey('enter');

    // Confirm the Add Resource screen has rendered.
    const screen = await session.waitFor('Add Resource', 10000);
    const text = screen.lines.join('\n');

    expect(text).toContain('Agent');
    expect(text).toContain('Memory');
    expect(text).toContain('Identity');
  });

  // ---------------------------------------------------------------------------
  // (b) Navigate to Add Agent wizard
  // ---------------------------------------------------------------------------
  it('navigates from Add Resource to Add Agent wizard', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10000);

    // Navigate to Add Resource screen.
    await session.sendKeys('add');
    await session.waitFor('add', 1500);
    await session.sendSpecialKey('enter');
    await session.waitFor('Add Resource', 10000);

    // Agent is the first item in the list -- press Enter to select it.
    await session.sendSpecialKey('enter');

    // Wait for the Add Agent wizard to appear. It may show "Add Agent"
    // as a title or prompt for "Agent name".
    const screen = await session.waitFor(/Add Agent|Agent name/, 10000);
    const text = screen.lines.join('\n');

    // The screen should contain some form of agent name input prompt.
    expect(text).toMatch(/Add Agent|Agent name/);
  });

  // ---------------------------------------------------------------------------
  // (c) Back from Add Agent to Add Resource
  // ---------------------------------------------------------------------------
  it('returns from Add Agent to Add Resource via Escape', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10000);

    // Navigate: HelpScreen -> Add Resource -> Add Agent
    await session.sendKeys('add');
    await session.waitFor('add', 1500);
    await session.sendSpecialKey('enter');
    await session.waitFor('Add Resource', 10000);
    await session.sendSpecialKey('enter');
    await session.waitFor(/Add Agent|Agent name/, 10000);

    // Press Escape to go back to Add Resource.
    await session.sendSpecialKey('escape');

    const screen = await session.waitFor('Add Resource', 5000);
    const text = screen.lines.join('\n');
    expect(text).toContain('Add Resource');
  });

  // ---------------------------------------------------------------------------
  // (d) Back from Add Resource to HelpScreen
  // ---------------------------------------------------------------------------
  it('returns from Add Resource to HelpScreen via Escape', async () => {
    const project = await createMinimalProjectDir();
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10000);

    // Navigate to Add Resource screen.
    await session.sendKeys('add');
    await session.waitFor('add', 1500);
    await session.sendSpecialKey('enter');
    await session.waitFor('Add Resource', 10000);

    // Press Escape to go back to HelpScreen.
    await session.sendSpecialKey('escape');

    const screen = await session.waitFor('Commands', 5000);
    const text = screen.lines.join('\n');
    expect(text).toContain('Commands');
  });
});
