/**
 * Regression test: every command shown on the TUI home screen must have a handler
 * in onSelectCommand (either an explicit route, or an entry in CLI_ONLY_EXAMPLES).
 *
 * If this test fails, you added a command to the program but forgot to handle it
 * in App.tsx's onSelectCommand function or add it to CLI_ONLY_EXAMPLES in copy.ts.
 */
import { createProgram } from '../../cli';
import { CLI_ONLY_EXAMPLES } from '../copy';
import { getCommandsForUI } from '../utils/commands';
import { describe, expect, it } from 'vitest';

// These command IDs have explicit route handlers in App.tsx onSelectCommand
const ROUTED_COMMANDS = new Set([
  'dev',
  'exec',
  'deploy',
  'invoke',
  'logs',
  'status',
  'create',
  'add',
  'remove',
  'export',
  'run',
  'evals',
  'fetch',
  'view',
  'validate',
  'package',
  'import',
  'update',
  'config-bundle',
  'dataset',
  'batch-evaluations',
  'feedback',
]);

describe('TUI home screen command coverage', () => {
  it('every visible command has either a route handler or CLI_ONLY_EXAMPLES entry', () => {
    const program = createProgram();
    const commands = getCommandsForUI(program, { inProject: true });

    const unhandled: string[] = [];
    for (const cmd of commands) {
      if (cmd.id === 'help') continue; // help is special-cased
      const hasRoute = ROUTED_COMMANDS.has(cmd.id);
      const hasCliOnly = cmd.id in CLI_ONLY_EXAMPLES;
      if (!hasRoute && !hasCliOnly) {
        unhandled.push(cmd.id);
      }
    }

    expect(unhandled).toEqual([]);
  });

  it('the cliOnly flag and CLI_ONLY_EXAMPLES agree for every visible command', () => {
    const program = createProgram();
    const commands = getCommandsForUI(program, { inProject: true });

    // A command can never be in the main interactive list while routing to the
    // cli-only dead-end: cliOnly is true iff selecting it hits CliOnlyScreen.
    for (const cmd of commands) {
      const hasCliOnlyExamples = cmd.id in CLI_ONLY_EXAMPLES;
      expect(cmd.cliOnly, `${cmd.id}: cliOnly flag must match CLI_ONLY_EXAMPLES membership`).toBe(hasCliOnlyExamples);
    }

    // feedback is interactive (real FeedbackScreen), not a cli-only dead-end.
    expect('feedback' in CLI_ONLY_EXAMPLES).toBe(false);
  });
});
