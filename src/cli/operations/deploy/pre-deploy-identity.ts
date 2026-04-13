import { SecureCredentials, readEnvFile } from '../../../lib';
import type { AgentCoreGateway, AgentCoreProjectSpec, Credential } from '../../../schema';
import { getCredentialProvider } from '../../aws';
import { isNoCredentialsError } from '../../errors';
import { getAwsLoginGuidance } from '../../external-requirements/checks';
import { computeDefaultCredentialEnvVarName } from '../../primitives/credential-utils';
import {
  apiKeyProviderExists,
  createApiKeyProvider,
  createOAuth2Provider,
  oAuth2ProviderExists,
  setTokenVaultKmsKey,
  updateApiKeyProvider,
  updateOAuth2Provider,
} from '../identity';
import {
  BedrockAgentCoreControlClient,
  CreateWorkloadIdentityCommand,
  GetTokenVaultCommand,
  GetWorkloadIdentityCommand,
  UpdateWorkloadIdentityCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApiKeyProviderSetupResult {
  providerName: string;
  status: 'created' | 'updated' | 'exists' | 'skipped' | 'error';
  credentialProviderArn?: string;
  error?: string;
}

export interface PreDeployIdentityResult {
  results: ApiKeyProviderSetupResult[];
  hasErrors: boolean;
  kmsKeyArn?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Function
// ─────────────────────────────────────────────────────────────────────────────

export interface SetupApiKeyProvidersOptions {
  projectSpec: AgentCoreProjectSpec;
  configBaseDir: string;
  region: string;
  /** Runtime credentials that override .env.local values (not persisted to disk) */
  runtimeCredentials?: SecureCredentials;
  /** Enable KMS encryption for the token vault (creates key if needed) */
  enableKmsEncryption?: boolean;
}

/**
 * Set up API key credential providers for all credentials in the project.
 * Reads API keys from agentcore/.env.local and creates providers in AgentCore Identity.
 * Runtime credentials (if provided) take precedence over .env.local values.
 */
export async function setupApiKeyProviders(options: SetupApiKeyProvidersOptions): Promise<PreDeployIdentityResult> {
  const { projectSpec, configBaseDir, region, runtimeCredentials, enableKmsEncryption } = options;
  const results: ApiKeyProviderSetupResult[] = [];
  const credentials = getCredentialProvider();

  const envVars = await readEnvFile(configBaseDir);
  // Wrap env vars in SecureCredentials and merge with runtime credentials
  const envCredentials = SecureCredentials.fromEnvVars(envVars);
  const allCredentials = runtimeCredentials ? envCredentials.merge(runtimeCredentials) : envCredentials;

  const client = new BedrockAgentCoreControlClient({ region, credentials });

  // Configure KMS encryption for token vault if enabled
  let kmsKeyArn: string | undefined;
  if (enableKmsEncryption) {
    const kmsResult = await setupTokenVaultKms(region, credentials, projectSpec);
    if (!kmsResult.success) {
      return {
        results: [
          {
            providerName: 'TokenVault',
            status: 'error',
            error: `Failed to configure KMS: ${kmsResult.error}`,
          },
        ],
        hasErrors: true,
      };
    }
    kmsKeyArn = kmsResult.keyArn;
  }

  // Set up each credential in the project
  for (const credential of projectSpec.credentials) {
    if (credential.authorizerType === 'ApiKeyCredentialProvider') {
      const result = await setupApiKeyCredentialProvider(client, credential, allCredentials);
      results.push(result);
    }
  }

  return {
    results,
    hasErrors: results.some(r => r.status === 'error'),
    kmsKeyArn,
  };
}

async function setupTokenVaultKms(
  region: string,
  credentials: ReturnType<typeof getCredentialProvider>,
  projectSpec: AgentCoreProjectSpec
): Promise<{ success: boolean; keyArn?: string; error?: string }> {
  try {
    const controlClient = new BedrockAgentCoreControlClient({ region, credentials });

    // Check if the token vault already has a customer-managed key
    try {
      const vaultResponse = await controlClient.send(new GetTokenVaultCommand({}));
      if (
        vaultResponse.kmsConfiguration?.keyType === 'CustomerManagedKey' &&
        vaultResponse.kmsConfiguration.kmsKeyArn
      ) {
        return { success: true, keyArn: vaultResponse.kmsConfiguration.kmsKeyArn };
      }
    } catch {
      // Vault may not exist yet or access denied — fall through to create key
    }

    // No CMK configured — create a new KMS key and set it on the vault
    const kmsClient = new KMSClient({ region, credentials });
    const response = await kmsClient.send(
      new CreateKeyCommand({
        Description: `AgentCore Identity encryption key for ${projectSpec.name}`,
        Tags: [{ TagKey: 'agentcore:project', TagValue: projectSpec.name }],
      })
    );
    const keyArn = response.KeyMetadata?.Arn;
    if (!keyArn) {
      return { success: false, error: 'Failed to create KMS key' };
    }

    const result = await setTokenVaultKmsKey(controlClient, keyArn);
    if (!result.success) {
      return { success: false, error: result.error };
    }

    return { success: true, keyArn };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function setupApiKeyCredentialProvider(
  client: BedrockAgentCoreControlClient,
  credential: Credential,
  credentials: SecureCredentials
): Promise<ApiKeyProviderSetupResult> {
  const envVarName = computeDefaultCredentialEnvVarName(credential.name);
  const apiKey = credentials.get(envVarName);

  if (!apiKey) {
    return {
      providerName: credential.name,
      status: 'skipped',
      error: `No ${envVarName} found in agentcore/.env.local`,
    };
  }

  try {
    const exists = await apiKeyProviderExists(client, credential.name);
    if (exists) {
      // Always update to ensure provider has current credentials
      const updateResult = await updateApiKeyProvider(client, credential.name, apiKey);
      return {
        providerName: credential.name,
        status: updateResult.success ? 'updated' : 'error',
        credentialProviderArn: updateResult.credentialProviderArn,
        error: updateResult.error,
      };
    }

    const createResult = await createApiKeyProvider(client, credential.name, apiKey);
    return {
      providerName: credential.name,
      status: createResult.success ? 'created' : 'error',
      credentialProviderArn: createResult.credentialProviderArn,
      error: createResult.error,
    };
  } catch (error) {
    // Provide clearer error message for AWS credentials issues
    let errorMessage: string;
    if (isNoCredentialsError(error)) {
      errorMessage = `AWS credentials not found. ${await getAwsLoginGuidance()}`;
    } else {
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    return {
      providerName: credential.name,
      status: 'error',
      error: errorMessage,
    };
  }
}

/**
 * Check if the project has any API key credentials that need setup.
 */
export function hasIdentityApiProviders(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.credentials.some(c => c.authorizerType === 'ApiKeyCredentialProvider');
}

export interface MissingCredential {
  providerName: string;
  envVarName: string;
}

/**
 * Get list of credentials that are missing API keys in .env.local.
 */
export async function getMissingCredentials(
  projectSpec: AgentCoreProjectSpec,
  configBaseDir: string
): Promise<MissingCredential[]> {
  const envVars = await readEnvFile(configBaseDir);
  const missing: MissingCredential[] = [];

  for (const credential of projectSpec.credentials) {
    if (credential.authorizerType === 'ApiKeyCredentialProvider') {
      const envVarName = computeDefaultCredentialEnvVarName(credential.name);
      if (!envVars[envVarName]) {
        missing.push({
          providerName: credential.name,
          envVarName,
        });
      }
    }
  }

  return missing;
}

/**
 * Get list of all credentials in the project that need env vars (for manual entry prompt and runtime credential reading).
 */
export function getAllCredentials(projectSpec: AgentCoreProjectSpec): MissingCredential[] {
  const credentials: MissingCredential[] = [];

  for (const credential of projectSpec.credentials) {
    if (credential.authorizerType === 'ApiKeyCredentialProvider') {
      credentials.push({
        providerName: credential.name,
        envVarName: computeDefaultCredentialEnvVarName(credential.name),
      });
    } else if (credential.authorizerType === 'OAuthCredentialProvider') {
      const nameKey = credential.name.toUpperCase().replace(/-/g, '_');
      credentials.push(
        { providerName: credential.name, envVarName: `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_ID` },
        { providerName: credential.name, envVarName: `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_SECRET` }
      );
    }
  }

  return credentials;
}

// ─────────────────────────────────────────────────────────────────────────────
// OAuth2 Credential Provider Setup
// ─────────────────────────────────────────────────────────────────────────────

export interface OAuth2ProviderSetupResult {
  providerName: string;
  status: 'created' | 'updated' | 'skipped' | 'error';
  error?: string;
  credentialProviderArn?: string;
  clientSecretArn?: string;
  callbackUrl?: string;
}

export interface SetupOAuth2ProvidersOptions {
  projectSpec: AgentCoreProjectSpec;
  configBaseDir: string;
  region: string;
  runtimeCredentials?: SecureCredentials;
}

export interface PreDeployOAuth2Result {
  results: OAuth2ProviderSetupResult[];
  hasErrors: boolean;
}

/**
 * Set up OAuth2 credential providers for all OAuth credentials in the project.
 * Reads client credentials from agentcore/.env.local and creates providers in AgentCore Identity.
 */
export async function setupOAuth2Providers(options: SetupOAuth2ProvidersOptions): Promise<PreDeployOAuth2Result> {
  const { projectSpec, configBaseDir, region, runtimeCredentials } = options;
  const results: OAuth2ProviderSetupResult[] = [];
  const credentials = getCredentialProvider();

  const envVars = await readEnvFile(configBaseDir);
  const envCredentials = SecureCredentials.fromEnvVars(envVars);
  const allCredentials = runtimeCredentials ? envCredentials.merge(runtimeCredentials) : envCredentials;

  const client = new BedrockAgentCoreControlClient({ region, credentials });

  for (const credential of projectSpec.credentials) {
    if (credential.authorizerType === 'OAuthCredentialProvider') {
      const result = await setupSingleOAuth2Provider(client, credential, allCredentials);
      results.push(result);
    }
  }

  return {
    results,
    hasErrors: results.some(r => r.status === 'error'),
  };
}

/**
 * Check if the project has any OAuth credentials that need setup.
 */
export function hasIdentityOAuthProviders(projectSpec: AgentCoreProjectSpec): boolean {
  return projectSpec.credentials.some(c => c.authorizerType === 'OAuthCredentialProvider');
}

async function setupSingleOAuth2Provider(
  client: BedrockAgentCoreControlClient,
  credential: Credential,
  credentials: SecureCredentials
): Promise<OAuth2ProviderSetupResult> {
  if (credential.authorizerType !== 'OAuthCredentialProvider') {
    return { providerName: credential.name, status: 'error', error: 'Invalid credential type' };
  }

  const nameKey = credential.name.toUpperCase().replace(/-/g, '_');
  const clientIdEnvVar = `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_ID`;
  const clientSecretEnvVar = `AGENTCORE_CREDENTIAL_${nameKey}_CLIENT_SECRET`;

  const clientId = credentials.get(clientIdEnvVar);
  const clientSecret = credentials.get(clientSecretEnvVar);

  if (!clientId || !clientSecret) {
    return {
      providerName: credential.name,
      status: 'skipped',
      error: `Missing ${clientIdEnvVar} or ${clientSecretEnvVar} in agentcore/.env.local`,
    };
  }

  // Imported OAuth providers may not have a discoveryUrl (provider already exists in Identity service).
  // Skip create/update since we can't build a valid config without it.
  if (!credential.discoveryUrl) {
    return {
      providerName: credential.name,
      status: 'skipped',
      error: `No discoveryUrl configured for "${credential.name}". Provider already exists in Identity service — credentials in .env.local will be ignored.`,
    };
  }

  const params = {
    name: credential.name,
    vendor: credential.vendor,
    discoveryUrl: credential.discoveryUrl,
    clientId,
    clientSecret,
    tenantId: credential.tenantId,
    issuer: credential.issuer,
    authorizationEndpoint: credential.authorizationEndpoint,
    tokenEndpoint: credential.tokenEndpoint,
  };

  try {
    const exists = await oAuth2ProviderExists(client, credential.name);

    if (exists) {
      const updateResult = await updateOAuth2Provider(client, params);
      return {
        providerName: credential.name,
        status: updateResult.success ? 'updated' : 'error',
        error: updateResult.error,
        credentialProviderArn: updateResult.result?.credentialProviderArn,
        clientSecretArn: updateResult.result?.clientSecretArn,
        callbackUrl: updateResult.result?.callbackUrl,
      };
    }

    const createResult = await createOAuth2Provider(client, params);
    return {
      providerName: credential.name,
      status: createResult.success ? 'created' : 'error',
      error: createResult.error,
      credentialProviderArn: createResult.result?.credentialProviderArn,
      clientSecretArn: createResult.result?.clientSecretArn,
      callbackUrl: createResult.result?.callbackUrl,
    };
  } catch (error) {
    let errorMessage: string;
    if (isNoCredentialsError(error)) {
      errorMessage = 'AWS credentials not found. Run `aws sso login` or set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY.';
    } else {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    return { providerName: credential.name, status: 'error', error: errorMessage };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Workload Identity Setup (3LO / Authorization Code)
// ─────────────────────────────────────────────────────────────────────────────

export type WorkloadIdentitySetupResult =
  | { status: 'created'; workloadIdentityArn: string }
  | { status: 'updated'; workloadIdentityArn: string }
  | { status: 'skipped' }
  | { status: 'error'; error: string };

export interface SetupWorkloadIdentityOptions {
  projectName: string;
  gateways: AgentCoreGateway[];
  region: string;
}

/**
 * Collect all defaultReturnUrl values from 3LO (AUTHORIZATION_CODE) targets across all gateways.
 */
export function collect3LOReturnUrls(gateways: AgentCoreGateway[]): string[] {
  const urls: string[] = [];
  for (const gateway of gateways) {
    for (const target of gateway.targets) {
      if (target.outboundAuth?.grantType === 'AUTHORIZATION_CODE' && target.outboundAuth.defaultReturnUrl) {
        urls.push(target.outboundAuth.defaultReturnUrl);
      }
    }
  }
  return [...new Set(urls)];
}

/**
 * Check if any gateway targets use 3LO (AUTHORIZATION_CODE) grant type.
 */
export function has3LOTargets(gateways: AgentCoreGateway[]): boolean {
  return gateways.some(g => g.targets.some(t => t.outboundAuth?.grantType === 'AUTHORIZATION_CODE'));
}

/**
 * Set up a workload identity for 3LO targets.
 * Creates or updates the workload identity with allowedResourceOauth2ReturnUrls
 * collected from all gateway targets using AUTHORIZATION_CODE grant type.
 */
export async function setupWorkloadIdentity(
  options: SetupWorkloadIdentityOptions
): Promise<WorkloadIdentitySetupResult> {
  const { projectName, gateways, region } = options;

  const returnUrls = collect3LOReturnUrls(gateways);
  if (returnUrls.length === 0) {
    return { status: 'skipped' };
  }

  const credentials = getCredentialProvider();
  const client = new BedrockAgentCoreControlClient({ region, credentials });

  try {
    // Check if workload identity already exists
    let exists = false;
    try {
      await client.send(new GetWorkloadIdentityCommand({ name: projectName }));
      exists = true;
    } catch (error: unknown) {
      const errorName = error instanceof Error ? error.name : undefined;
      if (errorName === 'AccessDeniedException') {
        return { status: 'error', error: 'Access denied when checking workload identity. Verify IAM permissions.' };
      }
      if (errorName !== 'ResourceNotFoundException') {
        throw error;
      }
    }

    if (exists) {
      const response = await client.send(
        new UpdateWorkloadIdentityCommand({
          name: projectName,
          allowedResourceOauth2ReturnUrls: returnUrls,
        })
      );
      if (!response.workloadIdentityArn) {
        return { status: 'error', error: 'UpdateWorkloadIdentity response missing workloadIdentityArn' };
      }
      return {
        status: 'updated',
        workloadIdentityArn: response.workloadIdentityArn,
      };
    }

    const response = await client.send(
      new CreateWorkloadIdentityCommand({
        name: projectName,
        allowedResourceOauth2ReturnUrls: returnUrls,
      })
    );
    if (!response.workloadIdentityArn) {
      return { status: 'error', error: 'CreateWorkloadIdentity response missing workloadIdentityArn' };
    }
    return {
      status: 'created',
      workloadIdentityArn: response.workloadIdentityArn,
    };
  } catch (error) {
    let errorMessage: string;
    if (isNoCredentialsError(error)) {
      errorMessage = `AWS credentials not found. ${await getAwsLoginGuidance()}`;
    } else {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    return { status: 'error', error: errorMessage };
  }
}
