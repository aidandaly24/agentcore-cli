/**
 * Regression test: the `run-insights` CLI examples in copy.ts must only reference
 * flags that the `run insights` command actually registers. Guards against drift
 * like `--lookback 7` (the real flag is `--lookback-days`).
 */
import { createProgram } from '../../cli';
import { CLI_ONLY_EXAMPLES } from '../copy';
import { describe, expect, it } from 'vitest';

function registeredFlags(): Set<string> {
  const program = createProgram();
  const runCmd = program.commands.find(c => c.name() === 'run');
  const insights = runCmd?.commands.find(c => c.name() === 'insights');
  if (!insights) throw new Error('run insights command not found');
  const flags = new Set<string>();
  for (const opt of insights.options) {
    if (opt.short) flags.add(opt.short);
    if (opt.long) flags.add(opt.long);
  }
  return flags;
}

const examples = CLI_ONLY_EXAMPLES['run-insights']?.examples ?? [];

describe('run-insights copy examples', () => {
  it('only reference flags the `run insights` command registers', () => {
    const flags = registeredFlags();
    const tokens = examples.flatMap(example => example.split(/\s+/)).filter(token => token.startsWith('-'));

    const unknown = tokens.filter(token => !flags.has(token));
    expect(unknown).toEqual([]);
  });

  it('does not reference the non-existent --lookback flag', () => {
    for (const example of examples) {
      expect(example).not.toMatch(/--lookback\s/);
    }
  });
});
