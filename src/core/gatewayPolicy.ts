import type {
  CredentialProviderConfiguration,
  CustomTransformConfiguration,
  GatewayInterceptorConfiguration,
  TargetConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";

export type GatewayPolicyStatement = {
  Effect: "Allow";
  Action: string[];
  Resource: string[];
  Condition?: Record<string, unknown>;
};

export type GatewayPolicyState = {
  gatewayArn?: string;
  workloadIdentityArn?: string;
  policyEngineArn?: string;
  interceptorConfigurations?: readonly GatewayInterceptorConfiguration[];
  customTransformConfiguration?: CustomTransformConfiguration;
  credentialSecrets?: ReadonlyMap<string, string>;
  targets?: readonly GatewayPolicyTarget[];
};

export type GatewayPolicyTarget = {
  targetConfiguration: TargetConfiguration;
  credentialProviderConfigurations?: readonly CredentialProviderConfiguration[];
};

export function gatewayPolicy(state: GatewayPolicyState): GatewayPolicyStatement[] {
  const statements: GatewayPolicyStatement[] = [];

  for (const interceptor of state.interceptorConfigurations ?? []) {
    const arn = interceptor.interceptor?.lambda?.arn;
    if (!arn) throw unsupported("Gateway interceptor is missing its Lambda ARN");
    statements.push(allow("lambda:InvokeFunction", arn));
  }
  if (state.customTransformConfiguration) {
    const arn = state.customTransformConfiguration.lambda?.arn;
    if (!arn) throw unsupported("Gateway custom transform is missing its Lambda ARN");
    statements.push(allow("lambda:InvokeFunction", arn));
  }

  if (state.gatewayArn) {
    statements.push(allow("bedrock-agentcore:InvokeGateway", state.gatewayArn));
  }

  if (state.policyEngineArn) {
    statements.push(allow("bedrock-agentcore:GetPolicyEngine", state.policyEngineArn));
    statements.push({
      Effect: "Allow",
      Action: ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
      Resource: [state.policyEngineArn, state.gatewayArn ?? gatewayWildcard(state.policyEngineArn)],
    });
  }

  for (const target of state.targets ?? []) {
    const configuration = target.targetConfiguration;
    if (containsUnknown(configuration)) throw unsupported("Gateway Target type is not supported");
    const credentialTypes = (target.credentialProviderConfigurations ?? []).map(
      ({ credentialProviderType }) => credentialProviderType,
    );
    for (const credential of target.credentialProviderConfigurations ?? []) {
      const apiKey = credential.credentialProviderType === "API_KEY";
      const oauth = credential.credentialProviderType === "OAUTH";
      if (!apiKey && !oauth) continue;
      const providerArn = apiKey
        ? credential.credentialProvider?.apiKeyCredentialProvider?.providerArn
        : credential.credentialProvider?.oauthCredentialProvider?.providerArn;
      if (!providerArn) throw unsupported("Credential provider ARN is missing");
      const secretArn = state.credentialSecrets?.get(providerArn);
      if (!secretArn) throw unsupported(`Credential provider ${providerArn} was not resolved`);
      const workloadArns = workloadIdentityResources(state.workloadIdentityArn);
      statements.push(
        {
          Effect: "Allow",
          Action: ["bedrock-agentcore:GetWorkloadAccessToken"],
          Resource: workloadArns,
        },
        allow(
          apiKey
            ? "bedrock-agentcore:GetResourceApiKey"
            : "bedrock-agentcore:GetResourceOauth2Token",
          providerArn,
        ),
        allow("secretsmanager:GetSecretValue", secretArn),
      );
    }
    for (const schema of targetSchemas(configuration)) {
      const uri = schema?.s3?.uri;
      if (uri) statements.push(allow("s3:GetObject", s3Arn(uri, state.gatewayArn)));
    }

    const lambdaArn = configuration.mcp?.lambda?.lambdaArn;
    if (lambdaArn) {
      requireCredentials(credentialTypes, "GATEWAY_IAM_ROLE");
      statements.push(allow("lambda:InvokeFunction", lambdaArn));
      continue;
    }

    const connectorId =
      configuration.mcp?.connector?.source?.connectorId ??
      configuration.inference?.connector?.source?.connectorId;
    if (connectorId === "web-search") {
      requireCredentials(credentialTypes, "GATEWAY_IAM_ROLE");
      if (!state.gatewayArn) throw new Error("Gateway ARN is required for Web Search permissions");
      const [prefix, partition, service, region] = state.gatewayArn.split(":");
      if (prefix !== "arn" || !partition || service !== "bedrock-agentcore" || !region) {
        throw new Error(`Invalid Gateway ARN: ${state.gatewayArn}`);
      }
      statements.push({
        Effect: "Allow",
        Action: ["bedrock-agentcore:InvokeWebSearch"],
        Resource: [
          `arn:${partition}:${service}::aws:tool/web-search.v1`,
          `arn:${partition}:${service}:${region}:aws:tool/web-search.v1`,
        ],
      });
      continue;
    }
    if (connectorId === "bedrock-knowledge-bases") {
      requireCredentials(credentialTypes, "GATEWAY_IAM_ROLE");
      statements.push(...knowledgeBasePolicy(configuration, state.gatewayArn));
      continue;
    }
    if (connectorId === "bedrock-mantle") {
      requireCredentials(credentialTypes, "GATEWAY_IAM_ROLE");
      const { partition, region, accountId } = gatewayContext(state.gatewayArn);
      statements.push(
        allow(
          "bedrock-mantle:CreateInference",
          `arn:${partition}:bedrock-mantle:${region}:${accountId}:project/*`,
        ),
        allow(
          "bedrock-mantle:ListModels",
          `arn:${partition}:bedrock-mantle:${region}:${accountId}:project/default`,
        ),
        allow("bedrock-mantle:CallWithBearerToken", "*"),
      );
      continue;
    }

    const apiGateway = configuration.mcp?.apiGateway;
    if (apiGateway) {
      requireCredentials(credentialTypes, "GATEWAY_IAM_ROLE", "API_KEY");
      if (!credentialTypes.includes("API_KEY")) {
        const { partition, region, accountId } = gatewayContext(state.gatewayArn);
        statements.push(
          allow(
            "execute-api:Invoke",
            `arn:${partition}:execute-api:${region}:${accountId}:${apiGateway.restApiId}/${apiGateway.stage}/*/*`,
          ),
        );
      }
      continue;
    }

    const runtime = configuration.http?.agentcoreRuntime;
    if (runtime) {
      requireCredentials(
        credentialTypes,
        "GATEWAY_IAM_ROLE",
        "CALLER_IAM_CREDENTIALS",
        "JWT_PASSTHROUGH",
        "OAUTH",
      );
      if (
        !credentialTypes.some(
          (type) =>
            type === "CALLER_IAM_CREDENTIALS" || type === "JWT_PASSTHROUGH" || type === "OAUTH",
        )
      ) {
        if (!runtime.arn) throw unsupported("AgentCore Runtime Target is missing its ARN");
        statements.push(allow("bedrock-agentcore:InvokeAgentRuntime", runtime.arn));
      }
      continue;
    }

    if (
      configuration.mcp?.mcpServer ||
      configuration.mcp?.openApiSchema ||
      configuration.mcp?.smithyModel ||
      configuration.http?.passthrough ||
      configuration.inference?.connector ||
      configuration.inference?.provider
    ) {
      requireCredentials(
        credentialTypes,
        "CALLER_IAM_CREDENTIALS",
        "JWT_PASSTHROUGH",
        "API_KEY",
        "OAUTH",
      );
      continue;
    }

    throw unsupported("Gateway Target permissions cannot be inferred");
  }

  return [
    ...new Map(
      statements.map((statement) => [JSON.stringify(statement), statement] as const),
    ).values(),
  ];
}

function workloadIdentityResources(workloadIdentityArn: string | undefined): string[] {
  const separator = "/workload-identity/";
  const separatorIndex = workloadIdentityArn?.indexOf(separator) ?? -1;
  if (!workloadIdentityArn || separatorIndex < 0) {
    throw unsupported("Gateway workload identity ARN is missing");
  }
  return [workloadIdentityArn.slice(0, separatorIndex), workloadIdentityArn];
}

function allow(action: string, resource: string): GatewayPolicyStatement {
  return { Effect: "Allow", Action: [action], Resource: [resource] };
}

function requireCredentials(
  actual: readonly (string | undefined)[],
  ...allowed: readonly string[]
): void {
  if (actual.some((type) => !type || !allowed.includes(type))) {
    const unsupportedType = actual.find((type) => !type || !allowed.includes(type));
    throw unsupported(`Credential provider ${unsupportedType ?? "unknown"} is not supported`);
  }
}

function targetSchemas(
  configuration: TargetConfiguration,
): Array<{ s3?: { uri?: string } } | undefined> {
  return [
    configuration.mcp?.lambda?.toolSchema,
    configuration.mcp?.mcpServer?.mcpToolSchema,
    configuration.mcp?.openApiSchema,
    configuration.mcp?.smithyModel,
    configuration.http?.agentcoreRuntime?.schema?.source,
    configuration.http?.passthrough?.schema?.source,
  ];
}

function s3Arn(uri: string, gatewayArn: string | undefined): string {
  const match = uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) throw unsupported(`Invalid S3 schema URI "${uri}"`);
  const { partition } = gatewayContext(gatewayArn);
  return `arn:${partition}:s3:::${match[1]}/${match[2]}`;
}

function knowledgeBasePolicy(
  configuration: TargetConfiguration,
  gatewayArn: string | undefined,
): GatewayPolicyStatement[] {
  const connector = configuration.mcp?.connector;
  const { partition, region, accountId } = gatewayContext(gatewayArn);
  const all = new Set<string>();
  const retrieve = new Set<string>();
  let agentic = false;

  for (const tool of connector?.configurations ?? []) {
    if (tool.name === "Retrieve") {
      const id = nestedString(tool.parameterValues, "knowledgeBaseId");
      if (!id) throw unsupported("Knowledge Base Retrieve tool is missing knowledgeBaseId");
      all.add(id);
      retrieve.add(id);
      continue;
    }
    if (tool.name === "AgenticRetrieveStream") {
      const retrievers = nestedArray(tool.parameterValues, "retrievers");
      if (!retrievers?.length) {
        throw unsupported("Knowledge Base AgenticRetrieveStream tool has no retrievers");
      }
      for (const retriever of retrievers) {
        const id = nestedString(retriever, "configuration", "knowledgeBase", "knowledgeBaseId");
        if (!id) throw unsupported("Knowledge Base retriever is missing knowledgeBaseId");
        all.add(id);
      }
      agentic = true;
      continue;
    }
    throw unsupported(`Knowledge Base tool ${tool.name ?? "unknown"} is not supported`);
  }
  if (all.size === 0) throw unsupported("Knowledge Base connector has no configured tools");

  const arn = (id: string) =>
    `arn:${partition}:bedrock:${region}:${accountId}:knowledge-base/${id}`;
  return [
    {
      Effect: "Allow",
      Action: ["bedrock:GetKnowledgeBase"],
      Resource: [...all].sort().map(arn),
    },
    ...(retrieve.size > 0
      ? [
          {
            Effect: "Allow" as const,
            Action: ["bedrock:Retrieve"],
            Resource: [...retrieve].sort().map(arn),
          },
        ]
      : []),
    ...(agentic ? [allow("bedrock:AgenticRetrieveStream", "*")] : []),
  ];
}

function nestedString(value: unknown, ...path: readonly string[]): string | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" && current ? current : undefined;
}

function nestedArray(value: unknown, ...path: readonly string[]): unknown[] | undefined {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current : undefined;
}

function containsUnknown(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsUnknown);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return "$unknown" in record || Object.values(record).some(containsUnknown);
}

function gatewayContext(gatewayArn: string | undefined): {
  partition: string;
  region: string;
  accountId: string;
} {
  const [prefix, partition, service, region, accountId] = gatewayArn?.split(":") ?? [];
  if (prefix !== "arn" || !partition || service !== "bedrock-agentcore" || !region || !accountId) {
    throw unsupported(`Invalid Gateway ARN "${gatewayArn ?? ""}"`);
  }
  return { partition, region, accountId };
}

function unsupported(message: string): Error {
  return new Error(`${message}; manage this role externally for this operation`);
}

function gatewayWildcard(policyEngineArn: string): string {
  const [prefix, partition, service, region, accountId] = policyEngineArn.split(":");
  if (prefix !== "arn" || !partition || service !== "bedrock-agentcore" || !region || !accountId) {
    throw new Error(`Invalid Policy Engine ARN: ${policyEngineArn}`);
  }
  return `arn:${partition}:${service}:${region}:${accountId}:gateway/*`;
}
