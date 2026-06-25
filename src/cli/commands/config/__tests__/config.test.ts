import { handleConfigSet } from '../actions';
import { registerConfig } from '../command';
import { CONFIG_KEYS } from '../constants';
import { Command } from '@commander-js/extra-typings';
import { describe, expect, it } from 'vitest';

describe('config command discoverability', () => {
  it('enumerates every valid config key in --help output', () => {
    const program = new Command();
    registerConfig(program);
    const config = program.commands.find(c => c.name() === 'config')!;
    let help = '';
    config.configureOutput({ writeOut: s => (help += s) });
    config.outputHelp();
    for (const { key } of CONFIG_KEYS) {
      expect(help).toContain(key);
    }
  });

  it('lists valid keys in the invalid-set error', async () => {
    const result = await handleConfigSet('notARealKey', 'x');
    expect(result.success).toBe(false);
    if (!result.success) {
      for (const { key } of CONFIG_KEYS) {
        expect(result.error.message).toContain(key);
      }
    }
  });
});
