import { ConfigIO, ResourceNotFoundError, ValidationError } from '../../../lib';
import type { InterceptorDeployedState } from '../../../schema';
import { maskAccountId } from '../../aws/mask';

/**
 * Shared mode-check helper for `agentcore logs interceptor` and
 * `agentcore invoke interceptor`. Both verbs are managed-only — they require
 * a Lambda the CLI deployed and exposed in deployed-state. External
 * interceptors are routed to remediation messages.
 *
 * The helper:
 *   1. Reads `deployed-state.json` (target name defaults to 'default')
 *   2. Locates the interceptor under any target's `mcp.interceptors` map
 *   3. Returns the entry on success
 *   4. Throws a structured ValidationError with the canonical remediation
 *      message on external mode (the caller surfaces the message to stderr)
 *   5. Throws ResourceNotFoundError if the name isn't deployed
 *
 * ARN segments in remediation output go through `maskAccountId()` per the
 * PII handling policy (Decision #18).
 */
export interface InterceptorModeCheckResult {
  /** The deployed-state entry for the interceptor. */
  entry: InterceptorDeployedState;
  /** The deployment target name where this interceptor lives. */
  targetName: string;
}

const LOGS_REMEDIATION = (interceptorArn: string) =>
  `Use the AWS CLI to tail logs for the underlying function:\n` +
  `  aws logs tail /aws/lambda/<your-function-name> --follow\n` +
  `\n` +
  `(Lambda: ${maskAccountId(interceptorArn)})`;

const INVOKE_REMEDIATION = (interceptorArn: string) =>
  `Use the AWS CLI to invoke the underlying function:\n` +
  `  aws lambda invoke --function-name <your-function-name> --payload file://event.json out.json\n` +
  `\n` +
  `(Lambda: ${maskAccountId(interceptorArn)})`;

export async function lookupInterceptor(name: string, targetName?: string): Promise<InterceptorModeCheckResult> {
  const configIO = new ConfigIO();
  const deployedState = await configIO.readDeployedState();

  const targetEntries = Object.entries(deployedState.targets ?? {});
  const candidates = targetName ? targetEntries.filter(([n]) => n === targetName) : targetEntries;

  const matches: InterceptorModeCheckResult[] = [];
  for (const [tn, target] of candidates) {
    const entry = target.resources?.mcp?.interceptors?.[name];
    if (entry) {
      matches.push({ entry, targetName: tn });
    }
  }

  if (matches.length === 0) {
    throw new ResourceNotFoundError(
      `Interceptor "${name}" is not deployed. Verify the name in agentcore.json and run \`agentcore deploy\` to provision it.`
    );
  }
  if (matches.length > 1) {
    throw new ValidationError(
      `Interceptor "${name}" found in multiple targets: ${matches.map(m => m.targetName).join(', ')}. ` +
        `Use --target to disambiguate.`
    );
  }
  return matches[0]!;
}

/**
 * Throws a `ValidationError` with the canonical `aws logs tail` remediation
 * when the named interceptor is external. Returns the deployed-state entry
 * when the interceptor is managed.
 */
export async function ensureManagedForLogs(name: string, targetName?: string): Promise<InterceptorModeCheckResult> {
  const result = await lookupInterceptor(name, targetName);
  if (result.entry.mode === 'external') {
    throw new ValidationError(
      `'${name}' is an external interceptor (Lambda not managed by agentcore CLI).\n${LOGS_REMEDIATION(result.entry.interceptorArn)}`
    );
  }
  return result;
}

/**
 * Throws a `ValidationError` with the canonical `aws lambda invoke` remediation
 * when the named interceptor is external. Returns the deployed-state entry
 * when the interceptor is managed.
 */
export async function ensureManagedForInvoke(name: string, targetName?: string): Promise<InterceptorModeCheckResult> {
  const result = await lookupInterceptor(name, targetName);
  if (result.entry.mode === 'external') {
    throw new ValidationError(
      `'${name}' is an external interceptor (Lambda not managed by agentcore CLI).\n${INVOKE_REMEDIATION(result.entry.interceptorArn)}`
    );
  }
  return result;
}
