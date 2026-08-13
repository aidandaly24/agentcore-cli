import { AgentCoreCLIError, SilentCLIError } from "../errors";

// ExitCode provides names for default Unix exit codes.
export enum ExitCode {
  SUCCESS = 0,
  FAILURE = 1,
  USAGE = 2,
  INTERRUPTED = 130,
}

// Runnable can be implemented by any application's main entrypoint.
export interface Runnable {
  run(argv: string[]): Promise<void>;
}

// runRunnable creates and runs any instance of Runnable with proper exit code handling.
export function runRunnable(
  createRunnable: () => Runnable,
  argv: string[] = process.argv,
): Promise<number> {
  return runWithExitCode(async () => {
    await createRunnable().run(argv);
  });
}

// runWithExitCode safely runs the given function with exit code handling.
export async function runWithExitCode(
  fn: (argv: string[]) => Promise<void>,
  argv: string[] = process.argv,
): Promise<number> {
  try {
    await fn(argv);
    return ExitCode.SUCCESS;
  } catch (caught) {
    const error = AgentCoreCLIError.fromError(caught);
    if (!(error instanceof SilentCLIError)) console.error(`Error: ${error.message}`);
    return error.exitCode;
  }
}
