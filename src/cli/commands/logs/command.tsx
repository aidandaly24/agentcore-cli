import { COMMAND_DESCRIPTIONS } from '../../constants';
import { getErrorMessage } from '../../errors';
import { handleLogsEval } from '../../operations/eval';
import type { LogsEvalOptions } from '../../operations/eval';
import { runCliCommand, withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import { requireProject } from '../../tui/guards';
import { handleLogs } from './action';
import { type LogsInterceptorOptions, handleLogsInterceptor } from './interceptor';
import type { LogsOptions } from './types';
import type { Command } from '@commander-js/extra-typings';
import { Text, render } from 'ink';
import React from 'react';

export const registerLogs = (program: Command) => {
  // enablePositionalOptions + passThroughOptions ensure options like --since and --runtime
  // are passed to the 'evals' subcommand rather than being consumed by the parent 'logs' command.
  program.enablePositionalOptions();

  const logsCmd = program
    .command('logs')
    .alias('l')
    .enablePositionalOptions()
    .passThroughOptions()
    .description(COMMAND_DESCRIPTIONS.logs)
    .option('--runtime <name>', 'Select specific runtime')
    .option('--since <time>', 'Start time — defaults to 1h ago in search mode (e.g. "1h", "30m", "2d", ISO 8601)')
    .option('--until <time>', 'End time — defaults to now in search mode (e.g. "now", ISO 8601)')
    .option('--level <level>', 'Filter by log level (error, warn, info, debug)')
    .option('-n, --limit <count>', 'Maximum number of log lines to return')
    .option('--query <text>', 'Server-side text filter')
    .option('--json', 'Output as JSON Lines')
    .action(async (cliOptions: LogsOptions) => {
      requireProject();

      try {
        const result = await withCommandRunTelemetry(
          'logs',
          { has_query: !!cliOptions.query, has_level_filter: !!cliOptions.level },
          () => handleLogs(cliOptions)
        );

        if (!result.success) {
          render(<Text color="red">{result.error.message}</Text>);
          process.exit(1);
        }
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });

  logsCmd
    .command('evals')
    .description('Stream or search online eval logs')
    .option('-r, --runtime <name>', 'Select specific runtime')
    .option('--since <time>', 'Start time (e.g. "1h", "30m", "2d", ISO 8601)')
    .option('--until <time>', 'End time (e.g. "now", ISO 8601)')
    .option('-n, --limit <count>', 'Maximum number of log lines')
    .option('-f, --follow', 'Stream logs in real-time (default when no --since/--until)')
    .option('--json', 'Output as JSON Lines')
    .action(async (cliOptions: LogsEvalOptions) => {
      requireProject();

      try {
        const result = await withCommandRunTelemetry('logs.evals', { has_follow: !!cliOptions.follow }, () =>
          handleLogsEval(cliOptions)
        );

        if (!result.success) {
          render(<Text color="red">{result.error.message}</Text>);
          process.exit(1);
        }
      } catch (error) {
        render(<Text color="red">Error: {getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });

  logsCmd
    .command('interceptor')
    .description('Stream or search Lambda interceptor logs (managed mode only)')
    .option('--name <name>', 'Interceptor name (required)')
    .option('--target <name>', 'Deployment target (defaults to first target)')
    .option('--since <time>', 'Start time (e.g. "1h", "30m", "2d", ISO 8601)')
    .option('--until <time>', 'End time (e.g. "now", ISO 8601)')
    .option('-n, --limit <count>', 'Maximum number of log lines')
    .option('-f, --follow', 'Stream logs in real-time (default when no --since/--until)')
    .option('--json', 'Output as JSON Lines')
    .action(async (cliOptions: LogsInterceptorOptions) => {
      requireProject();

      try {
        // mode here is always 'managed' on success (external short-circuits
        // via the structured ValidationError before the success path).
        // Telemetry surface kept consistent with sibling events.
        await runCliCommand('logs.interceptor', !!cliOptions.json, async () => {
          const r = await handleLogsInterceptor(cliOptions);
          if (!r.success) {
            throw r.error;
          }
          return { mode: 'managed' as const, has_follow: !!cliOptions.follow };
        });
      } catch (error) {
        render(<Text color="red">{getErrorMessage(error)}</Text>);
        process.exit(1);
      }
    });
};
