#!/usr/bin/env node
import { main } from './cli.js';
import { getErrorMessage } from './errors.js';
import { getExitCode } from './exit-codes.js';

// Global safety net — prevent raw stack traces from reaching the user
process.on('uncaughtException', err => {
  console.error(`Error: ${getErrorMessage(err)}`);
  process.exit(getExitCode(err));
});
process.on('unhandledRejection', reason => {
  console.error(`Error: ${getErrorMessage(reason)}`);
  process.exit(getExitCode(reason));
});

main(process.argv).catch(err => {
  console.error(getErrorMessage(err));
  process.exit(getExitCode(err));
});
