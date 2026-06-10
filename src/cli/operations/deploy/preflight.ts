import { ConfigIO, DOCKERFILE_NAME, getDockerfilePath, requireConfigRoot, resolveCodeLocation } from '../../../lib';
import { ValidationError } from '../../../lib/errors/types';
import type { AgentCoreProjectSpec, AwsDeploymentTarget } from '../../../schema';
import { getCredentialProvider, validateAwsCredentials } from '../../aws/account';
import { accountIdFromArn, maskAccountId } from '../../aws/mask';
import { LocalCdkProject } from '../../cdk/local-cdk-project';
import { CdkToolkitWrapper, createCdkToolkitWrapper, silentIoHost } from '../../cdk/toolkit-lib';
import { checkBootstrapStatus, checkStacksStatus, formatCdkEnvironment } from '../../cloudformation';
import { cleanupStaleLockFiles } from '../../tui/utils';
import type { IIoHost } from '@aws-cdk/toolkit-lib';
import { GetFunctionCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';

export interface PreflightContext {
  projectSpec: AgentCoreProjectSpec;
  awsTargets: AwsDeploymentTarget[];
  cdkProject: LocalCdkProject;
  /** True when agents array is empty but a deployed stack exists — deploy will tear down resources */
  isTeardownDeploy: boolean;
}

export interface SynthResult {
  toolkitWrapper: CdkToolkitWrapper;
  stackNames: string[];
}

export interface BootstrapCheckResult {
  needsBootstrap: boolean;
  target: AwsDeploymentTarget | null;
}

export interface StackStatusCheckResult {
  /** Whether all stacks are in a deployable state */
  canDeploy: boolean;
  /** The stack that is blocking deployment, if any */
  blockingStack?: string;
  /** User-friendly message explaining why deployment is blocked */
  message?: string;
}

/**
 * Format an error for user display, including stack trace if available.
 */
export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const lines = [err.message];
    if (err.stack) {
      lines.push('', 'Stack trace:', err.stack);
    }
    if (err.cause) {
      lines.push('', 'Caused by:', formatError(err.cause));
    }
    return lines.join('\n');
  }
  return String(err);
}

/**
 * Validates the CDK project and loads configuration.
 * Also validates AWS credentials are configured before proceeding.
 * Returns the project context needed for subsequent steps.
 */
const MAX_RUNTIME_NAME_LENGTH = 48;
const MAX_GATEWAY_COMBINED_NAME_LENGTH = 48;

export async function validateProject(): Promise<PreflightContext> {
  // Find the agentcore config directory, walking up from cwd if needed
  const configRoot = requireConfigRoot();
  // Project root is the parent of the agentcore directory
  const projectRoot = path.dirname(configRoot);

  const cdkProject = new LocalCdkProject(projectRoot);
  cdkProject.validate();

  const configIO = new ConfigIO({ baseDir: configRoot });

  const projectSpec = await configIO.readProjectSpec();
  const awsTargets = await configIO.resolveAWSDeploymentTargets();

  // Validate that at least one agent or gateway is defined, unless this is a teardown deploy.
  //
  // Teardown detection: when agents is empty but deployed-state.json records existing
  // targets, the user has run `remove all` and wants to tear down AWS resources via deploy.
  // deployed-state.json is written by the CLI after every successful deploy, so it is a
  // reliable indicator of whether a CloudFormation stack exists for this project.
  let isTeardownDeploy = false;
  const hasAgents = projectSpec.runtimes && projectSpec.runtimes.length > 0;
  const hasMemories = projectSpec.memories && projectSpec.memories.length > 0;
  const hasEvaluators = projectSpec.evaluators && projectSpec.evaluators.length > 0;
  const hasPolicyEngines = projectSpec.policyEngines && projectSpec.policyEngines.length > 0;
  const hasHarnesses = projectSpec.harnesses && projectSpec.harnesses.length > 0;
  const hasDatasets = projectSpec.datasets && projectSpec.datasets.length > 0;

  // Check for gateways in agentcore.json
  const hasGateways = projectSpec.agentCoreGateways && projectSpec.agentCoreGateways.length > 0;
  const hasPayments = projectSpec.payments && projectSpec.payments.length > 0;

  if (
    !hasAgents &&
    !hasGateways &&
    !hasMemories &&
    !hasEvaluators &&
    !hasPolicyEngines &&
    !hasHarnesses &&
    !hasDatasets &&
    !hasPayments
  ) {
    let hasExistingStack = false;
    try {
      const deployedState = await configIO.readDeployedState();
      hasExistingStack = Object.keys(deployedState.targets).length > 0;
    } catch {
      // No deployed state file — no existing stack
    }
    if (!hasExistingStack) {
      throw new ValidationError(
        'No resources defined in project. Add at least one resource (agent, memory, evaluator, or gateway) before deploying.'
      );
    }
    isTeardownDeploy = true;
  }

  // Validate runtime names don't exceed AWS limits
  validateRuntimeNames(projectSpec);

  // Validate HTTP gateway names don't exceed AWS limits when combined with project name
  validateHttpGatewayNames(projectSpec);

  // Validate Container agents have Dockerfiles
  validateContainerAgents(projectSpec, configRoot);

  // Validate Lambda interceptors:
  //   - cardinality is enforced by superRefine, but this re-checks for safety
  //   - managed-mode codeLocation must exist on disk
  //   - external-mode cross-account is a WARNING (not an error) so legitimate
  //     centralized-auth / multi-account interceptor patterns don't fail deploy
  await validateInterceptors(projectSpec, awsTargets, configRoot);

  // Validate AWS credentials before proceeding with build/synth.
  // Skip for teardown deploys — callers validate after teardown confirmation.
  if (!isTeardownDeploy) {
    await validateAwsCredentials();
    // Best-effort `lambda:GetFunction` preflight for `lambda-function-arn`
    // gateway targets. WARNs on any failure but never blocks deploy. Runs
    // after credentials are validated so we know the SDK call has a chance
    // of succeeding.
    await validateGatewayTargetLambdas(projectSpec);
  }

  return { projectSpec, awsTargets, cdkProject, isTeardownDeploy };
}

/**
 * Validates that combined runtime names (projectName_agentName) don't exceed AWS limits.
 */
function validateRuntimeNames(projectSpec: AgentCoreProjectSpec): void {
  const projectName = projectSpec.name;
  for (const agent of projectSpec.runtimes || []) {
    const agentName = agent.name;
    if (agentName) {
      const combinedName = `${projectName}_${agentName}`;
      if (combinedName.length > MAX_RUNTIME_NAME_LENGTH) {
        throw new ValidationError(
          `Runtime name too long: "${combinedName}" (${combinedName.length} chars). ` +
            `AWS limits runtime names to ${MAX_RUNTIME_NAME_LENGTH} characters. ` +
            `Shorten the project name or agent name in agentcore.json.`
        );
      }
    }
  }
}

/**
 * Validates that combined HTTP gateway names (projectName-gatewayName) don't exceed AWS limits.
 */
function validateHttpGatewayNames(projectSpec: AgentCoreProjectSpec): void {
  const projectName = projectSpec.name;
  for (const gateway of projectSpec.httpGateways ?? []) {
    const gwName = gateway.name;
    if (gwName) {
      const combinedName = `${projectName}-${gwName}`;
      if (combinedName.length > MAX_GATEWAY_COMBINED_NAME_LENGTH) {
        throw new Error(
          `HTTP gateway name too long: "${combinedName}" (${combinedName.length} chars). ` +
            `AWS limits gateway names to ${MAX_GATEWAY_COMBINED_NAME_LENGTH} characters. ` +
            `Shorten the project name or gateway name in agentcore.json.`
        );
      }
    }
    for (const target of gateway.targets ?? []) {
      const combined = `${projectName}-${target.name}`;
      if (combined.length > MAX_GATEWAY_COMBINED_NAME_LENGTH) {
        const maxTargetLen = MAX_GATEWAY_COMBINED_NAME_LENGTH - projectName.length - 1;
        throw new Error(
          `HTTP gateway target "${target.name}" in gateway "${gwName}" would exceed the ${MAX_GATEWAY_COMBINED_NAME_LENGTH}-character AWS limit when prefixed with project name "${projectName}-" (total: ${combined.length} chars). ` +
            `Shorten the target name to ${maxTargetLen} characters or fewer.`
        );
      }
    }
  }
}

/**
 * Validates Lambda interceptors before deploy.
 *
 * Cardinality / unique-point / gateway-name reference are already enforced via
 * superRefine on `agentcore-project.ts`; this function focuses on the checks
 * that need filesystem or AWS context (codeLocation existence, cross-account
 * detection).
 *
 * Cross-account behavior intentionally WARNS rather than errors — see Decision
 * #8 in the DevEx doc. The user's gateway role can be granted
 * `lambda:InvokeFunction` on a foreign ARN; what fails is the first invocation
 * until the foreign Lambda has a matching resource-based policy. We emit the
 * `aws lambda add-permission` snippet so the user can resolve the manual step
 * out-of-band.
 *
 * Account IDs in printed output go through `maskAccountId()` per Decision #18.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- kept async so callers can await; future preflight checks (e.g. ARN reachability) will use AWS SDK calls
export async function validateInterceptors(
  projectSpec: AgentCoreProjectSpec,
  awsTargets: AwsDeploymentTarget[],
  configRoot: string
): Promise<void> {
  const interceptors = projectSpec.interceptors ?? [];
  if (interceptors.length === 0) return;

  const errors: string[] = [];
  const projectRoot = path.dirname(configRoot);

  // Managed-mode codeLocation must exist.
  for (const interceptor of interceptors) {
    if (interceptor.config.managed) {
      const codeDir = path.join(projectRoot, interceptor.config.managed.codeLocation);
      if (!existsSync(codeDir)) {
        errors.push(
          `Interceptor "${interceptor.name}": codeLocation "${interceptor.config.managed.codeLocation}" not found. ` +
            `Run \`agentcore add interceptor\` to scaffold it, or fix the path in agentcore.json.`
        );
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }

  // Header coupling: a managed interceptor whose handler reads request headers
  // (e.g. the jwt-scope-authorizer template) silently receives empty headers
  // when passRequestHeaders is disabled, breaking the handler with no runtime
  // error. We can't key off the template (the spec doesn't record it), so we
  // grep the handler source for header access and warn only on a real conflict.
  for (const interceptor of interceptors) {
    if (!interceptor.config.managed) continue;
    if (interceptor.passRequestHeaders !== false) continue;

    const handlerPath = resolveInterceptorHandlerPath(projectRoot, interceptor.config.managed);
    if (!handlerPath || !readsRequestHeaders(handlerPath)) continue;

    console.warn(
      `WARNING: Interceptor "${interceptor.name}" has passRequestHeaders disabled, but its\n` +
        `handler reads request headers. With headers disabled the handler receives an empty\n` +
        `headers map, so any header-based logic (e.g. reading the Authorization token) will\n` +
        `silently no-op. Set passRequestHeaders to true (or omit it) if the handler needs headers.`
    );
  }

  // External-mode cross-account: a concise heads-up at preflight. The full
  // copy-paste `add-permission` snippet is emitted post-deploy (see
  // buildCrossAccountInterceptorWarnings), where the resolved gateway role ARN
  // — the snippet's `--principal` — actually exists. Warn once per interceptor
  // whose ARN account differs from every deploy target.
  const warned = new Set<string>();
  for (const interceptor of interceptors) {
    const ext = interceptor.config.external;
    if (!ext) continue;
    const lambdaAccountId = accountIdFromArn(ext.lambdaArn);
    if (!lambdaAccountId) continue;

    // Cross-account = no deploy target shares the Lambda's account. If even
    // one deploy target is same-account, the IAM grant works in that target
    // and the warning would be incorrect noise.
    const crossAccount = awsTargets.length > 0 && awsTargets.every(t => t.account !== lambdaAccountId);
    if (!crossAccount || warned.has(interceptor.name)) continue;
    warned.add(interceptor.name);

    console.warn(
      `WARNING: Cross-account interceptor "${interceptor.name}" (Lambda: ${maskAccountId(ext.lambdaArn)}).\n` +
        `The first invocation will fail until you add a resource-based policy to the Lambda. ` +
        `After deploy, the CLI prints the exact \`aws lambda add-permission\` command with the resolved gateway role ARN.`
    );
  }
}

/**
 * Build post-deploy cross-account interceptor warnings.
 *
 * Emitted after deploy because the gateway execution role ARN — the
 * `--principal` for the foreign Lambda's resource-based policy — only exists in
 * deployed-state once the gateway is created. Returns one actionable snippet
 * per cross-account external interceptor. The gateway role ARN is the
 * customer's OWN account and is printed unmasked (it must be copy-pasteable);
 * the foreign Lambda ARN is masked.
 */
export function buildCrossAccountInterceptorWarnings(
  projectSpec: AgentCoreProjectSpec,
  awsTargets: AwsDeploymentTarget[],
  gatewayRoleArns: Record<string, string | undefined>
): string[] {
  const warnings: string[] = [];
  for (const interceptor of projectSpec.interceptors ?? []) {
    const ext = interceptor.config.external;
    if (!ext) continue;
    const lambdaAccountId = accountIdFromArn(ext.lambdaArn);
    if (!lambdaAccountId) continue;

    const crossAccount = awsTargets.length > 0 && awsTargets.every(t => t.account !== lambdaAccountId);
    if (!crossAccount) continue;

    const roleArn = gatewayRoleArns[interceptor.gatewayName];
    const principal = roleArn ?? '<gateway-role-arn (see deployed-state.json)>';

    warnings.push(
      `Cross-account interceptor "${interceptor.name}" needs a resource-based policy on its Lambda.\n` +
        `  Lambda: ${maskAccountId(ext.lambdaArn)}\n` +
        `Run this in the Lambda's account before sending traffic through the gateway:\n` +
        `\n` +
        `  aws lambda add-permission \\\n` +
        `    --function-name ${maskAccountId(ext.lambdaArn)} \\\n` +
        `    --statement-id GatewayInterceptorInvoke \\\n` +
        `    --action lambda:InvokeFunction \\\n` +
        `    --principal ${principal}`
    );
  }
  return warnings;
}

/**
 * Resolve the on-disk path to a managed interceptor's handler source file.
 *
 * The entrypoint is `<module>.<function>` (e.g. `handler.lambda_handler` for
 * Python, `index.handler` for Node). We resolve `<module>` against the code
 * directory, trying the runtime-appropriate extensions. Returns undefined if
 * no candidate exists.
 */
function resolveInterceptorHandlerPath(
  projectRoot: string,
  managed: { codeLocation: string; entrypoint?: string; runtime?: string }
): string | undefined {
  const moduleName = (managed.entrypoint ?? 'handler.lambda_handler').split('.')[0];
  if (!moduleName) return undefined;
  const codeDir = path.join(projectRoot, managed.codeLocation);
  const exts = managed.runtime === 'nodejs22.x' ? ['.mjs', '.js', '.cjs', '.ts'] : ['.py'];
  for (const ext of exts) {
    const candidate = path.join(codeDir, `${moduleName}${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Heuristic: does an interceptor handler read inbound request headers? Matches
 * the `headers`/`authorization` access the header-reading templates use. A
 * false negative just suppresses the advisory warning (deploy still proceeds),
 * so a loose match is acceptable.
 */
function readsRequestHeaders(handlerPath: string): boolean {
  try {
    const source = readFileSync(handlerPath, 'utf-8').toLowerCase();
    return source.includes('headers') || source.includes('authorization');
  } catch {
    return false;
  }
}

/**
 * Best-effort preflight for `lambda-function-arn` gateway targets: tries
 * `lambda:GetFunction` for each target ARN. On any failure (NotFound, 403,
 * throttle, network) emits a WARN with the masked ARN and the underlying
 * reason, then continues — deploy proceeds and CloudFormation may still roll
 * back if the Lambda is genuinely missing. Without this, a typo'd ARN
 * surfaces only as a CFN ROLLBACK_COMPLETE that requires manual stack
 * deletion before retry.
 *
 * Cross-account ARNs intentionally hit the same WARN path: we cannot
 * distinguish "doesn't exist" from "you don't have permission to read it",
 * so we don't try to. The user gets enough information to decide whether to
 * proceed.
 *
 * The check uses the ARN's region (not the deploy target's region) because
 * Lambda ARNs encode their region and `GetFunction` is region-scoped.
 */
export async function validateGatewayTargetLambdas(projectSpec: AgentCoreProjectSpec): Promise<void> {
  const gateways = projectSpec.agentCoreGateways ?? [];
  if (gateways.length === 0) return;

  const credentials = getCredentialProvider();
  const clientsByRegion = new Map<string, LambdaClient>();

  for (const gateway of gateways) {
    for (const target of gateway.targets ?? []) {
      const arn = target.lambdaFunctionArn?.lambdaArn;
      if (!arn) continue;

      const region = regionFromLambdaArn(arn);
      if (!region) continue;

      let client = clientsByRegion.get(region);
      if (!client) {
        client = new LambdaClient({ region, credentials });
        clientsByRegion.set(region, client);
      }

      try {
        await client.send(new GetFunctionCommand({ FunctionName: arn }));
      } catch (err) {
        const reason = err instanceof Error ? (err.name ?? err.message) : String(err);

        console.warn(
          `WARNING: Could not verify Lambda target "${target.name}" exists.\n` +
            `  ARN:    ${maskAccountId(arn)}\n` +
            `  Reason: ${reason}\n` +
            `\n` +
            `Deploy will continue. If the ARN is wrong, the stack will roll back\n` +
            `and you'll need to \`aws cloudformation delete-stack\` before retrying.`
        );
      }
    }
  }
}

/** Extracts the region segment from a Lambda ARN (`arn:aws:lambda:<region>:...`). */
function regionFromLambdaArn(arn: string): string | undefined {
  const parts = arn.split(':');
  return parts.length >= 4 ? parts[3] : undefined;
}

/**
 * Validates that Container agents have required Dockerfiles.
 */
export function validateContainerAgents(projectSpec: AgentCoreProjectSpec, configRoot: string): void {
  const errors: string[] = [];
  for (const agent of projectSpec.runtimes || []) {
    if (agent.build === 'Container') {
      const codeLocation = resolveCodeLocation(agent.codeLocation, configRoot);
      const dockerfilePath = getDockerfilePath(codeLocation, agent.dockerfile);

      if (!existsSync(dockerfilePath)) {
        errors.push(
          `Agent "${agent.name}": ${agent.dockerfile ?? DOCKERFILE_NAME} not found at ${dockerfilePath}. Container agents require a Dockerfile.`
        );
      } else {
        warnDeprecatedBaseImage(dockerfilePath, agent.name);
      }
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

const DEPRECATED_BASE_IMAGES: Record<string, string> = {
  'slim-bookworm':
    'Affected by CVE-2026-42010 (GnuTLS authentication bypass). Update the FROM line to use a Trixie-based variant.',
};

function warnDeprecatedBaseImage(dockerfilePath: string, agentName: string): void {
  try {
    const content = readFileSync(dockerfilePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!/^\s*FROM\s+/i.test(line)) continue;
      for (const [image, message] of Object.entries(DEPRECATED_BASE_IMAGES)) {
        if (line.includes(image)) {
          console.warn(`Warning: Agent "${agentName}" Dockerfile uses a base image containing "${image}". ${message}`);
        }
      }
    }
  } catch {
    // Non-fatal — if we can't read the file, the existing validation will handle it
  }
}

/**
 * Builds the CDK project.
 */
export async function buildCdkProject(cdkProject: LocalCdkProject): Promise<void> {
  await cdkProject.build();
}

export interface SynthOptions {
  /** Custom IoHost for capturing CDK output. Defaults to silentIoHost. */
  ioHost?: IIoHost;
  /** Previous toolkit wrapper to dispose before synthesis. */
  previousWrapper?: CdkToolkitWrapper | null;
  /** Target region for CDK operations. Without this, toolkit may default to us-east-1. */
  region?: string;
}

/**
 * Synthesizes CloudFormation templates from the CDK project.
 * Disposes previous wrapper and cleans up stale lock files before synthesis.
 */
export async function synthesizeCdk(cdkProject: LocalCdkProject, options?: SynthOptions): Promise<SynthResult> {
  // Dispose previous wrapper to release CDK lock files
  if (options?.previousWrapper) {
    await options.previousWrapper.dispose();
  }

  // Clean up stale lock files from dead processes before CDK operations
  const cdkOutDir = path.join(cdkProject.projectDir, 'cdk.out');
  await cleanupStaleLockFiles(cdkOutDir);

  // Use provided ioHost or default to silentIoHost to prevent CDK output from interfering with TUI
  const toolkitWrapper = await createCdkToolkitWrapper({
    projectDir: cdkProject.projectDir,
    ioHost: options?.ioHost ?? silentIoHost,
    region: options?.region,
  });

  // synth() produces the assembly internally and stores the directory for later use
  const synthResult = await toolkitWrapper.synth();

  return {
    toolkitWrapper,
    stackNames: synthResult.stackNames,
  };
}

/**
 * Checks if the CloudFormation stacks are in a deployable state.
 * Returns information about any stack that would block deployment.
 */
export async function checkStackDeployability(region: string, stackNames: string[]): Promise<StackStatusCheckResult> {
  const blocking = await checkStacksStatus(region, stackNames);

  if (blocking) {
    return {
      canDeploy: false,
      blockingStack: blocking.stackName,
      message: blocking.result.message,
    };
  }

  return { canDeploy: true };
}

/**
 * Checks if AWS environment needs bootstrapping.
 * Returns the target that needs bootstrapping, or null if already bootstrapped.
 */
export async function checkBootstrapNeeded(awsTargets: AwsDeploymentTarget[]): Promise<BootstrapCheckResult> {
  const target = awsTargets[0];
  if (!target) {
    return { needsBootstrap: false, target: null };
  }

  try {
    const bootstrapStatus = await checkBootstrapStatus(target.region);
    if (!bootstrapStatus.isBootstrapped) {
      return { needsBootstrap: true, target };
    }
  } catch {
    // If we can't check bootstrap status, continue without bootstrapping
    // The deploy will fail with a clearer error
  }

  return { needsBootstrap: false, target: null };
}

/**
 * Bootstraps the AWS environment using the CDK toolkit.
 * CDK bootstrap automatically creates a KMS CMK for S3 bucket encryption.
 */
export async function bootstrapEnvironment(
  toolkitWrapper: CdkToolkitWrapper,
  target: AwsDeploymentTarget
): Promise<void> {
  const env = formatCdkEnvironment(target.account, target.region);
  await toolkitWrapper.bootstrap([env]);
}
