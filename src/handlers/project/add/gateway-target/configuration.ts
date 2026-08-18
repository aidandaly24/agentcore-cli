import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../../../errors";
import type {
  AgentCoreGatewayTarget,
  ConnectorId,
  OutboundAuth,
  SchemaSource,
} from "../../../../projectSchemas/gateway";
import {
  GATEWAY_TARGET_INLINE_SCHEMA_FILENAMES,
  type GatewayTargetInlineSchema,
} from "../../types";

type Translation = {
  target: AgentCoreGatewayTarget;
  inlineSchema?: GatewayTargetInlineSchema;
};

type JsonObject = Record<string, unknown>;

export function translateTargetConfiguration(
  name: string,
  configuration: TargetConfiguration,
  outboundAuth?: OutboundAuth,
): Translation {
  const root = object(configuration, "targetConfiguration");
  exactKeys(root, ["mcp", "http", "inference"], "targetConfiguration");
  const variant = exactlyOne(root, ["mcp", "http", "inference"], "targetConfiguration");

  let translation: Translation;
  switch (variant) {
    case "mcp":
      translation = translateMcp(name, object(root.mcp, "mcp"));
      break;
    case "http":
      translation = translateHttp(name, object(root.http, "http"));
      break;
    case "inference":
      throw unsupported(
        "inference",
        "Inference Gateway Targets are not represented by the current project schema.",
      );
  }

  if (!outboundAuth) return translation;
  if (
    !["mcpServer", "openApiSchema", "apiGateway", "httpRuntime", "passthrough"].includes(
      translation.target.targetType,
    )
  ) {
    throw unsupported(
      "outboundAuth",
      `${translation.target.targetType} Targets cannot preserve outbound authentication in the current project schema.`,
    );
  }
  return {
    ...translation,
    target: { ...translation.target, outboundAuth },
  };
}

export function connectorTargetFromShortcut(
  name: string,
  connectorId: ConnectorId,
  knowledgeBase?: string,
): AgentCoreGatewayTarget {
  switch (connectorId) {
    case "web-search":
      return {
        name,
        targetType: "connector",
        connectorId,
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
      };
    case "bedrock-knowledge-bases":
      if (!knowledgeBase) {
        throw new InputValidationError(
          "--connector bedrock-knowledge-bases requires --knowledge-base",
        );
      }
      return {
        name,
        targetType: "connector",
        connectorId,
        configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: knowledgeBase } }],
      };
  }
}

function translateMcp(name: string, mcp: JsonObject): Translation {
  const variants = [
    "openApiSchema",
    "smithyModel",
    "lambda",
    "mcpServer",
    "apiGateway",
    "connector",
  ] as const;
  exactKeys(mcp, variants, "mcp");
  const variant = exactlyOne(mcp, variants, "mcp");

  switch (variant) {
    case "openApiSchema":
      return translateApiSchema(name, "openApiSchema", "openapi", mcp.openApiSchema);
    case "smithyModel":
      return translateApiSchema(name, "smithyModel", "smithy", mcp.smithyModel);
    case "lambda":
      return translateLambda(name, object(mcp.lambda, "mcp.lambda"));
    case "mcpServer":
      return translateMcpServer(name, object(mcp.mcpServer, "mcp.mcpServer"));
    case "apiGateway":
      return translateApiGateway(name, object(mcp.apiGateway, "mcp.apiGateway"));
    case "connector":
      return translateConnector(name, object(mcp.connector, "mcp.connector"));
  }
}

function translateApiSchema(
  name: string,
  targetType: "openApiSchema" | "smithyModel",
  kind: "openapi" | "smithy",
  raw: unknown,
): Translation {
  const schema = object(raw, `mcp.${targetType}`);
  exactKeys(schema, ["inlinePayload", "s3"], `mcp.${targetType}`);
  const source = exactlyOne(schema, ["inlinePayload", "s3"], `mcp.${targetType}`);

  if (source === "inlinePayload") {
    const content = string(schema.inlinePayload, `mcp.${targetType}.inlinePayload`);
    return {
      target: {
        name,
        targetType,
        schemaSource: {
          inline: { path: GATEWAY_TARGET_INLINE_SCHEMA_FILENAMES[kind] },
        },
      },
      inlineSchema: { kind, content },
    };
  }

  return {
    target: {
      name,
      targetType,
      schemaSource: translateS3Source(schema.s3, `mcp.${targetType}.s3`),
    },
  };
}

function translateLambda(name: string, lambda: JsonObject): Translation {
  exactKeys(lambda, ["lambdaArn", "toolSchema"], "mcp.lambda");
  const lambdaArn = string(lambda.lambdaArn, "mcp.lambda.lambdaArn");
  const toolSchema = object(lambda.toolSchema, "mcp.lambda.toolSchema");
  exactKeys(toolSchema, ["inlinePayload", "s3"], "mcp.lambda.toolSchema");
  const source = exactlyOne(toolSchema, ["inlinePayload", "s3"], "mcp.lambda.toolSchema");

  if (source === "inlinePayload") {
    if (!Array.isArray(toolSchema.inlinePayload)) {
      throw invalid("mcp.lambda.toolSchema.inlinePayload", "must be a JSON array");
    }
    return {
      target: {
        name,
        targetType: "lambdaFunctionArn",
        lambdaFunctionArn: {
          lambdaArn,
          toolSchemaFile: GATEWAY_TARGET_INLINE_SCHEMA_FILENAMES.lambda,
        },
      },
      inlineSchema: {
        kind: "lambda",
        content: JSON.stringify(toolSchema.inlinePayload, undefined, 2),
      },
    };
  }

  const s3 = object(toolSchema.s3, "mcp.lambda.toolSchema.s3");
  exactKeys(s3, ["uri", "bucketOwnerAccountId"], "mcp.lambda.toolSchema.s3");
  if (s3.bucketOwnerAccountId !== undefined) {
    throw unsupported(
      "mcp.lambda.toolSchema.s3.bucketOwnerAccountId",
      "Lambda tool schemas in the project schema preserve only the S3 URI.",
    );
  }
  return {
    target: {
      name,
      targetType: "lambdaFunctionArn",
      lambdaFunctionArn: {
        lambdaArn,
        toolSchemaFile: string(s3.uri, "mcp.lambda.toolSchema.s3.uri"),
      },
    },
  };
}

function translateMcpServer(name: string, server: JsonObject): Translation {
  exactKeys(
    server,
    ["endpoint", "mcpToolSchema", "listingMode", "resourcePriority"],
    "mcp.mcpServer",
  );
  for (const field of ["mcpToolSchema", "listingMode", "resourcePriority"] as const) {
    if (server[field] !== undefined) {
      throw unsupported(
        `mcp.mcpServer.${field}`,
        "Static MCP Server discovery settings are not represented by the current project schema.",
      );
    }
  }
  return {
    target: {
      name,
      targetType: "mcpServer",
      endpoint: httpsEndpoint(server.endpoint, "mcp.mcpServer.endpoint"),
    },
  };
}

function translateApiGateway(name: string, raw: JsonObject): Translation {
  exactKeys(raw, ["restApiId", "stage", "apiGatewayToolConfiguration"], "mcp.apiGateway");
  const toolConfiguration = object(
    raw.apiGatewayToolConfiguration,
    "mcp.apiGateway.apiGatewayToolConfiguration",
  );
  exactKeys(
    toolConfiguration,
    ["toolFilters", "toolOverrides"],
    "mcp.apiGateway.apiGatewayToolConfiguration",
  );
  array(
    toolConfiguration.toolFilters,
    "mcp.apiGateway.apiGatewayToolConfiguration.toolFilters",
  ).forEach((filter, index) =>
    exactKeys(
      object(filter, `mcp.apiGateway.apiGatewayToolConfiguration.toolFilters[${index}]`),
      ["filterPath", "methods"],
      `mcp.apiGateway.apiGatewayToolConfiguration.toolFilters[${index}]`,
    ),
  );
  if (toolConfiguration.toolOverrides !== undefined) {
    array(
      toolConfiguration.toolOverrides,
      "mcp.apiGateway.apiGatewayToolConfiguration.toolOverrides",
    ).forEach((override, index) =>
      exactKeys(
        object(override, `mcp.apiGateway.apiGatewayToolConfiguration.toolOverrides[${index}]`),
        ["name", "description", "path", "method"],
        `mcp.apiGateway.apiGatewayToolConfiguration.toolOverrides[${index}]`,
      ),
    );
  }

  return {
    target: {
      name,
      targetType: "apiGateway",
      apiGateway: raw as AgentCoreGatewayTarget["apiGateway"],
    },
  };
}

function translateConnector(name: string, raw: JsonObject): Translation {
  exactKeys(raw, ["source", "enabled", "configurations"], "mcp.connector");
  if (raw.enabled !== undefined) {
    throw unsupported(
      "mcp.connector.enabled",
      "Connector enabled-tool selection is not represented by the current project schema.",
    );
  }
  const source = object(raw.source, "mcp.connector.source");
  exactKeys(source, ["connectorId", "version"], "mcp.connector.source");
  if (source.version !== undefined) {
    throw unsupported(
      "mcp.connector.source.version",
      "Connector version selection is not represented by the current project schema.",
    );
  }
  const connectorId = string(source.connectorId, "mcp.connector.source.connectorId");
  if (connectorId !== "web-search" && connectorId !== "bedrock-knowledge-bases") {
    throw unsupported(
      "mcp.connector.source.connectorId",
      `Connector '${connectorId}' is not supported by the current project schema.`,
    );
  }

  let configurations: AgentCoreGatewayTarget["configurations"];
  if (raw.configurations !== undefined) {
    configurations = array(raw.configurations, "mcp.connector.configurations").map(
      (configuration, index) => {
        const path = `mcp.connector.configurations[${index}]`;
        const item = object(configuration, path);
        exactKeys(item, ["name", "description", "parameterValues", "parameterOverrides"], path);
        if (item.parameterOverrides !== undefined) {
          array(item.parameterOverrides, `${path}.parameterOverrides`).forEach(
            (override, overrideIndex) =>
              exactKeys(
                object(override, `${path}.parameterOverrides[${overrideIndex}]`),
                ["path", "description", "visible"],
                `${path}.parameterOverrides[${overrideIndex}]`,
              ),
          );
        }
        return item as NonNullable<AgentCoreGatewayTarget["configurations"]>[number];
      },
    );
  }

  return {
    target: {
      name,
      targetType: "connector",
      connectorId,
      configurations,
    },
  };
}

function translateHttp(name: string, http: JsonObject): Translation {
  exactKeys(http, ["agentcoreRuntime", "passthrough"], "http");
  const variant = exactlyOne(http, ["agentcoreRuntime", "passthrough"], "http");
  if (variant === "agentcoreRuntime") {
    throw unsupported(
      "http.agentcoreRuntime",
      "Use --runtime with the name of a Runtime declared in this project.",
    );
  }

  const passthrough = object(http.passthrough, "http.passthrough");
  exactKeys(
    passthrough,
    ["endpoint", "protocolType", "schema", "stickinessConfiguration"],
    "http.passthrough",
  );
  if (passthrough.schema !== undefined) {
    throw unsupported(
      "http.passthrough.schema",
      "HTTP API schemas are not represented by the current project schema.",
    );
  }
  if (passthrough.stickinessConfiguration !== undefined) {
    exactKeys(
      object(passthrough.stickinessConfiguration, "http.passthrough.stickinessConfiguration"),
      ["identifier", "timeout"],
      "http.passthrough.stickinessConfiguration",
    );
  }

  return {
    target: {
      name,
      targetType: "passthrough",
      passthrough: passthrough as AgentCoreGatewayTarget["passthrough"],
    },
  };
}

function translateS3Source(raw: unknown, path: string): SchemaSource {
  const s3 = object(raw, path);
  exactKeys(s3, ["uri", "bucketOwnerAccountId"], path);
  return {
    s3: {
      uri: string(s3.uri, `${path}.uri`),
      ...(s3.bucketOwnerAccountId === undefined
        ? {}
        : {
            bucketOwnerAccountId: string(s3.bucketOwnerAccountId, `${path}.bucketOwnerAccountId`),
          }),
    },
  };
}

function object(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(path, "must be a JSON object");
  }
  return value as JsonObject;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw invalid(path, "must be a JSON array");
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalid(path, "must be a non-empty string");
  }
  return value;
}

export function httpsEndpoint(value: unknown, path: string): string {
  const endpoint = string(value, path);
  try {
    if (new URL(endpoint).protocol !== "https:") {
      throw invalid(path, "must use HTTPS");
    }
  } catch (error) {
    if (error instanceof InputValidationError) throw error;
    throw invalid(path, "must be a valid HTTPS URL");
  }
  return endpoint;
}

function exactKeys(value: JsonObject, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw unsupported(`${path}.${key}`, "This field cannot be persisted without data loss.");
    }
  }
}

function exactlyOne<T extends string>(value: JsonObject, keys: readonly T[], path: string): T {
  const present = keys.filter((key) => value[key] !== undefined);
  if (present.length !== 1) {
    throw invalid(path, `must contain exactly one of ${keys.join(", ")}`);
  }
  return present[0]!;
}

function invalid(path: string, message: string): InputValidationError {
  return new InputValidationError(`Invalid Target configuration field '${path}': ${message}`);
}

function unsupported(path: string, guidance: string): InputValidationError {
  return new InputValidationError(`Unsupported Target configuration field '${path}'. ${guidance}`);
}
