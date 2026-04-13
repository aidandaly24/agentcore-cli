import { ConfigIO } from '../../../lib';
import { fetch3LOTargetToken, fetchOAuthToken } from './oauth-token';
import type { TokenFetchResult } from './types';

export async function fetchGatewayToken(
  gatewayName: string,
  options: {
    configIO?: ConfigIO;
    deployTarget?: string;
    gatewayTarget?: string;
    identityName?: string;
  } = {}
): Promise<TokenFetchResult> {
  const configIO = options.configIO ?? new ConfigIO();

  const deployedState = await configIO.readDeployedState();
  const projectSpec = await configIO.readProjectSpec();

  const targetNames = Object.keys(deployedState.targets);
  if (targetNames.length === 0) {
    throw new Error('No deployed targets found. Run `agentcore deploy` first.');
  }

  const deployTarget = options.deployTarget ?? targetNames[0]!;
  const target = deployedState.targets[deployTarget];
  if (!target) {
    throw new Error(`Deployment target '${deployTarget}' not found. Available targets: ${targetNames.join(', ')}`);
  }

  const gatewaySpec = projectSpec.agentCoreGateways.find(g => g.name === gatewayName);
  if (!gatewaySpec) {
    const available = projectSpec.agentCoreGateways.map(g => g.name);
    throw new Error(
      `Gateway '${gatewayName}' not found in MCP configuration. Available gateways: ${available.join(', ') || 'none'}`
    );
  }

  const deployedGateways = target.resources?.mcp?.gateways ?? {};
  const deployedGateway = deployedGateways[gatewayName];
  if (!deployedGateway?.gatewayUrl) {
    throw new Error(
      `Gateway '${gatewayName}' does not have a deployed URL. Run \`agentcore deploy\` to deploy the gateway.`
    );
  }

  const gatewayUrl = deployedGateway.gatewayUrl;
  const authType = gatewaySpec.authorizerType;

  if (authType === 'NONE') {
    return {
      url: gatewayUrl,
      authType: 'NONE',
      message: 'No authentication required. Send requests directly to the URL.',
    };
  }

  if (authType === 'AWS_IAM') {
    return {
      url: gatewayUrl,
      authType: 'AWS_IAM',
      message: 'This gateway uses AWS IAM auth. Sign requests with SigV4 using your IAM credentials.',
    };
  }

  // CUSTOM_JWT auth — check if the requested target uses 3LO (AUTHORIZATION_CODE)
  const jwtConfig = gatewaySpec.authorizerConfiguration?.customJwtAuthorizer;
  if (!jwtConfig) {
    throw new Error(
      `Gateway '${gatewayName}' is configured as CUSTOM_JWT but has no customJwtAuthorizer configuration.`
    );
  }

  // If a specific gateway target is requested, check if it uses AUTHORIZATION_CODE
  if (options.gatewayTarget) {
    const targetSpec = gatewaySpec.targets.find(t => t.name === options.gatewayTarget);
    if (!targetSpec) {
      const available = gatewaySpec.targets.map(t => t.name);
      throw new Error(
        `Gateway target '${options.gatewayTarget}' not found. Available targets: ${available.join(', ') || 'none'}`
      );
    }

    if (targetSpec.outboundAuth?.grantType === 'AUTHORIZATION_CODE') {
      const credentialName = targetSpec.outboundAuth.credentialName;
      if (!credentialName) {
        throw new Error(`Gateway target '${options.gatewayTarget}' has AUTHORIZATION_CODE but no credentialName.`);
      }

      const awsTargets = await configIO.readAWSDeploymentTargets();
      const awsTarget = awsTargets.find(t => t.name === deployTarget);
      const region = awsTarget?.region ?? process.env.AWS_REGION ?? 'us-east-1';

      const tokenResult = await fetch3LOTargetToken({
        workloadName: projectSpec.name,
        credentialProviderName: credentialName,
        scopes: targetSpec.outboundAuth.scopes ?? [],
        resourceOauth2ReturnUrl: targetSpec.outboundAuth.defaultReturnUrl,
        region,
      });

      return {
        url: gatewayUrl,
        authType: 'CUSTOM_JWT',
        token: tokenResult.token,
        expiresIn: tokenResult.expiresIn,
      };
    }
  }

  // Default: client_credentials flow
  const result = await fetchOAuthToken({
    resourceName: gatewayName,
    jwtConfig,
    deployedState,
    targetName: deployTarget,
    credentials: projectSpec.credentials,
    credentialName: options.identityName,
  });

  return {
    url: gatewayUrl,
    authType: 'CUSTOM_JWT',
    token: result.token,
    expiresIn: result.expiresIn,
  };
}
