import type { CredentialType } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Identity Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type AddIdentityStep =
  | 'type'
  | 'name'
  | 'vendor'
  | 'apiKey'
  | 'discoveryUrl'
  | 'tenantId'
  | 'issuer'
  | 'authorizationEndpoint'
  | 'tokenEndpoint'
  | 'clientId'
  | 'clientSecret'
  | 'scopes'
  | 'confirm';

export interface AddIdentityConfig {
  identityType: CredentialType;
  name: string;
  /** API Key (when type is ApiKeyCredentialProvider) */
  apiKey: string;
  /** OAuth fields (when type is OAuthCredentialProvider) */
  vendor?: string;
  discoveryUrl?: string;
  tenantId?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string;
}

export const IDENTITY_STEP_LABELS: Record<AddIdentityStep, string> = {
  type: 'Type',
  name: 'Name',
  vendor: 'Provider',
  apiKey: 'API Key',
  discoveryUrl: 'Discovery URL',
  tenantId: 'Tenant ID',
  issuer: 'Issuer',
  authorizationEndpoint: 'Authorization Endpoint',
  tokenEndpoint: 'Token Endpoint',
  clientId: 'Client ID',
  clientSecret: 'Client Secret',
  scopes: 'Scopes',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const IDENTITY_TYPE_OPTIONS = [
  { id: 'ApiKeyCredentialProvider' as const, title: 'API Key', description: 'Store and manage API key credentials' },
  { id: 'OAuthCredentialProvider' as const, title: 'OAuth', description: 'OAuth 2.0 client credentials' },
] as const;

export const VENDOR_OPTIONS = [
  // Popular
  { id: 'GoogleOauth2', title: 'Google', description: 'Google APIs (Drive, Calendar, Gmail, etc.)' },
  { id: 'GithubOauth2', title: 'GitHub', description: 'GitHub API' },
  { id: 'SlackOauth2', title: 'Slack', description: 'Slack API' },
  { id: 'MicrosoftOauth2', title: 'Microsoft (Entra ID)', description: 'Microsoft Graph, Azure, Office 365' },
  // Enterprise IdPs
  { id: 'OktaOauth2', title: 'Okta', description: 'Okta identity platform' },
  { id: 'Auth0Oauth2', title: 'Auth0', description: 'Auth0 identity platform' },
  { id: 'CognitoOauth2', title: 'Amazon Cognito', description: 'AWS Cognito user pools' },
  // SaaS
  { id: 'SalesforceOauth2', title: 'Salesforce', description: 'Salesforce API' },
  { id: 'AtlassianOauth2', title: 'Atlassian', description: 'Jira, Confluence, Bitbucket' },
  { id: 'LinkedinOauth2', title: 'LinkedIn', description: 'LinkedIn API' },
  // Other included
  { id: 'HubspotOauth2', title: 'HubSpot', description: 'HubSpot CRM API' },
  { id: 'DropboxOauth2', title: 'Dropbox', description: 'Dropbox API' },
  { id: 'NotionOauth2', title: 'Notion', description: 'Notion API' },
  { id: 'ZoomOauth2', title: 'Zoom', description: 'Zoom API' },
  { id: 'SpotifyOauth2', title: 'Spotify', description: 'Spotify API' },
  { id: 'CyberArkOauth2', title: 'CyberArk', description: 'CyberArk identity security' },
  { id: 'FacebookOauth2', title: 'Facebook', description: 'Facebook / Meta API' },
  { id: 'FusionAuthOauth2', title: 'FusionAuth', description: 'FusionAuth identity platform' },
  { id: 'OneLoginOauth2', title: 'OneLogin', description: 'OneLogin identity platform' },
  { id: 'PingOneOauth2', title: 'PingOne', description: 'PingOne identity platform' },
  { id: 'RedditOauth2', title: 'Reddit', description: 'Reddit API' },
  { id: 'TwitchOauth2', title: 'Twitch', description: 'Twitch API' },
  { id: 'XOauth2', title: 'X (Twitter)', description: 'X / Twitter API' },
  { id: 'YandexOauth2', title: 'Yandex', description: 'Yandex API' },
  // Custom (always last)
  { id: 'CustomOauth2', title: 'Custom', description: 'Custom OAuth2 provider (requires discovery URL)' },
] as const;
