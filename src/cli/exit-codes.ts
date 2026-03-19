import {
  getErrorMessage,
  isAccessDeniedError,
  isChangesetInProgressError,
  isExpiredTokenError,
  isNoCredentialsError,
  isStackInProgressError,
} from './errors.js';

/**
 * Structured exit codes for different CLI failure categories.
 * These enable programmatic distinction between failure types
 * in CI/CD pipelines and wrapper scripts.
 */
export const ExitCode = {
  /** Command succeeded */
  SUCCESS: 0,
  /** Unknown/unhandled error */
  GENERAL_ERROR: 1,
  /** Invalid CLI arguments or missing required flags */
  INVALID_ARGS: 2,
  /** AWS credentials expired or invalid */
  AUTH_EXPIRED: 3,
  /** IAM permission error */
  ACCESS_DENIED: 4,
  /** Requested agent doesn't exist */
  AGENT_NOT_FOUND: 5,
  /** Deployment/CloudFormation failure */
  DEPLOY_FAILED: 6,
} as const;

/**
 * Union type of all valid exit code values.
 */
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Determines the appropriate exit code for a given error.
 *
 * Checks error types in priority order:
 * 1. Access denied (IAM permission errors)
 * 2. Expired/invalid credentials
 * 3. Missing credentials
 * 4. Commander invalid argument errors
 * 5. CloudFormation deployment failures
 * 6. Agent not found
 * 7. Default: general error
 *
 * @param err - The error to classify
 * @returns The appropriate exit code number
 */
export function getExitCode(err: unknown): number {
  // 1. Access denied errors (IAM permission issues)
  if (isAccessDeniedError(err)) {
    return ExitCode.ACCESS_DENIED;
  }

  // 2. Expired or invalid credentials
  if (isExpiredTokenError(err)) {
    return ExitCode.AUTH_EXPIRED;
  }

  // 3. Missing credentials (also an auth issue)
  if (isNoCredentialsError(err)) {
    return ExitCode.AUTH_EXPIRED;
  }

  // 4. Commander invalid argument errors
  if (isCommanderInvalidArgError(err)) {
    return ExitCode.INVALID_ARGS;
  }

  // 5. CloudFormation deployment failures
  if (isStackInProgressError(err) || isChangesetInProgressError(err)) {
    return ExitCode.DEPLOY_FAILED;
  }

  // 6. Agent not found
  if (isAgentNotFoundError(err)) {
    return ExitCode.AGENT_NOT_FOUND;
  }

  // 7. Default: general error
  return ExitCode.GENERAL_ERROR;
}

/**
 * Checks if an error is a Commander.js invalid argument error.
 * Commander sets specific `code` and `exitCode` properties on its errors.
 */
function isCommanderInvalidArgError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false;
  }

  const code = (err as { code?: string }).code;

  // Commander.js sets code property for specific error types
  if (
    code === 'commander.invalidArgument' ||
    code === 'commander.missingArgument' ||
    code === 'commander.missingMandatoryOptionValue' ||
    code === 'commander.optionMissingArgument'
  ) {
    return true;
  }

  // Commander.js sets exitCode to 2 for argument validation errors
  const exitCode = (err as { exitCode?: number }).exitCode;
  if (exitCode === 2) {
    const constructorName = err.constructor?.name;
    if (constructorName === 'CommanderError' || constructorName === 'InvalidArgumentError') {
      return true;
    }
  }

  return false;
}

/**
 * Checks if an error indicates that a requested agent was not found.
 * Uses message-based pattern matching as a best-effort classification.
 */
function isAgentNotFoundError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();

  // Match patterns like "Agent 'my-agent' not found"
  if (message.includes('agent') && (message.includes('not found') || message.includes('not deployed'))) {
    return true;
  }

  // Match patterns like "No agents defined in agentcore.json"
  if (message.includes('no agents defined')) {
    return true;
  }

  return false;
}
