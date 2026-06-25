import { COMMAND_DESCRIPTIONS } from '../../constants.js';
import { handleConfigGet, handleConfigList, handleConfigSet } from './actions.js';
import { formatConfigKeys } from './constants.js';
import type { ConfigResult } from './types.js';
import type { Command } from '@commander-js/extra-typings';

function resolveAction(key?: string, value?: string): () => Promise<ConfigResult> {
  if (!key) return () => handleConfigList();
  if (value === undefined) return () => handleConfigGet(key);
  return () => handleConfigSet(key, value);
}

function printResult(result: ConfigResult): void {
  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.error.message);
  }
}

export function registerConfig(program: Command) {
  const config = program
    .command('config')
    .description(COMMAND_DESCRIPTIONS.config)
    .argument('[key]', 'Config key in dot notation (e.g. telemetry.enabled)')
    .argument('[value]', 'Value to set')
    .action(async (key?: string, value?: string) => {
      const result = await resolveAction(key, value)();
      printResult(result);
      if (!result.success) process.exit(1);
    });

  config.addHelpText(
    'after',
    `
Valid config keys:
${formatConfigKeys()}

Examples:
  List config:  agentcore config
  Get a value:  agentcore config telemetry.enabled
  Set a value:  agentcore config telemetry.enabled true`
  );
}
