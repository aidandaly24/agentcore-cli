import type {
  CredentialProviderConfiguration,
  CustomTransformConfiguration,
  GatewayInterceptorConfiguration,
  GatewayPolicyEngineConfiguration,
  TargetConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { AgentCorePolicyGrants } from "./agentCorePolicyGrants";
import type { PolicyContribution } from "./executionRolePolicy";

export type GatewayTargetPolicyState = {
  targetId?: string;
  name?: string;
  targetConfiguration?: TargetConfiguration;
  credentialProviderConfigurations?: readonly CredentialProviderConfiguration[];
};

export type GatewayPolicyState = {
  gatewayArn?: string;
  policyEngineConfiguration?: GatewayPolicyEngineConfiguration;
  interceptorConfigurations?: readonly GatewayInterceptorConfiguration[];
  customTransformConfiguration?: CustomTransformConfiguration;
  targets: readonly GatewayTargetPolicyState[];
};

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

    if ((state.interceptorConfigurations?.length ?? 0) > 0) {
      throw new UninferrableGatewayPermissionError(
        "gateway:interceptors",
        "interceptor permissions are not implemented in this stack layer",
      );
    }
    if (state.customTransformConfiguration) {
      throw new UninferrableGatewayPermissionError(
        "gateway:custom-transform",
        "custom transform permissions are not implemented in this stack layer",
      );
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
        if (lambda.toolSchema && "s3" in lambda.toolSchema) {
          throw new UninferrableGatewayPermissionError(
            owner,
            "S3 Lambda tool schema permissions are not implemented in this stack layer",
          );
        }
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

      const mcpServer = target.targetConfiguration.mcp?.mcpServer;
      if (mcpServer) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "CALLER_IAM_CREDENTIALS",
          "JWT_PASSTHROUGH",
        ]);
        if (mcpServer.mcpToolSchema && "s3" in mcpServer.mcpToolSchema) {
          throw new UninferrableGatewayPermissionError(
            owner,
            "S3 MCP tool schema permissions are not implemented in this stack layer",
          );
        }
        return;
      }

      const openApiSchema =
        target.targetConfiguration.mcp?.openApiSchema ??
        target.targetConfiguration.mcp?.smithyModel;
      if (openApiSchema) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "CALLER_IAM_CREDENTIALS",
          "JWT_PASSTHROUGH",
        ]);
        if ("s3" in openApiSchema) {
          throw new UninferrableGatewayPermissionError(
            owner,
            "S3 schema permissions are not implemented in this stack layer",
          );
        }
        return;
      }

      if (target.targetConfiguration.http?.passthrough) {
        this.validateCredentialProviders(owner, target.credentialProviderConfigurations, [
          "CALLER_IAM_CREDENTIALS",
          "JWT_PASSTHROUGH",
        ]);
        if (containsKey(target.targetConfiguration.http.passthrough, "s3")) {
          throw new UninferrableGatewayPermissionError(
            owner,
            "S3 HTTP schema permissions are not implemented in this stack layer",
          );
        }
        return;
      }

      throw new UninferrableGatewayPermissionError(
        owner,
        "Target type permissions are not implemented in this stack layer",
      );
    });

    return contributions;
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
