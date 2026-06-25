import { CreateScreen } from '../CreateScreen.js';
import { render } from 'ink-testing-library';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENTER = '\r';
const ESCAPE = '\x1B';

const tick = () => new Promise(resolve => setTimeout(resolve, 20));

afterEach(() => vi.restoreAllMocks());

describe('CreateScreen Esc on create-type prompt', () => {
  it('returns to the project-name input without exiting the CLI', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'create-screen-'));
    const onExit = vi.fn();
    const { stdin, lastFrame } = render(<CreateScreen cwd={cwd} isInteractive onExit={onExit} />);

    // Wait for the existing-project check to resolve into the input phase.
    await tick();
    expect(lastFrame()).toContain('Create a new AgentCore project');

    // Submit a valid project name -> advances to the create-type prompt.
    stdin.write('MyProject');
    await tick();
    stdin.write(ENTER);
    await tick();
    expect(lastFrame()).toContain('What would you like to build?');

    // Esc must go back to the name input, not quit the CLI.
    stdin.write(ESCAPE);
    await tick();
    expect(lastFrame()).toContain('Create a new AgentCore project');
    expect(onExit).not.toHaveBeenCalled();
  });
});
