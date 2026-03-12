/**
 * Integration tests for TUI deploy screen navigation.
 *
 * Verifies that the deploy command screen renders correctly when launched
 * from a project that has agents, shows AWS configuration prompts, and
 * supports escaping back to the HelpScreen.
 *
 * IMPORTANT: These tests never actually deploy to AWS. They only verify
 * that the deploy screen renders and navigation works. The deploy screen
 * will display AWS credential/config prompts which we observe but do not
 * interact with beyond verifying they appear.
 */
import { TuiSession, isAvailable } from '../../src/tui-harness/index.js';
import { createMinimalProjectDir } from './helpers.js';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

const CLI_ENTRY = join(process.cwd(), 'dist/cli/index.mjs');

describe.skipIf(!isAvailable)('TUI deploy screen', () => {
  let session: TuiSession | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (session?.alive) await session.close();
    session = undefined;
    await cleanup?.();
    cleanup = undefined;
  });

  // ---------------------------------------------------------------------------
  // (a) Navigate to Deploy screen
  // ---------------------------------------------------------------------------
  it('navigates from HelpScreen to Deploy screen', async () => {
    const project = await createMinimalProjectDir({ hasAgents: true });
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    // Wait for the HelpScreen to render with its command list.
    await session.waitFor('Commands', 10000);

    // Type 'deploy' to filter the command list, then press Enter.
    await session.sendKeys('deploy');
    await session.waitFor('deploy', 3000);
    await session.sendSpecialKey('enter');

    // The deploy screen should render. It may show "AgentCore Deploy"
    // as a title or immediately begin checking AWS configuration.
    const screen = await session.waitFor(/AgentCore Deploy|Checking AWS|AWS/, 10000);
    const text = screen.lines.join('\n');

    expect(text).toMatch(/AgentCore Deploy|Checking AWS|AWS|deploy/i);
  });

  // ---------------------------------------------------------------------------
  // (b) Deploy screen shows AWS configuration prompt
  // ---------------------------------------------------------------------------
  it('shows AWS-related content on the deploy screen', async () => {
    const project = await createMinimalProjectDir({ hasAgents: true });
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10000);

    // Navigate to Deploy screen.
    await session.sendKeys('deploy');
    await session.waitFor('deploy', 3000);
    await session.sendSpecialKey('enter');

    // Wait for some AWS-related text to appear. In a test environment
    // without credentials this will typically be one of:
    //   - "Checking AWS configuration..."
    //   - "No AWS credentials detected"
    //   - "AWS credentials have expired"
    //   - "AgentCore Deploy"
    const screen = await session.waitFor('AWS', 10000);
    const text = screen.lines.join('\n');

    // Verify the screen contains AWS-related content -- we just need to
    // confirm the deploy screen rendered its AWS configuration phase.
    expect(text).toContain('AWS');
  });

  // ---------------------------------------------------------------------------
  // (c) Escape from Deploy back to HelpScreen
  // ---------------------------------------------------------------------------
  it('returns from Deploy screen to HelpScreen via Escape', async () => {
    const project = await createMinimalProjectDir({ hasAgents: true });
    cleanup = project.cleanup;

    session = await TuiSession.launch({
      command: 'node',
      args: [CLI_ENTRY],
      cwd: project.dir,
    });

    await session.waitFor('Commands', 10000);

    // Navigate to Deploy screen.
    await session.sendKeys('deploy');
    await session.waitFor('deploy', 3000);
    await session.sendSpecialKey('enter');

    // Wait for the deploy screen to render before pressing Escape.
    await session.waitFor(/AgentCore Deploy|AWS/, 10000);

    // Press Escape to return to HelpScreen.
    await session.sendSpecialKey('escape');

    const screen = await session.waitFor('Commands', 5000);
    const text = screen.lines.join('\n');
    expect(text).toContain('Commands');
  });
});
