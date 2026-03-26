/**
 * Imperative AWS SDK operations for OAuth2 credential providers.
 *
 * This file exists because AgentCore Identity resources are not yet modeled
 * as CDK constructs. These operations run as a pre-deploy step outside the
 * main CDK synthesis/deploy path.
 */
import { INCLUDED_PROVIDERS, NAMED_PROVIDER_CONFIG_KEYS } from '../../../schema';
import {
  BedrockAgentCoreControlClient,
  CreateOauth2CredentialProviderCommand,
  type CredentialProviderVendorType,
  GetOauth2CredentialProviderCommand,
  type Oauth2ProviderConfigInput,
  ResourceNotFoundException,
  UpdateOauth2CredentialProviderCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

export interface OAuth2ProviderResult {
  credentialProviderArn: string;
  clientSecretArn?: string;
  callbackUrl?: string;
}

export interface OAuth2ProviderParams {
  name: string;
  vendor: string;
  discoveryUrl?: string;
  clientId: string;
  clientSecret: string;
  /** Microsoft Entra ID tenant ID (MicrosoftOauth2 only) */
  tenantId?: string;
  /** Token issuer for Included providers (e.g. Okta, Auth0) */
  issuer?: string;
  /** Authorization endpoint for Included providers */
  authorizationEndpoint?: string;
  /** Token endpoint for Included providers */
  tokenEndpoint?: string;
}

/**
 * Extract result fields from an OAuth2 API response.
 * All Create/Get/Update responses share the same shape.
 */
function extractResult(response: {
  credentialProviderArn?: string;
  clientSecretArn?: { secretArn?: string };
  callbackUrl?: string;
}): OAuth2ProviderResult | undefined {
  if (!response.credentialProviderArn) return undefined;
  return {
    credentialProviderArn: response.credentialProviderArn,
    clientSecretArn: response.clientSecretArn?.secretArn,
    callbackUrl: response.callbackUrl,
  };
}

/**
 * Check if an OAuth2 credential provider exists.
 */
export async function oAuth2ProviderExists(
  client: BedrockAgentCoreControlClient,
  providerName: string
): Promise<boolean> {
  try {
    await client.send(new GetOauth2CredentialProviderCommand({ name: providerName }));
    return true;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return false;
    }
    throw error;
  }
}

/**
 * Build the OAuth2 provider config for Create/Update commands.
 * Routes to the correct SDK config key based on vendor type:
 * - Named providers (Google, GitHub, Slack, etc.) → dedicated config key
 * - Included providers (Okta, Auth0, Cognito, etc.) → includedOauth2ProviderConfig
 * - Custom/unknown → customOauth2ProviderConfig (requires discoveryUrl)
 */
function buildOAuth2Config(params: OAuth2ProviderParams) {
  let configInput: Oauth2ProviderConfigInput;

  // Named provider — dedicated config key (e.g. googleOauth2ProviderConfig)
  const namedConfigKey = NAMED_PROVIDER_CONFIG_KEYS[params.vendor];
  if (namedConfigKey) {
    const namedConfig: Record<string, unknown> = {
      clientId: params.clientId,
      clientSecret: params.clientSecret,
    };
    if (params.vendor === 'MicrosoftOauth2' && params.tenantId) {
      namedConfig.tenantId = params.tenantId;
    }
    // Computed key requires double assertion — routing logic guarantees correctness
    configInput = { [namedConfigKey]: namedConfig } as unknown as Oauth2ProviderConfigInput;
  } else if (INCLUDED_PROVIDERS.has(params.vendor)) {
    // Included provider — shared includedOauth2ProviderConfig
    const includedConfig: Record<string, unknown> = {
      clientId: params.clientId,
      clientSecret: params.clientSecret,
    };
    if (params.issuer) includedConfig.issuer = params.issuer;
    if (params.authorizationEndpoint) includedConfig.authorizationEndpoint = params.authorizationEndpoint;
    if (params.tokenEndpoint) includedConfig.tokenEndpoint = params.tokenEndpoint;
    configInput = { includedOauth2ProviderConfig: includedConfig } as unknown as Oauth2ProviderConfigInput;
  } else {
    // Custom provider — requires discoveryUrl
    configInput = {
      customOauth2ProviderConfig: {
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        oauthDiscovery: { discoveryUrl: params.discoveryUrl! },
      },
    };
  }

  return {
    name: params.name,
    credentialProviderVendor: params.vendor as CredentialProviderVendorType,
    oauth2ProviderConfigInput: configInput,
  };
}

/**
 * Create an OAuth2 credential provider.
 * On conflict (already exists), falls back to GET to retrieve the ARN.
 */
export async function createOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  params: OAuth2ProviderParams
): Promise<{ success: boolean; result?: OAuth2ProviderResult; error?: string }> {
  try {
    const response = await client.send(new CreateOauth2CredentialProviderCommand(buildOAuth2Config(params)));
    let result = extractResult(response);
    if (!result) {
      // Create response may not include credentialProviderArn — fetch it
      const getResult = await getOAuth2Provider(client, params.name);
      result = getResult.result;
    }
    if (!result) {
      return { success: false, error: 'No credential provider ARN in response' };
    }
    return { success: true, result };
  } catch (error) {
    const errorName = (error as { name?: string }).name;
    if (errorName === 'ConflictException' || errorName === 'ResourceAlreadyExistsException') {
      // Race condition: another process created the provider between our exists-check and
      // create call. Fall back to update so the user's credentials are always applied.
      return updateOAuth2Provider(client, params);
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get an existing OAuth2 credential provider.
 */
export async function getOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  name: string
): Promise<{ success: boolean; result?: OAuth2ProviderResult; error?: string }> {
  try {
    const response = await client.send(new GetOauth2CredentialProviderCommand({ name }));
    const result = extractResult(response);
    if (!result) {
      return { success: false, error: 'No credential provider ARN in response' };
    }
    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Update an existing OAuth2 credential provider.
 */
export async function updateOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  params: OAuth2ProviderParams
): Promise<{ success: boolean; result?: OAuth2ProviderResult; error?: string }> {
  try {
    const response = await client.send(new UpdateOauth2CredentialProviderCommand(buildOAuth2Config(params)));
    let result = extractResult(response);
    if (!result) {
      const getResult = await getOAuth2Provider(client, params.name);
      result = getResult.result;
    }
    if (!result) {
      return { success: false, error: 'No credential provider ARN in response' };
    }
    return { success: true, result };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
