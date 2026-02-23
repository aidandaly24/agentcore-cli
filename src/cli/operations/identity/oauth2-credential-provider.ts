/**
 * Imperative AWS SDK operations for OAuth2 credential providers.
 *
 * This file exists because AgentCore Identity resources are not yet modeled
 * as CDK constructs. These operations run as a pre-deploy step outside the
 * main CDK synthesis/deploy path.
 */
import {
  BedrockAgentCoreControlClient,
  CreateOauth2CredentialProviderCommand,
  type CredentialProviderVendorType,
  GetOauth2CredentialProviderCommand,
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
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Extract credential provider ARN from API response, handling field name inconsistency.
 * The API may return the ARN as `credentialProviderArn` or `oAuth2CredentialProviderArn`.
 */
/**
 * Extract credential provider ARN from API response, handling field name inconsistency.
 * The API may return the ARN as `credentialProviderArn` or `oAuth2CredentialProviderArn`.
 *
 * Note: This casts to Record<string, unknown> to handle the inconsistency. The typed SDK
 * response only declares `credentialProviderArn`, but older API versions may return
 * `oAuth2CredentialProviderArn`. Remove the fallback once the API stabilizes.
 */
function extractArn(response: Record<string, unknown>): string | undefined {
  return (
    (response.credentialProviderArn as string | undefined) ??
    (response.oAuth2CredentialProviderArn as string | undefined)
  );
}

/**
 * Extract result fields from an OAuth2 API response.
 */
function extractResult(response: Record<string, unknown>): OAuth2ProviderResult | undefined {
  const credentialProviderArn = extractArn(response);
  if (!credentialProviderArn) return undefined;

  const clientSecretArnRaw = response.clientSecretArn;
  const clientSecretArn =
    clientSecretArnRaw && typeof clientSecretArnRaw === 'object' && 'secretArn' in clientSecretArnRaw
      ? (clientSecretArnRaw as { secretArn?: string }).secretArn
      : undefined;

  return {
    credentialProviderArn,
    clientSecretArn,
    callbackUrl: typeof response.callbackUrl === 'string' ? response.callbackUrl : undefined,
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
 * Always uses customOauth2ProviderConfig regardless of vendor — the vendor field
 * controls server-side behavior (token endpoints, scopes), but the config shape
 * is the same for all vendors in the current API.
 */
function buildOAuth2Config(params: OAuth2ProviderParams) {
  return {
    name: params.name,
    credentialProviderVendor: params.vendor as CredentialProviderVendorType,
    oauth2ProviderConfigInput: {
      customOauth2ProviderConfig: {
        clientId: params.clientId,
        clientSecret: params.clientSecret,
        oauthDiscovery: {
          discoveryUrl: params.discoveryUrl,
        },
      },
    },
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
    const result = extractResult(response as unknown as Record<string, unknown>);
    if (!result) {
      return { success: false, error: 'No credential provider ARN in response' };
    }
    return { success: true, result };
  } catch (error) {
    const errorName = (error as { name?: string }).name;
    if (errorName === 'ConflictException' || errorName === 'ResourceAlreadyExistsException') {
      // Unlike API key providers, OAuth needs the ARN back for deployed-state.json.
      // This only triggers in a race condition (another process created between exists-check
      // and create). The caller already routes to update for known-existing providers, so
      // falling back to GET here is safe — the next deploy will update with fresh credentials.
      return getOAuth2Provider(client, params.name);
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
    const result = extractResult(response as unknown as Record<string, unknown>);
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
    const result = extractResult(response as unknown as Record<string, unknown>);
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
