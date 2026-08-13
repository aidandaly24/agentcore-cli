import type {
  CredentialProviderConfiguration,
  CustomTransformConfiguration,
  GatewayInterceptorConfiguration,
  GatewayPolicyEngineConfiguration,
  TargetConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { AgentCorePolicyGrants } from "./agentCorePolicyGrants";
import type { CredentialProviderPolicyState } from "./credentialProviderPolicy";
import type { PolicyContribution } from "./executionRolePolicy";

export type GatewayTargetPolicyState = {
  targetId?: string;
  name?: string;
  targetConfiguration?: TargetConfiguration;
  credentialProviderConfigurations?: readonly CredentialProviderConfiguration[];
};

export type GatewayPolicyState = {
  gatewayArn?: string;
  workloadIdentityArn?: string;
  policyEngineConfiguration?: GatewayPolicyEngineConfiguration;
  interceptorConfigurations?: readonly GatewayInterceptorConfiguration[];
  customTransformConfiguration?: CustomTransformConfiguration;
  credentialProviders?: readonly GatewayCredentialProviderPolicyState[];
  targets: readonly GatewayTargetPolicyState[];
};

export type GatewayCredentialProviderPolicyState = CredentialProviderPolicyState;

export class UninferrableGatewayPermissionError extends Error {
  constructor(
    readonly owner: string,
    message: string,
  ) {
    super(`Cannot infer execution-role permissions for ${owner}: ${message}`);
    this.name = "UninferrableGatewayPermissionError";
  }
}

export class GatewayPolicyPlanner {
  plan(state: GatewayPolicyState): PolicyContribution[] {
    const contributions: PolicyContribution[] = [];

    state.interceptorConfigurations?.forEach((configuration, index) => {
      const owner = `gateway:interceptor:${index}`;
      if (containsKey(configuration, "$unknown")) {
        throw new UninferrableGatewayPermissionError(
          owner,
          "interceptor contains an unknown SDK union",
        );
      }
      const arn = configuration.interceptor?.lambda?.arn;
      if (!arn) {
        throw new UninferrableGatewayPermissionError(owner, "Lambda ARN is missing");
      }
      contributions.push({
        owner,
        reason: "invoke Gateway interceptor",
        statements: [AgentCorePolicyGrants.invokeLambda(arn)],
      });
    });
    if (state.customTransformConfiguration) {
      const owner = "gateway:custom-transform";
      const arn = state.customTransformConfiguration.lambda?.arn;
      if (!arn) {
        throw new UninferrableGatewayPermissionError(owner, "Lambda ARN is missing");
      }
      contributions.push({
        owner,
        reason: "invoke Gateway custom transform",
        statements: [AgentCorePolicyGrants.invokeLambda(arn)],
      });
    }
    if (state.gatewayArn) {
      contributions.push({
        owner: "gateway:root",
        reason: "invoke Gateway",
        statements: [AgentCorePolicyGrants.invokeGateway(state.gatewayArn)],
      });
    }
    if (state.policyEngineConfiguration) {
      const arn = state.policyEngineConfiguration.arn;
      if (!arn) {
        throw new UninferrableGatewayPermissionError(
          "gateway:policy-engine",
          "Policy Engine ARN is missing",
        );
      }
      contributions.push({
        owner: "gateway:policy-engine",
        reason: "authorize Gateway requests",
        statements: [
          AgentCorePolicyGrants.getPolicyEngine(arn),
          AgentCorePolicyGrants.authorizeGateway(
            arn,
            state.gatewayArn ?? gatewayWildcardFromPolicyEngine(arn),
          ),
        ],
      });
    }

    state.targets.forEach((target, index) => {
      const owner = `gateway-target:${target.targetId ?? target.name ?? `pending-${index}`}`;
      if (!target.targetConfiguration) {
        throw new UninferrableGatewayPermissionError(owner, "Target configuration is missing");
      }
      if (containsKey(target.targetConfiguration, "$unknown")) {
        throw new UninferrableGatewayPermissionError(owner, "Target contains an unknown SDK union");
      }
      contributions.push(...this.planCredentialProviders(state, target, owner));
      const lambda = target.targetConfiguration?.mcp?.lambda;
      if (lambda) {
        if (!lambda.lambdaArn) {
          throw new UninferrableGatewayPermissionError(owner, "Lambda ARN is missing");
        }
        contributions.push({
          owner,
          reason: "invoke Lambda target",
          statements: [AgentCorePolicyGrants.invokeLambda(lambda.lambdaArn)],
        });
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "GATEWAY_IAM_ROLE",
        ]);
        this.addSchemaContribution(
          contributions,
          owner,
          "read Lambda tool schema",
          lambda.toolSchema,
          state.gatewayArn,
        );
        return;
      }

      const connector =
        target.targetConfiguration?.mcp?.connector ??
        target.targetConfiguration?.inference?.connector;
      if (connector?.source?.connectorId === "web-search") {
        if (!state.gatewayArn) {
          throw new UninferrableGatewayPermissionError(owner, "Gateway ARN is missing");
        }
        contributions.push({
          owner,
          reason: "invoke Web Search connector",
          statements: [
            AgentCorePolicyGrants.invokeWebSearch(webSearchArnsFromGateway(state.gatewayArn)),
          ],
        });
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "GATEWAY_IAM_ROLE",
        ]);
        return;
      }

      if (
        target.targetConfiguration.mcp?.connector?.source?.connectorId === "bedrock-knowledge-bases"
      ) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "GATEWAY_IAM_ROLE",
        ]);
        const knowledgeBasePlan = knowledgeBasePermissions(
          target.targetConfiguration.mcp.connector.configurations,
          state.gatewayArn,
          owner,
        );
        contributions.push({
          owner,
          reason: "use managed Knowledge Base connector",
          statements: [
            AgentCorePolicyGrants.getKnowledgeBases(knowledgeBasePlan.allKnowledgeBaseArns),
            ...(knowledgeBasePlan.retrieveKnowledgeBaseArns.length > 0
              ? [
                  AgentCorePolicyGrants.retrieveKnowledgeBases(
                    knowledgeBasePlan.retrieveKnowledgeBaseArns,
                  ),
                ]
              : []),
            ...(knowledgeBasePlan.agenticRetrieve
              ? [AgentCorePolicyGrants.agenticRetrieveKnowledgeBases()]
              : []),
          ],
        });
        return;
      }

      if (
        target.targetConfiguration.inference?.connector?.source?.connectorId === "bedrock-mantle"
      ) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "GATEWAY_IAM_ROLE",
        ]);
        const context = gatewayArnContext(state.gatewayArn, owner);
        contributions.push({
          owner,
          reason: "invoke Bedrock Mantle connector",
          statements: [
            AgentCorePolicyGrants.createMantleInference([
              `arn:${context.partition}:bedrock-mantle:${context.region}:${context.accountId}:project/*`,
            ]),
            AgentCorePolicyGrants.listMantleModels(
              `arn:${context.partition}:bedrock-mantle:${context.region}:${context.accountId}:project/default`,
            ),
            AgentCorePolicyGrants.callMantleWithBearerToken(),
          ],
        });
        return;
      }

      const inference =
        target.targetConfiguration.inference?.connector ??
        target.targetConfiguration.inference?.provider;
      if (inference) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "API_KEY",
          "OAUTH",
          "GATEWAY_IAM_ROLE",
        ]);
        if (
          hasExternalCredential(target.credentialProviderConfigurations, "API_KEY", "OAUTH") ||
          (target.credentialProviderConfigurations?.length ?? 0) === 0
        ) {
          return;
        }
        throw new UninferrableGatewayPermissionError(
          owner,
          "IAM permissions for this inference provider cannot be inferred",
        );
      }

      const apiGateway = target.targetConfiguration.mcp?.apiGateway;
      if (apiGateway) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "GATEWAY_IAM_ROLE",
          "API_KEY",
        ]);
        if (!hasExternalCredential(target.credentialProviderConfigurations, "API_KEY")) {
          if (!apiGateway.restApiId || !apiGateway.stage) {
            throw new UninferrableGatewayPermissionError(
              owner,
              "API Gateway REST API ID or stage is missing",
            );
          }
          const context = gatewayArnContext(state.gatewayArn, owner);
          contributions.push({
            owner,
            reason: "invoke API Gateway target",
            statements: [
              AgentCorePolicyGrants.invokeApiGateway(
                `arn:${context.partition}:execute-api:${context.region}:${context.accountId}:` +
                  `${apiGateway.restApiId}/${apiGateway.stage}/*/*`,
              ),
            ],
          });
        }
        return;
      }

      const mcpServer = target.targetConfiguration.mcp?.mcpServer;
      if (mcpServer) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "CALLER_IAM_CREDENTIALS",
          "JWT_PASSTHROUGH",
          "API_KEY",
          "OAUTH",
        ]);
        this.addSchemaContribution(
          contributions,
          owner,
          "read MCP tool schema",
          mcpServer.mcpToolSchema,
          state.gatewayArn,
        );
        return;
      }

      const openApiSchema =
        target.targetConfiguration.mcp?.openApiSchema ??
        target.targetConfiguration.mcp?.smithyModel;
      if (openApiSchema) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "CALLER_IAM_CREDENTIALS",
          "JWT_PASSTHROUGH",
          "API_KEY",
          "OAUTH",
        ]);
        this.addSchemaContribution(
          contributions,
          owner,
          "read API schema",
          openApiSchema,
          state.gatewayArn,
        );
        return;
      }

      const runtime = target.targetConfiguration.http?.agentcoreRuntime;
      if (runtime) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "GATEWAY_IAM_ROLE",
          "CALLER_IAM_CREDENTIALS",
          "JWT_PASSTHROUGH",
          "OAUTH",
        ]);
        if (!runtime.arn) {
          throw new UninferrableGatewayPermissionError(owner, "Runtime ARN is missing");
        }
        if (
          !hasExternalCredential(
            target.credentialProviderConfigurations,
            "CALLER_IAM_CREDENTIALS",
            "JWT_PASSTHROUGH",
            "OAUTH",
          )
        ) {
          contributions.push({
            owner,
            reason: "invoke AgentCore Runtime target",
            statements: [AgentCorePolicyGrants.invokeRuntime([runtime.arn])],
          });
        }
        this.addSchemaContribution(
          contributions,
          owner,
          "read Runtime API schema",
          runtime.schema?.source,
          state.gatewayArn,
        );
        return;
      }

      if (target.targetConfiguration.http?.passthrough) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "GATEWAY_IAM_ROLE",
          "CALLER_IAM_CREDENTIALS",
          "JWT_PASSTHROUGH",
          "API_KEY",
          "OAUTH",
        ]);
        if (hasExternalCredential(target.credentialProviderConfigurations, "GATEWAY_IAM_ROLE")) {
          throw new UninferrableGatewayPermissionError(
            owner,
            "IAM permissions for this HTTP endpoint cannot be inferred",
          );
        }
        this.addSchemaContribution(
          contributions,
          owner,
          "read HTTP API schema",
          target.targetConfiguration.http.passthrough.schema?.source,
          state.gatewayArn,
        );
        return;
      }

      throw new UninferrableGatewayPermissionError(
        owner,
        "Target type permissions are not implemented in this stack layer",
      );
    });

    return contributions;
  }

  private planCredentialProviders(
    state: GatewayPolicyState,
    target: GatewayTargetPolicyState,
    owner: string,
  ): PolicyContribution[] {
    const contributions: PolicyContribution[] = [];
    const providers = new Map(
      (state.credentialProviders ?? []).map((provider) => [provider.providerArn, provider]),
    );

    for (const configuration of target.credentialProviderConfigurations ?? []) {
      if (containsKey(configuration, "$unknown")) {
        throw new UninferrableGatewayPermissionError(
          owner,
          "credential provider contains an unknown SDK union",
        );
      }
      if (
        configuration.credentialProviderType === "GATEWAY_IAM_ROLE" ||
        configuration.credentialProviderType === "CALLER_IAM_CREDENTIALS" ||
        configuration.credentialProviderType === "JWT_PASSTHROUGH"
      ) {
        continue;
      }

      const isApiKey = configuration.credentialProviderType === "API_KEY";
      const isOauth = configuration.credentialProviderType === "OAUTH";
      if (!isApiKey && !isOauth) {
        throw new UninferrableGatewayPermissionError(
          owner,
          `credential provider ${configuration.credentialProviderType ?? "unknown"} is not supported`,
        );
      }
      const providerArn = isApiKey
        ? configuration.credentialProvider?.apiKeyCredentialProvider?.providerArn
        : configuration.credentialProvider?.oauthCredentialProvider?.providerArn;
      if (!providerArn) {
        throw new UninferrableGatewayPermissionError(owner, "credential provider ARN is missing");
      }
      const provider = providers.get(providerArn);
      if (!provider?.secretArn) {
        throw new UninferrableGatewayPermissionError(
          owner,
          `resolved secret ARN for credential provider ${providerArn} is missing`,
        );
      }
      const workloadArns = workloadIdentityResources(state.workloadIdentityArn, owner);
      contributions.push({
        owner: `${owner}:auth:${providerArn}`,
        reason: isApiKey ? "retrieve API key credential" : "retrieve OAuth credential",
        statements: [
          AgentCorePolicyGrants.getWorkloadAccessToken(workloadArns),
          isApiKey
            ? AgentCorePolicyGrants.getResourceApiKey(providerArn)
            : AgentCorePolicyGrants.getResourceOauth2Token(providerArn),
          AgentCorePolicyGrants.readSecret(provider.secretArn),
        ],
      });
    }

    return contributions;
  }

  private addSchemaContribution(
    contributions: PolicyContribution[],
    owner: string,
    reason: string,
    schema: unknown,
    gatewayArn: string | undefined,
  ): void {
    if (schema === undefined) return;
    if (containsKey(schema, "$unknown")) {
      throw new UninferrableGatewayPermissionError(owner, "schema contains an unknown SDK union");
    }
    const uri = s3UriFromSchema(schema);
    if (uri === undefined) return;
    if (!gatewayArn) {
      throw new UninferrableGatewayPermissionError(owner, "Gateway ARN is missing");
    }
    contributions.push({
      owner: `${owner}:schema`,
      reason,
      statements: [AgentCorePolicyGrants.readS3Object(s3ObjectArn(uri, gatewayArn, owner))],
    });
  }

  private validateCredentialProviders(
    owner: string,
    configurations: readonly CredentialProviderConfiguration[] | undefined,
    allowedTypes: readonly string[],
  ): void {
    for (const configuration of configurations ?? []) {
      if (!allowedTypes.includes(configuration.credentialProviderType ?? "")) {
        throw new UninferrableGatewayPermissionError(
          owner,
          `credential provider ${configuration.credentialProviderType ?? "unknown"} is not implemented in this stack layer`,
        );
      }
    }
  }
}

function workloadIdentityResources(
  workloadIdentityArn: string | undefined,
  owner: string,
): [string, string] {
  const separator = "/workload-identity/";
  const separatorIndex = workloadIdentityArn?.indexOf(separator) ?? -1;
  if (!workloadIdentityArn || separatorIndex < 0) {
    throw new UninferrableGatewayPermissionError(owner, "Gateway workload identity ARN is missing");
  }
  return [workloadIdentityArn.slice(0, separatorIndex), workloadIdentityArn];
}

type GatewayArnContext = {
  partition: string;
  region: string;
  accountId: string;
};

function gatewayArnContext(gatewayArn: string | undefined, owner: string): GatewayArnContext {
  const [prefix, partition, service, region, accountId, resource] = gatewayArn?.split(":") ?? [];
  if (
    prefix !== "arn" ||
    !partition ||
    service !== "bedrock-agentcore" ||
    !region ||
    !accountId ||
    !resource?.startsWith("gateway/")
  ) {
    throw new UninferrableGatewayPermissionError(
      owner,
      `invalid Gateway ARN "${gatewayArn ?? ""}"`,
    );
  }
  return { partition, region, accountId };
}

function hasExternalCredential(
  configurations: readonly CredentialProviderConfiguration[] | undefined,
  ...types: readonly string[]
): boolean {
  return (configurations ?? []).some((configuration) =>
    types.includes(configuration.credentialProviderType ?? ""),
  );
}

function knowledgeBasePermissions(
  configurations: readonly { name?: string; parameterValues?: unknown }[] | undefined,
  gatewayArn: string | undefined,
  owner: string,
): {
  allKnowledgeBaseArns: string[];
  retrieveKnowledgeBaseArns: string[];
  agenticRetrieve: boolean;
} {
  if (!configurations || configurations.length === 0) {
    throw new UninferrableGatewayPermissionError(
      owner,
      "Knowledge Base connector has no tool configurations",
    );
  }
  const context = gatewayArnContext(gatewayArn, owner);
  const allKnowledgeBaseIds = new Set<string>();
  const retrieveKnowledgeBaseIds = new Set<string>();
  let agenticRetrieve = false;

  for (const configuration of configurations) {
    if (configuration.name === "Retrieve") {
      const knowledgeBaseId = nestedString(configuration.parameterValues, "knowledgeBaseId");
      if (!knowledgeBaseId) {
        throw new UninferrableGatewayPermissionError(
          owner,
          "Retrieve configuration is missing knowledgeBaseId",
        );
      }
      allKnowledgeBaseIds.add(knowledgeBaseId);
      retrieveKnowledgeBaseIds.add(knowledgeBaseId);
      continue;
    }
    if (configuration.name === "AgenticRetrieveStream") {
      const retrievers = nestedArray(configuration.parameterValues, "retrievers");
      if (!retrievers || retrievers.length === 0) {
        throw new UninferrableGatewayPermissionError(
          owner,
          "AgenticRetrieveStream configuration has no retrievers",
        );
      }
      for (const retriever of retrievers) {
        const knowledgeBaseId = nestedString(
          retriever,
          "configuration",
          "knowledgeBase",
          "knowledgeBaseId",
        );
        if (!knowledgeBaseId) {
          throw new UninferrableGatewayPermissionError(
            owner,
            "AgenticRetrieveStream retriever is missing knowledgeBaseId",
          );
        }
        allKnowledgeBaseIds.add(knowledgeBaseId);
      }
      agenticRetrieve = true;
      continue;
    }
    throw new UninferrableGatewayPermissionError(
      owner,
      `Knowledge Base connector tool ${configuration.name ?? "unknown"} is not supported`,
    );
  }

  const toArn = (knowledgeBaseId: string) =>
    `arn:${context.partition}:bedrock:${context.region}:${context.accountId}:knowledge-base/${knowledgeBaseId}`;
  return {
    allKnowledgeBaseArns: [...allKnowledgeBaseIds].sort().map(toArn),
    retrieveKnowledgeBaseArns: [...retrieveKnowledgeBaseIds].sort().map(toArn),
    agenticRetrieve,
  };
}

function nestedString(value: unknown, ...path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current.length > 0 ? current : undefined;
}

function nestedArray(value: unknown, ...path: readonly string[]): unknown[] | undefined {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current : undefined;
}

function s3UriFromSchema(schema: unknown): string | undefined {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return undefined;
  const s3 = (schema as Record<string, unknown>).s3;
  if (s3 === undefined) return undefined;
  if (s3 === null || typeof s3 !== "object" || Array.isArray(s3)) return "";
  const uri = (s3 as Record<string, unknown>).uri;
  return typeof uri === "string" ? uri : "";
}

function s3ObjectArn(uri: string, gatewayArn: string, owner: string): string {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) {
    throw new UninferrableGatewayPermissionError(owner, `invalid S3 object URI "${uri}"`);
  }
  const [prefix, partition] = gatewayArn.split(":");
  if (prefix !== "arn" || !partition) {
    throw new UninferrableGatewayPermissionError(owner, `invalid Gateway ARN "${gatewayArn}"`);
  }
  return `arn:${partition}:s3:::${match[1]}/${match[2]}`;
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return key in record || Object.values(record).some((entry) => containsKey(entry, key));
}

function webSearchArnsFromGateway(gatewayArn: string): string[] {
  const [prefix, partition, service, region] = gatewayArn.split(":");
  if (prefix !== "arn" || !partition || service !== "bedrock-agentcore" || !region) {
    throw new UninferrableGatewayPermissionError(
      "gateway:web-search",
      `invalid Gateway ARN "${gatewayArn}"`,
    );
  }
  return [
    `arn:${partition}:${service}::aws:tool/web-search.v1`,
    `arn:${partition}:${service}:${region}:aws:tool/web-search.v1`,
  ];
}
function gatewayWildcardFromPolicyEngine(policyEngineArn: string): string {
  const [prefix, partition, service, region, accountId, resource] = policyEngineArn.split(":");
  if (
    prefix !== "arn" ||
    !partition ||
    service !== "bedrock-agentcore" ||
    !region ||
    !accountId ||
    !resource?.startsWith("policy-engine/")
  ) {
    throw new UninferrableGatewayPermissionError(
      "gateway:policy-engine",
      `invalid Policy Engine ARN "${policyEngineArn}"`,
    );
  }
  return `arn:${partition}:${service}:${region}:${accountId}:gateway/*`;
}
