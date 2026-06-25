import { ConfigIO } from '../../../lib';
import { buildRuntimeInvocationUrl } from '../../commands/status/constants';
import { fetchOAuthToken } from './oauth-token';
import type { TokenFetchResult } from './types';

/**
 * Resolve invoke access for a deployed agent runtime.
 *
 * AWS_IAM agents have no token to fetch (SigV4 signing is used instead) but DO have an
 * invoke URL, so we surface the runtime invocation URL plus a SigV4 message — parity with
 * the AWS_IAM gateway path. CUSTOM_JWT agents additionally fetch an OAuth access token.
 */
export async function fetchRuntimeAccess(
  agentName: string,
  options: { configIO?: ConfigIO; deployTarget?: string; identityName?: string } = {}
): Promise<TokenFetchResult> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();
  const awsTargets = await configIO.readAWSDeploymentTargets();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found. Run `agentcore deploy` first.');
  }

  const targetName = options.deployTarget ?? targetNames[0]!;
  const target = deployedState.targets[targetName];
  if (!target) {
    throw new Error(`Deployment target '${targetName}' not found. Available targets: ${targetNames.join(', ')}`);
  }

  const agentSpec = projectSpec.runtimes.find(a => a.name === agentName);
  if (!agentSpec) {
    const available = projectSpec.runtimes.map(a => a.name);
    throw new Error(`Agent '${agentName}' not found in project. Available agents: ${available.join(', ') || 'none'}`);
  }

  const deployedRuntime = target.resources?.runtimes?.[agentName];
  if (!deployedRuntime?.runtimeArn) {
    throw new Error(`Agent '${agentName}' does not have a deployed runtime. Run \`agentcore deploy\` first.`);
  }

  const region = awsTargets.find(t => t.name === targetName)?.region;
  const url = region ? buildRuntimeInvocationUrl(region, deployedRuntime.runtimeArn) : '';

  const authType = agentSpec.authorizerType ?? 'AWS_IAM';

  if (authType === 'AWS_IAM') {
    return {
      url,
      authType: 'AWS_IAM',
      message: 'This agent uses AWS_IAM authentication. Use AWS SigV4 signing to invoke.',
    };
  }

  const jwtConfig = agentSpec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwtConfig) {
    throw new Error(`Agent '${agentName}' is configured as CUSTOM_JWT but has no customJwtAuthorizer configuration.`);
  }

  const result = await fetchOAuthToken({
    resourceName: agentName,
    jwtConfig,
    deployedState,
    targetName,
    credentials: projectSpec.credentials,
    credentialName: options.identityName,
  });

  return {
    url,
    authType: 'CUSTOM_JWT',
    token: result.token,
    expiresIn: result.expiresIn,
  };
}
