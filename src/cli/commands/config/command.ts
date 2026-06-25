import { COMMAND_DESCRIPTIONS } from '../../constants.js';
import { finalizeAndExit, withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import type { CommandAttrs } from '../../telemetry/schemas/command-run.js';
import { handleConfigGet, handleConfigList, handleConfigSet } from './actions.js';
import type { ConfigResult } from './types.js';
import type { Command } from '@commander-js/extra-typings';

function resolveAction(key?: string, value?: string): () => Promise<ConfigResult> {
  if (!key) return () => handleConfigList();
  if (value === undefined) return () => handleConfigGet(key);
  return () => handleConfigSet(key, value);
}

// key/value are never recorded (PII/secret risk); only the derived action verb.
function deriveConfigAction(key?: string, value?: string): CommandAttrs<'config'>['config_action'] {
  if (!key) return 'list';
  if (value === undefined) return 'get';
  return 'set';
}

function printResult(result: ConfigResult): void {
  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.error.message);
  }
}

export function registerConfig(program: Command) {
  program
    .command('config')
    .description(COMMAND_DESCRIPTIONS.config)
    .argument('[key]', 'Config key in dot notation (e.g. telemetry.enabled)')
    .argument('[value]', 'Value to set')
    .action(async (key?: string, value?: string) => {
      const result = await withCommandRunTelemetry(
        'config',
        { config_action: deriveConfigAction(key, value) },
        () => resolveAction(key, value)()
      );
      printResult(result);
      await finalizeAndExit(result.success ? 0 : 1);
    });
}
