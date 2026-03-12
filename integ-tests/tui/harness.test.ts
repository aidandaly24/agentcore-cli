/**
 * Integration tests for the TUI test harness itself.
 *
 * These tests exercise the TuiSession class against simple Unix commands
 * (echo, cat, bash) to verify core harness functionality: launching
 * processes, reading screen output, sending keystrokes, waiting for
 * patterns, and session lifecycle management.
 *
 * All tests are wrapped in describe.skipIf(!isAvailable) so they are
 * gracefully skipped when node-pty is not available.
 */
import { LaunchError, TuiSession, WaitForTimeoutError, isAvailable } from '../../src/tui-harness/index.js';
import { afterEach, describe, expect, it } from 'vitest';

describe.skipIf(!isAvailable)('TuiSession harness self-tests', () => {
  let session: TuiSession | undefined;

  afterEach(async () => {
    if (session?.alive) {
      await session.close();
    }
    session = undefined;
  });

  // -------------------------------------------------------------------------
  // (a) Launch echo -- reads output
  // -------------------------------------------------------------------------
  it('launches /bin/echo and reads output from screen', async () => {
    session = await TuiSession.launch({
      command: '/bin/echo',
      args: ['hello world'],
    });

    // echo exits immediately; session may already be dead -- that is fine
    const screen = session.readScreen();
    const text = screen.lines.join('\n');
    expect(text).toContain('hello world');
  });

  // -------------------------------------------------------------------------
  // (b) Launch cat + send keys
  // -------------------------------------------------------------------------
  it('launches /bin/cat and echoes back typed input', async () => {
    session = await TuiSession.launch({
      command: '/bin/cat',
      args: [],
    });

    expect(session.alive).toBe(true);

    const screenAfterKeys = await session.sendKeys('hello');
    const text = screenAfterKeys.lines.join('\n');
    expect(text).toContain('hello');

    // Close with ctrl+d (EOF) to terminate cat
    await session.sendSpecialKey('ctrl+d');
  });

  // -------------------------------------------------------------------------
  // (c) Launch and close
  // -------------------------------------------------------------------------
  it('launches /bin/cat and closes the session cleanly', async () => {
    session = await TuiSession.launch({
      command: '/bin/cat',
      args: [],
    });

    expect(session.alive).toBe(true);

    const result = await session.close();

    expect(session.alive).toBe(false);
    // exitCode is a number (for normal exit) or null (if terminated by signal)
    expect(typeof result.exitCode === 'number' || result.exitCode === null).toBe(true);
    // finalScreen should be a ScreenState with required properties
    expect(result.finalScreen).toHaveProperty('lines');
    expect(result.finalScreen).toHaveProperty('cursor');
    expect(result.finalScreen).toHaveProperty('dimensions');
    expect(result.finalScreen).toHaveProperty('bufferType');
    expect(Array.isArray(result.finalScreen.lines)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // (d) Send keys to dead session
  // -------------------------------------------------------------------------
  it('throws when sending keys to a dead session', async () => {
    session = await TuiSession.launch({
      command: '/bin/cat',
      args: [],
    });

    // Close the session first so it becomes dead
    await session.close();

    expect(session.alive).toBe(false);

    await expect(session.sendKeys('hi')).rejects.toThrow(/not alive/);
  });

  // -------------------------------------------------------------------------
  // (e) waitFor succeeds
  // -------------------------------------------------------------------------
  it('waitFor resolves when the expected pattern appears on screen', async () => {
    session = await TuiSession.launch({
      command: '/bin/bash',
      args: ['-c', 'sleep 0.5 && echo READY'],
    });

    const screen = await session.waitFor('READY', 5000);
    const text = screen.lines.join('\n');
    expect(text).toContain('READY');
  });

  // -------------------------------------------------------------------------
  // (f) waitFor throws on timeout
  // -------------------------------------------------------------------------
  it('waitFor throws WaitForTimeoutError when pattern never appears', async () => {
    session = await TuiSession.launch({
      command: '/bin/cat',
      args: [],
    });

    await expect(session.waitFor('NONEXISTENT', 1000)).rejects.toThrow(WaitForTimeoutError);

    // Verify the error has the expected diagnostic properties
    try {
      await session.waitFor('ANOTHER_MISSING', 500);
    } catch (err) {
      expect(err).toBeInstanceOf(WaitForTimeoutError);
      const timeoutErr = err as WaitForTimeoutError;
      expect(timeoutErr.pattern).toBe('ANOTHER_MISSING');
      expect(typeof timeoutErr.elapsed).toBe('number');
      expect(timeoutErr.screen).toHaveProperty('lines');
    }
  });

  // -------------------------------------------------------------------------
  // (g) Launch with bad command
  // -------------------------------------------------------------------------
  it('throws LaunchError for a nonexistent binary', async () => {
    await expect(TuiSession.launch({ command: '/nonexistent/binary' })).rejects.toThrow(LaunchError);

    // Verify the error has the expected diagnostic properties
    try {
      await TuiSession.launch({ command: '/nonexistent/binary' });
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchError);
      const launchErr = err as LaunchError;
      expect(launchErr.command).toBe('/nonexistent/binary');
      expect(typeof launchErr.exitCode).toBe('number');
    }
  });

  // -------------------------------------------------------------------------
  // (h) Multiple concurrent sessions
  // -------------------------------------------------------------------------
  it('runs multiple concurrent sessions without cross-contamination', async () => {
    let session2: TuiSession | undefined;

    try {
      session = await TuiSession.launch({
        command: '/bin/cat',
        args: [],
      });

      session2 = await TuiSession.launch({
        command: '/bin/cat',
        args: [],
      });

      // Send different text to each session
      await session.sendKeys('alpha');
      await session2.sendKeys('bravo');

      // Read each session's screen
      const screen1 = session.readScreen();
      const screen2 = session2.readScreen();

      const text1 = screen1.lines.join('\n');
      const text2 = screen2.lines.join('\n');

      // Each session should see only its own text
      expect(text1).toContain('alpha');
      expect(text1).not.toContain('bravo');

      expect(text2).toContain('bravo');
      expect(text2).not.toContain('alpha');
    } finally {
      if (session2?.alive) {
        await session2.close();
      }
    }
  });

  // -------------------------------------------------------------------------
  // (i) readScreen with options
  // -------------------------------------------------------------------------
  it('readScreen supports numbered line output', async () => {
    session = await TuiSession.launch({
      command: '/bin/echo',
      args: ['numbered test'],
    });

    // Read with numbered lines
    const numberedScreen = session.readScreen({ numbered: true });
    // Numbered lines should have the " N | " prefix format
    const firstNumberedLine = numberedScreen.lines[0] ?? '';
    expect(firstNumberedLine).toMatch(/^\s*1 \| /);

    // Read without numbered lines
    const plainScreen = session.readScreen();
    const firstPlainLine = plainScreen.lines[0] ?? '';
    // Plain lines should NOT have the numbered prefix
    expect(firstPlainLine).not.toMatch(/^\s*1 \| /);
  });
});
