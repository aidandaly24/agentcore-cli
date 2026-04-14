import { readEnvFile } from '../../../lib/utils/env';
import type { DeployedState } from '../../../schema';
import { getCredentialProvider } from '../../aws';
import {
  computeDefaultCredentialEnvVarName,
  computeManagedOAuthCredentialName,
} from '../../primitives/credential-utils';
import {
  BedrockAgentCoreClient,
  CompleteResourceTokenAuthCommand,
  GetResourceOauth2TokenCommand,
  GetWorkloadAccessTokenForUserIdCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { spawn } from 'node:child_process';
import { type Server, createServer } from 'node:http';
import { platform } from 'node:os';

export interface OAuthTokenResult {
  token: string;
  expiresIn?: number;
}

/**
 * Perform a client_credentials OAuth token fetch for a managed OAuth credential.
 *
 * Shared by gateway and runtime token flows. Resolves the credential from the
 * project spec and .env, performs OIDC discovery, and fetches the token.
 */
export async function fetchOAuthToken(opts: {
  /** Resource name (agent or gateway) used to derive credential name */
  resourceName: string;
  /** JWT authorizer config from the resource spec */
  jwtConfig: {
    discoveryUrl: string;
    allowedClients?: string[];
    allowedScopes?: string[];
  };
  /** Deployed state for client ID resolution */
  deployedState: DeployedState;
  /** Target name within deployed state */
  targetName: string;
  /** Project credentials list */
  credentials: { authorizerType: string; name: string }[];
  /** Optional explicit credential name. When omitted, defaults to `<resourceName>-oauth`. */
  credentialName?: string;
}): Promise<OAuthTokenResult> {
  const { resourceName, jwtConfig, deployedState, targetName, credentials } = opts;

  const credName = opts.credentialName ?? computeManagedOAuthCredentialName(resourceName);

  // Validate credential exists in project spec
  const credential = credentials.find(c => c.authorizerType === 'OAuthCredentialProvider' && c.name === credName);
  if (!credential) {
    const availableOAuth = credentials.filter(c => c.authorizerType === 'OAuthCredentialProvider').map(c => c.name);
    const availableHint =
      availableOAuth.length > 0
        ? ` Available OAuth credentials: ${availableOAuth.join(', ')}. Use --identity-name to specify one.`
        : '';
    throw new Error(
      `No managed OAuth credential found for '${resourceName}'. Expected credential '${credName}'.${availableHint}` +
        (availableOAuth.length === 0 ? ` Re-create the resource with --client-id and --client-secret.` : '')
    );
  }

  // Resolve client_secret from .env.local
  const envVarPrefix = computeDefaultCredentialEnvVarName(credName);
  const secretEnvVar = `${envVarPrefix}_CLIENT_SECRET`;
  const envVars = await readEnvFile();
  const clientSecret = envVars[secretEnvVar];
  if (!clientSecret) {
    throw new Error(
      `Client secret not found in environment variable ${secretEnvVar}. Ensure .env.local file contains this value.`
    );
  }

  // Resolve client_id using 3-tier fallback
  const clientId = resolveClientId(deployedState, targetName, credName, envVarPrefix, envVars, jwtConfig);
  if (!clientId) {
    throw new Error(
      `Could not determine OAuth client ID for '${resourceName}'. Ensure the resource was created with --client-id.`
    );
  }

  // Perform OIDC discovery
  const discoveryUrl = jwtConfig.discoveryUrl;
  const discoveryResponse = await fetch(discoveryUrl);
  if (!discoveryResponse.ok) {
    throw new Error(
      `OIDC discovery failed: ${discoveryResponse.status} ${discoveryResponse.statusText} (${discoveryUrl})`
    );
  }
  const discoveryDoc = (await discoveryResponse.json()) as {
    token_endpoint?: string;
    grant_types_supported?: string[];
  };
  const tokenEndpoint = discoveryDoc.token_endpoint;
  if (!tokenEndpoint) {
    throw new Error(`OIDC discovery response missing 'token_endpoint' field (${discoveryUrl})`);
  }
  if (!tokenEndpoint.startsWith('https://')) {
    throw new Error(`Token endpoint must use HTTPS. Got: ${tokenEndpoint}`);
  }

  // Detect 3-legged OAuth (authorization code flow) — redirect to 3LO flow
  const supportedGrants = discoveryDoc.grant_types_supported;
  if (supportedGrants && !supportedGrants.includes('client_credentials')) {
    throw new Error(
      `This OAuth provider does not support the client_credentials grant type. ` +
        `Supported grants: ${supportedGrants.join(', ')}. ` +
        `For authorization code (3LO) targets, use \`agentcore fetch access --gateway <name> --target <target>\` instead.`
    );
  }

  // Build token request body
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  });

  const scopes = jwtConfig.allowedScopes;
  if (scopes && scopes.length > 0) {
    params.set('scope', scopes.join(' '));
  }

  // Request token
  const tokenResponse = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    if (errorBody.includes('unsupported_grant_type')) {
      throw new Error(
        `Token request failed: the OAuth provider rejected the client_credentials grant type. ` +
          `This resource may require an authorization code flow (3-legged OAuth) which is not yet supported.`
      );
    }
    throw new Error(`Token request failed: ${tokenResponse.status} ${tokenResponse.statusText}. ${errorBody}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  if (!tokenData.access_token) {
    throw new Error('Token response missing access_token field.');
  }

  return {
    token: tokenData.access_token,
    expiresIn: tokenData.expires_in,
  };
}

function resolveClientId(
  deployedState: DeployedState,
  targetName: string,
  credName: string,
  envVarPrefix: string,
  envVars: Record<string, string>,
  jwtConfig: { allowedClients?: string[] }
): string | undefined {
  // Tier 1: deployed-state credentials
  const deployedCred = deployedState.targets[targetName]?.resources?.credentials?.[credName];
  if (deployedCred && 'clientId' in deployedCred) {
    return (deployedCred as Record<string, string>).clientId;
  }

  // Tier 2: env var ${envVarPrefix}_CLIENT_ID
  const clientIdEnvVar = `${envVarPrefix}_CLIENT_ID`;
  const envClientId = envVars[clientIdEnvVar];
  if (envClientId) {
    return envClientId;
  }

  // Tier 3: allowedClients[0] from config (fallback)
  if (jwtConfig.allowedClients && jwtConfig.allowedClients.length > 0) {
    return jwtConfig.allowedClients[0];
  }

  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3LO (Authorization Code / USER_FEDERATION) Token Flow
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;

export interface Fetch3LOTokenOptions {
  workloadName: string;
  credentialProviderName: string;
  scopes: string[];
  resourceOauth2ReturnUrl?: string;
  customParameters?: Record<string, string>;
  region: string;
  /** User identifier for the 3LO session. Defaults to 'cli-user'. */
  userId?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Called when the authorization URL is available. Defaults to printing to console. */
  onAuthUrl?: (url: string) => void;
}

/**
 * Perform a 3LO (Authorization Code) OAuth token fetch using the USER_FEDERATION flow.
 *
 * 1. Gets a workload access token
 * 2. Initiates the auth flow via GetResourceOauth2Token
 * 3. Opens the browser with the authorization URL
 * 4. Polls until the user completes authentication and the token is returned
 */
export async function fetch3LOTargetToken(opts: Fetch3LOTokenOptions): Promise<OAuthTokenResult> {
  const {
    workloadName,
    credentialProviderName,
    scopes,
    resourceOauth2ReturnUrl,
    customParameters,
    region,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    pollTimeoutMs = DEFAULT_POLL_TIMEOUT_MS,
    onAuthUrl = defaultOnAuthUrl,
  } = opts;

  const credentials = getCredentialProvider();
  const client = new BedrockAgentCoreClient({ region, credentials });

  // Step 1: Get user-scoped workload access token.
  // USER_FEDERATION flow requires a token obtained via GetWorkloadAccessTokenForUserId
  // (not GetWorkloadAccessToken, which is for machine-to-machine only).
  const workloadTokenResponse = await client.send(
    new GetWorkloadAccessTokenForUserIdCommand({
      workloadName,
      userId: opts.userId ?? 'cli-user',
    })
  );
  const workloadIdentityToken = workloadTokenResponse.workloadAccessToken;
  if (!workloadIdentityToken) {
    throw new Error('Failed to obtain workload access token.');
  }

  // Step 2: Initiate USER_FEDERATION flow
  const initResponse = await client.send(
    new GetResourceOauth2TokenCommand({
      workloadIdentityToken,
      resourceCredentialProviderName: credentialProviderName,
      scopes,
      oauth2Flow: 'USER_FEDERATION',
      ...(resourceOauth2ReturnUrl && { resourceOauth2ReturnUrl }),
      ...(customParameters && Object.keys(customParameters).length > 0 && { customParameters }),
    })
  );

  // If token is returned immediately (cached session), return it
  if (initResponse.accessToken) {
    return { token: initResponse.accessToken };
  }

  if (!initResponse.authorizationUrl || !initResponse.sessionUri) {
    const missing = [!initResponse.authorizationUrl && 'authorizationUrl', !initResponse.sessionUri && 'sessionUri']
      .filter(Boolean)
      .join(' and ');
    throw new Error(`Expected ${missing} from USER_FEDERATION flow, but not returned.`);
  }

  // Step 3: Start local callback server, present auth URL, wait for redirect
  const authUrl = initResponse.authorizationUrl;
  const sessionUri = initResponse.sessionUri;

  // Parse the return URL to determine port and path for the local server
  const returnUrl = resourceOauth2ReturnUrl ? new URL(resourceOauth2ReturnUrl) : undefined;
  const callbackPort = returnUrl ? parseInt(returnUrl.port || '3000', 10) : 3000;
  const callbackPath = returnUrl?.pathname ?? '/callback';

  // Start a temporary local HTTP server to receive the OAuth redirect
  const callbackSessionId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.close();
      reject(
        new Error(
          `Authorization flow timed out after ${pollTimeoutMs / 1000} seconds. ` +
            'Please try again and complete the browser authentication promptly.'
        )
      );
    }, pollTimeoutMs);

    const server: Server = createServer((req, res) => {
      const reqUrl = new URL(req.url ?? '/', `http://localhost:${callbackPort}`);
      if (reqUrl.pathname === callbackPath) {
        const sid = reqUrl.searchParams.get('session_id');
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><body><h2>Authorization complete</h2>' +
            '<p>You can close this window and return to the terminal.</p></body></html>'
        );
        clearTimeout(timeout);
        server.close();
        if (sid) {
          resolve(sid);
        } else {
          reject(new Error('OAuth callback received but missing session_id parameter.'));
        }
      }
    });

    server.listen(callbackPort, '127.0.0.1', () => {
      onAuthUrl(authUrl);
      tryOpenBrowser(authUrl);
    });

    server.on('error', err => {
      clearTimeout(timeout);
      reject(new Error(`Failed to start local callback server on port ${callbackPort}: ${err.message}`));
    });
  });

  // Step 4: Complete the session binding (URL Session Binding).
  // This tells the service the user who started the flow is the one who completed consent.
  // Without this call, the session stays IN_PROGRESS indefinitely.
  await client.send(
    new CompleteResourceTokenAuthCommand({
      sessionUri: callbackSessionId || sessionUri,
      userIdentifier: { userId: opts.userId ?? 'cli-user' },
    })
  );

  // Step 5: Poll for the access token now that the session is completed
  const MAX_TRANSIENT_RETRIES = 3;
  let consecutiveErrors = 0;
  const startTime = Date.now();
  while (Date.now() - startTime < pollTimeoutMs) {
    try {
      const pollResponse = await client.send(
        new GetResourceOauth2TokenCommand({
          workloadIdentityToken,
          resourceCredentialProviderName: credentialProviderName,
          scopes,
          oauth2Flow: 'USER_FEDERATION',
          sessionUri: callbackSessionId || sessionUri,
        })
      );

      consecutiveErrors = 0;

      if (pollResponse.accessToken) {
        return { token: pollResponse.accessToken };
      }

      if (pollResponse.sessionStatus === 'FAILED') {
        throw new Error('Authorization flow failed. The user may have denied access or the session expired.');
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Authorization flow failed')) {
        throw error;
      }

      const errorName = (error as { name?: string }).name;
      if (errorName === 'UnauthorizedException') {
        throw new Error(
          'Workload access token expired during the authorization flow. ' +
            'Please try again — the token is valid for a limited duration.'
        );
      }
      if (errorName === 'AccessDeniedException') {
        throw new Error(
          'Access denied during the authorization flow. ' +
            'Verify IAM permissions for GetResourceOauth2Token and GetWorkloadAccessToken.'
        );
      }

      consecutiveErrors++;
      if (consecutiveErrors >= MAX_TRANSIENT_RETRIES) {
        throw new Error(
          `Polling failed after ${MAX_TRANSIENT_RETRIES} consecutive errors. ` +
            `Last error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(
    `Authorization flow timed out after ${pollTimeoutMs / 1000} seconds. ` +
      'Please try again and complete the browser authentication promptly.'
  );
}

function defaultOnAuthUrl(url: string): void {
  console.log('\n  Please authenticate in your browser:');
  console.log(`  ${url}\n`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-deploy 3LO Authorization
// ─────────────────────────────────────────────────────────────────────────────

export interface Authorize3LOCredentialsOptions {
  projectName: string;
  gateways: import('../../../schema').AgentCoreGateway[];
  deployedCredentials: Record<string, { credentialProviderArn: string }>;
  region: string;
}

/**
 * Pre-authorize 3LO (AUTHORIZATION_CODE) credentials during deploy.
 *
 * The BedrockAgentCore service validates OAuth credentials during GatewayTarget
 * creation. For AUTHORIZATION_CODE targets, this requires a valid token in the
 * token vault. This function runs the browser-based auth flow for each unique
 * 3LO credential so the token vault is populated before CDK deploy.
 */
export async function authorize3LOCredentials(opts: Authorize3LOCredentialsOptions): Promise<void> {
  const { projectName, gateways, deployedCredentials, region } = opts;

  // Collect unique 3LO credential names across all gateways
  const seen = new Set<string>();
  const targets3LO: { credentialName: string; scopes: string[]; returnUrl?: string }[] = [];

  for (const gateway of gateways) {
    for (const target of gateway.targets) {
      if (
        target.outboundAuth?.grantType === 'AUTHORIZATION_CODE' &&
        target.outboundAuth.credentialName &&
        !seen.has(target.outboundAuth.credentialName)
      ) {
        seen.add(target.outboundAuth.credentialName);
        targets3LO.push({
          credentialName: target.outboundAuth.credentialName,
          scopes: target.outboundAuth.scopes ?? [],
          returnUrl: target.outboundAuth.defaultReturnUrl,
        });
      }
    }
  }

  if (targets3LO.length === 0) return;

  for (const target of targets3LO) {
    const cred = deployedCredentials[target.credentialName];
    if (!cred) {
      throw new Error(
        `Credential "${target.credentialName}" not found in deployed state. ` +
          'Ensure OAuth credentials are set up before 3LO authorization.'
      );
    }

    await fetch3LOTargetToken({
      workloadName: projectName,
      credentialProviderName: target.credentialName,
      scopes: target.scopes,
      resourceOauth2ReturnUrl: target.returnUrl,
      region,
    });
  }
}

function tryOpenBrowser(url: string): void {
  try {
    const os = platform();
    let cmd: string;
    let args: string[];
    if (os === 'darwin') {
      cmd = 'open';
      args = [url];
    } else if (os === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', _err => undefined); // Suppress async spawn errors
    child.unref();
  } catch {
    // Best-effort — user can copy the URL manually
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
