import type {
  AuthorizerConfiguration as SdkAuthorizerConfiguration,
  GatewayProtocolConfiguration,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError } from "../../../../errors";
import { SourceResolver } from "../../../../io";
import type { AuthorizerConfig } from "../../../../projectSchemas/auth";
import type { AgentCoreGateway } from "../../../../projectSchemas/gateway";
import { createHandler, flag, ProjectKey } from "../../../../router";
import { parseJsonObjectFlag, parseTags } from "../../../utils";
import type { AddProjectResourceConfig } from "../types";

export const createAddGatewayHandler = (config: AddProjectResourceConfig) =>
  createHandler({
    name: "gateway",
    description: "adds a Gateway to the current project",
    flags: [
      flag("name", "the Gateway name", z.string().optional()),
      flag(
        "role-arn",
        "IAM role the Gateway assumes; a default role is created when omitted",
        z.string().optional(),
      ),
      flag(
        "protocol",
        "restrict Target protocols to MCP; omitted allows every Target protocol",
        z.enum(["mcp"]).optional(),
      ),
      flag(
        "authorizer-type",
        "inbound authorizer: AWS_IAM, CUSTOM_JWT, or NONE",
        z.enum(["AWS_IAM", "CUSTOM_JWT", "NONE"]).optional(),
      ),
      flag("description", "Gateway description", z.string().optional()),
      flag(
        "protocol-configuration",
        "MCP protocol configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "authorizer-configuration",
        "CUSTOM_JWT configuration (JSON; inline, file://<path>, or - for stdin)",
        z.string().optional(),
      ),
      flag(
        "policy-engine-name",
        "name of a Policy Engine declared in this project",
        z.string().optional(),
      ),
      flag(
        "policy-engine-mode",
        "Policy Engine mode: log-only or enforce",
        z.enum(["log-only", "enforce"]).optional(),
      ),
      flag("exception-level", "exception detail level: debug", z.enum(["debug"]).optional()),
      flag(
        "tags",
        "tags as repeated key=value or a JSON object (inline, file://<path>, or - for stdin)",
        z.array(z.string()).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (!flags.name) {
        throw new InputValidationError("required option '--name <name>' not specified");
      }
      const project = ctx.require(ProjectKey);
      const resourceName = `${project.name}-${flags.name}`;
      if (resourceName.length > 48) {
        throw new InputValidationError(
          `Gateway resource name '${resourceName}' exceeds the service limit of 48 characters`,
        );
      }
      if (
        (flags["policy-engine-name"] === undefined) !==
        (flags["policy-engine-mode"] === undefined)
      ) {
        throw new InputValidationError(
          "--policy-engine-name and --policy-engine-mode must be supplied together",
        );
      }
      if (
        flags["policy-engine-name"] &&
        !project.spec.policyEngines.some((engine) => engine.name === flags["policy-engine-name"])
      ) {
        throw new InputValidationError(
          `policy engine '${flags["policy-engine-name"]}' does not exist in policyEngines[]`,
        );
      }

      const authorizerType = flags["authorizer-type"] ?? "NONE";
      if (authorizerType === "CUSTOM_JWT" && flags["authorizer-configuration"] === undefined) {
        throw new InputValidationError("CUSTOM_JWT requires --authorizer-configuration");
      }
      if (authorizerType !== "CUSTOM_JWT" && flags["authorizer-configuration"] !== undefined) {
        throw new InputValidationError("--authorizer-configuration is valid only with CUSTOM_JWT");
      }
      if (!flags.protocol && flags["protocol-configuration"] !== undefined) {
        throw new InputValidationError(
          "--protocol-configuration is valid only with --protocol mcp",
        );
      }

      const source = new SourceResolver({ stdin: config.io.stdin });
      const protocolConfiguration = parseJsonObjectFlag<GatewayProtocolConfiguration>(
        "protocol-configuration",
        await source.resolveText("protocol-configuration", flags["protocol-configuration"]),
      );
      const authorizerConfiguration = parseJsonObjectFlag<SdkAuthorizerConfiguration>(
        "authorizer-configuration",
        await source.resolveText("authorizer-configuration", flags["authorizer-configuration"]),
      );
      const tags = await resolveTags(source, flags.tags);

      const gateway: AgentCoreGateway = {
        name: flags.name,
        protocolType: flags.protocol ? "MCP" : "None",
        authorizerType,
        authorizerConfiguration: authorizerConfiguration
          ? toAuthorizerConfiguration(authorizerConfiguration)
          : undefined,
        description: flags.description,
        targets: [],
        enableSemanticSearch: protocolConfiguration
          ? semanticSearchEnabled(protocolConfiguration)
          : false,
        exceptionLevel: flags["exception-level"] ? "DEBUG" : "NONE",
        executionRoleArn: flags["role-arn"],
        policyEngineConfiguration:
          flags["policy-engine-name"] && flags["policy-engine-mode"]
            ? {
                policyEngineName: flags["policy-engine-name"],
                mode: flags["policy-engine-mode"] === "enforce" ? "ENFORCE" : "LOG_ONLY",
              }
            : undefined,
        tags,
      };

      for await (const event of config.projectManager.addResource(project, {
        resourceType: "gateway",
        resourceConfig: gateway,
      })) {
        config.io.stderr.write(`${event.message}\n`);
      }
      config.io.stderr.write(`added Gateway '${flags.name}' to '${project.name}'\n`);
    },
  });

function semanticSearchEnabled(configuration: GatewayProtocolConfiguration): boolean {
  const root = configuration as unknown as Record<string, unknown>;
  exactKeys(root, ["mcp"], "protocol-configuration");
  if (!root.mcp) {
    throw new InputValidationError("--protocol-configuration must contain mcp");
  }
  const mcp = object(root.mcp, "protocol-configuration.mcp");
  exactKeys(
    mcp,
    [
      "searchType",
      "supportedVersions",
      "instructions",
      "sessionConfiguration",
      "streamingConfiguration",
    ],
    "protocol-configuration.mcp",
  );
  for (const field of [
    "supportedVersions",
    "instructions",
    "sessionConfiguration",
    "streamingConfiguration",
  ]) {
    if (mcp[field] !== undefined) {
      throw new InputValidationError(
        `Unsupported --protocol-configuration field 'mcp.${field}'. ` +
          "The current project schema cannot persist it.",
      );
    }
  }
  if (mcp.searchType !== undefined && mcp.searchType !== "SEMANTIC") {
    throw new InputValidationError(
      "Unsupported --protocol-configuration field 'mcp.searchType'. " +
        "The current project schema supports only SEMANTIC.",
    );
  }
  return mcp.searchType === "SEMANTIC";
}

function toAuthorizerConfiguration(configuration: SdkAuthorizerConfiguration): AuthorizerConfig {
  const root = configuration as unknown as Record<string, unknown>;
  exactKeys(root, ["customJWTAuthorizer"], "authorizer-configuration");
  const custom = object(root.customJWTAuthorizer, "authorizer-configuration.customJWTAuthorizer");
  exactKeys(
    custom,
    [
      "discoveryUrl",
      "allowedAudience",
      "allowedClients",
      "allowedScopes",
      "advertisedScopeMapping",
      "customClaims",
      "privateEndpoint",
      "privateEndpointOverrides",
      "allowedWorkloadConfiguration",
    ],
    "authorizer-configuration.customJWTAuthorizer",
  );
  for (const field of ["advertisedScopeMapping", "allowedWorkloadConfiguration"]) {
    if (custom[field] !== undefined) {
      throw new InputValidationError(
        `Unsupported --authorizer-configuration field 'customJWTAuthorizer.${field}'. ` +
          "The current project schema cannot persist it.",
      );
    }
  }
  return {
    customJwtAuthorizer: {
      discoveryUrl: custom.discoveryUrl as string,
      allowedAudience: custom.allowedAudience as string[] | undefined,
      allowedClients: custom.allowedClients as string[] | undefined,
      allowedScopes: custom.allowedScopes as string[] | undefined,
      customClaims: custom.customClaims as
        NonNullable<AuthorizerConfig["customJwtAuthorizer"]>["customClaims"] | undefined,
      privateEndpoint: custom.privateEndpoint as
        NonNullable<AuthorizerConfig["customJwtAuthorizer"]>["privateEndpoint"] | undefined,
      privateEndpointOverrides: custom.privateEndpointOverrides as
        | NonNullable<AuthorizerConfig["customJwtAuthorizer"]>["privateEndpointOverrides"]
        | undefined,
    },
  };
}

async function resolveTags(
  source: SourceResolver,
  values: string[] | undefined,
): Promise<Record<string, string> | undefined> {
  const first = values?.[0];
  if (
    values?.length === 1 &&
    first &&
    (first === "-" || first.startsWith("file://") || first.trimStart().startsWith("{"))
  ) {
    const resolved = await source.resolveText("tags", first);
    return parseTags([resolved!]);
  }
  return parseTags(values);
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InputValidationError(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new InputValidationError(
        `Unsupported --${path} field '${key}'. This field cannot be persisted without data loss.`,
      );
    }
  }
}
