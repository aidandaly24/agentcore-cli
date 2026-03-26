import { z } from 'zod';

// ============================================================================
// Feature Constants (shared across all schemas)
// ============================================================================

export const SDKFrameworkSchema = z.enum(['Strands', 'LangChain_LangGraph', 'GoogleADK', 'OpenAIAgents']);
export type SDKFramework = z.infer<typeof SDKFrameworkSchema>;

export const TargetLanguageSchema = z.enum(['Python', 'TypeScript', 'Other']);
export type TargetLanguage = z.infer<typeof TargetLanguageSchema>;

export const ModelProviderSchema = z.enum(['Bedrock', 'Gemini', 'OpenAI', 'Anthropic']);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

/** Providers that use credentials (Bedrock uses IAM, no credential needed). */
export const CREDENTIAL_PROVIDERS = ['Gemini', 'OpenAI', 'Anthropic'] as const;

/**
 * Case-insensitively match a user-provided value against a Zod enum's options.
 * Returns the canonical (correctly-cased) value, or undefined if no match.
 */
export function matchEnumValue(schema: { options: readonly string[] }, input: string): string | undefined {
  const lower = input.toLowerCase();
  return schema.options.find(v => v.toLowerCase() === lower);
}

/**
 * Default model IDs used for each provider.
 * These are the models generated in agent templates.
 */
export const DEFAULT_MODEL_IDS: Record<ModelProvider, string> = {
  Bedrock: 'us.anthropic.claude-sonnet-4-5-20250514-v1:0',
  Anthropic: 'claude-sonnet-4-5-20250514',
  OpenAI: 'gpt-4.1',
  Gemini: 'gemini-2.5-flash',
};

/**
 * Matrix defining which model providers are supported for each SDK framework.
 * - Most SDKs support all 4 providers (Bedrock, Anthropic, OpenAI, Gemini)
 * - GoogleADK only supports Gemini (uses Google's native API)
 * - OpenAIAgents only supports OpenAI (uses OpenAI's native API)
 */
export const SDK_MODEL_PROVIDER_MATRIX: Record<SDKFramework, readonly ModelProvider[]> = {
  Strands: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
  LangChain_LangGraph: ['Bedrock', 'Anthropic', 'OpenAI', 'Gemini'] as const,
  GoogleADK: ['Gemini'] as const,
  OpenAIAgents: ['OpenAI'] as const,
};

/**
 * Returns the supported model providers for a given SDK framework.
 */
export function getSupportedModelProviders(sdk: SDKFramework): readonly ModelProvider[] {
  return SDK_MODEL_PROVIDER_MATRIX[sdk];
}

/**
 * Checks if a model provider is supported for a given SDK framework.
 */
export function isModelProviderSupported(sdk: SDKFramework, provider: ModelProvider): boolean {
  return SDK_MODEL_PROVIDER_MATRIX[sdk].includes(provider);
}

// ============================================================================
// Reserved Project Names (Python package conflicts)
// ============================================================================

/**
 * Project/agent names that would conflict with Python package names when
 * creating a virtual environment. If the project directory name matches
 * a dependency name, uv/pip will fail to resolve dependencies correctly.
 *
 * This list includes all dependencies used across SDK templates, normalized
 * to valid project name format (lowercase, underscores replaced with nothing
 * since project names are alphanumeric only).
 */
export const RESERVED_PROJECT_NAMES: readonly string[] = [
  // Core SDK packages
  'anthropic',
  'autogen',
  'autogenagentchat',
  'autogenext',
  'bedrock',
  'bedrockagentcore',
  'googleadk',
  'googlegenerativeai',
  'langchain',
  'langchainanthropic',
  'langchainaws',
  'langchaingooglegenai',
  'langchainmcpadapters',
  'langchainopenai',
  'langgraph',
  'mcp',
  'openai',
  'openaiagents',
  'strands',
  'strandsagents',
  'strandsagentstools',
  // Common utilities
  'httpx',
  'pytest',
  'pytestasyncio',
  'pythondotenv',
  // Build tools
  'hatchling',
  'setuptools',
  'wheel',
  // AWS packages
  'awsopentelemetrydistro',
  'boto3',
  'botocore',
  // Common Python stdlib/package names that could cause issues
  'test',
  'tests',
  'src',
  'lib',
  'dist',
  'build',
  'env',
  'venv',
  'site',
  'pip',
  'uv',
] as const;

/**
 * Check if a project name is reserved (case-insensitive).
 */
export function isReservedProjectName(name: string): boolean {
  return RESERVED_PROJECT_NAMES.includes(name.toLowerCase());
}

// ============================================================================
// Infrastructure Constants (shared between agent-env and mcp schemas)
// ============================================================================

export const PythonRuntimeSchema = z.enum(['PYTHON_3_10', 'PYTHON_3_11', 'PYTHON_3_12', 'PYTHON_3_13']);
export type PythonRuntime = z.infer<typeof PythonRuntimeSchema>;

export const NodeRuntimeSchema = z.enum(['NODE_18', 'NODE_20', 'NODE_22']);
export type NodeRuntime = z.infer<typeof NodeRuntimeSchema>;

/** Combined runtime version schema supporting both Python and Node/TypeScript runtimes */
export const RuntimeVersionSchema = z.union([PythonRuntimeSchema, NodeRuntimeSchema]);
export type RuntimeVersion = z.infer<typeof RuntimeVersionSchema>;

export const NetworkModeSchema = z.enum(['PUBLIC', 'VPC']);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;

// ============================================================================
// Protocol Mode
// ============================================================================

export const ProtocolModeSchema = z.enum(['HTTP', 'MCP', 'A2A']);
export type ProtocolMode = z.infer<typeof ProtocolModeSchema>;

/**
 * Matrix defining which SDK frameworks are supported for each protocol mode.
 * MCP is a standalone tool server with no framework.
 */
export const PROTOCOL_FRAMEWORK_MATRIX: Record<ProtocolMode, readonly SDKFramework[]> = {
  HTTP: ['Strands', 'LangChain_LangGraph', 'GoogleADK', 'OpenAIAgents'] as const,
  MCP: [] as const,
  A2A: ['Strands', 'GoogleADK', 'LangChain_LangGraph'] as const,
};

/**
 * Returns the supported SDK frameworks for a given protocol mode.
 */
export function getSupportedFrameworksForProtocol(protocol: ProtocolMode): readonly SDKFramework[] {
  return PROTOCOL_FRAMEWORK_MATRIX[protocol];
}

/**
 * Checks if a framework is supported for a given protocol mode.
 */
export function isFrameworkSupportedForProtocol(protocol: ProtocolMode, framework: SDKFramework): boolean {
  return PROTOCOL_FRAMEWORK_MATRIX[protocol].includes(framework);
}

// ============================================================================
// OAuth2 Vendor Provider Categories
// ============================================================================

/**
 * Named providers have a dedicated `xxxOauth2ProviderConfig` key in the SDK.
 * They only require clientId + clientSecret (no discoveryUrl).
 * Microsoft additionally supports an optional tenantId.
 */
export const NAMED_PROVIDER_CONFIG_KEYS: Record<string, string> = {
  GoogleOauth2: 'googleOauth2ProviderConfig',
  GithubOauth2: 'githubOauth2ProviderConfig',
  SlackOauth2: 'slackOauth2ProviderConfig',
  SalesforceOauth2: 'salesforceOauth2ProviderConfig',
  MicrosoftOauth2: 'microsoftOauth2ProviderConfig',
  AtlassianOauth2: 'atlassianOauth2ProviderConfig',
  LinkedinOauth2: 'linkedinOauth2ProviderConfig',
};

/**
 * Included providers use a shared `includedOauth2ProviderConfig` key.
 * They require clientId + clientSecret, with optional issuer,
 * authorizationEndpoint, and tokenEndpoint for tenant-specific overrides.
 */
export const INCLUDED_PROVIDERS = new Set([
  'Auth0Oauth2',
  'CognitoOauth2',
  'CyberArkOauth2',
  'DropboxOauth2',
  'FacebookOauth2',
  'FusionAuthOauth2',
  'HubspotOauth2',
  'NotionOauth2',
  'OktaOauth2',
  'OneLoginOauth2',
  'PingOneOauth2',
  'RedditOauth2',
  'SpotifyOauth2',
  'TwitchOauth2',
  'XOauth2',
  'YandexOauth2',
  'ZoomOauth2',
]);

/**
 * Check if a vendor uses a named provider config (dedicated SDK config key).
 */
export function isNamedProvider(vendor: string): boolean {
  return vendor in NAMED_PROVIDER_CONFIG_KEYS;
}

/**
 * Check if a vendor uses the included provider config (shared SDK config key).
 */
export function isIncludedProvider(vendor: string): boolean {
  return INCLUDED_PROVIDERS.has(vendor);
}

/**
 * Check if a vendor requires a discoveryUrl. Only Custom (or unrecognized) vendors do.
 */
export function vendorRequiresDiscoveryUrl(vendor: string): boolean {
  return !isNamedProvider(vendor) && !isIncludedProvider(vendor);
}
