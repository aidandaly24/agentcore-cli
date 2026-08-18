import { describe, expect, test } from "bun:test";
import type { TargetConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { connectorTargetFromShortcut, translateTargetConfiguration } from "./configuration";

describe("translateTargetConfiguration", () => {
  test("materializes an inline Lambda tool schema", () => {
    const result = translateTargetConfiguration("search", {
      mcp: {
        lambda: {
          lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
          toolSchema: {
            inlinePayload: [
              {
                name: "search",
                description: "Search documents",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          },
        },
      },
    });

    expect(result.target).toEqual({
      name: "search",
      targetType: "lambdaFunctionArn",
      lambdaFunctionArn: {
        lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
        toolSchemaFile: "tool-schema.json",
      },
    });
    expect(result.inlineSchema).toEqual({
      kind: "lambda",
      content: JSON.stringify(
        [
          {
            name: "search",
            description: "Search documents",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        undefined,
        2,
      ),
    });
  });

  test("preserves a Lambda S3 tool schema", () => {
    const result = translateTargetConfiguration("search", {
      mcp: {
        lambda: {
          lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
          toolSchema: { s3: { uri: "s3://schemas/search.json" } },
        },
      },
    });

    expect(result).toEqual({
      target: {
        name: "search",
        targetType: "lambdaFunctionArn",
        lambdaFunctionArn: {
          lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
          toolSchemaFile: "s3://schemas/search.json",
        },
      },
    });
  });

  test("materializes inline OpenAPI and Smithy schemas", () => {
    expect(
      translateTargetConfiguration("openapi", {
        mcp: { openApiSchema: { inlinePayload: '{"openapi":"3.0.0"}' } },
      }),
    ).toEqual({
      target: {
        name: "openapi",
        targetType: "openApiSchema",
        schemaSource: { inline: { path: "openapi.json" } },
      },
      inlineSchema: { kind: "openapi", content: '{"openapi":"3.0.0"}' },
    });

    expect(
      translateTargetConfiguration("smithy", {
        mcp: { smithyModel: { inlinePayload: '{"smithy":"2.0"}' } },
      }),
    ).toEqual({
      target: {
        name: "smithy",
        targetType: "smithyModel",
        schemaSource: { inline: { path: "smithy.json" } },
      },
      inlineSchema: { kind: "smithy", content: '{"smithy":"2.0"}' },
    });
  });

  test("preserves S3 schema configuration", () => {
    expect(
      translateTargetConfiguration("openapi", {
        mcp: {
          openApiSchema: {
            s3: { uri: "s3://schemas/openapi.json", bucketOwnerAccountId: "123456789012" },
          },
        },
      }),
    ).toEqual({
      target: {
        name: "openapi",
        targetType: "openApiSchema",
        schemaSource: {
          s3: { uri: "s3://schemas/openapi.json", bucketOwnerAccountId: "123456789012" },
        },
      },
    });
  });

  test("maps external MCP, API Gateway, and HTTP passthrough targets", () => {
    expect(
      translateTargetConfiguration("external", {
        mcp: { mcpServer: { endpoint: "https://mcp.example.com" } },
      }),
    ).toEqual({
      target: {
        name: "external",
        targetType: "mcpServer",
        endpoint: "https://mcp.example.com",
      },
    });

    expect(
      translateTargetConfiguration("api", {
        mcp: {
          apiGateway: {
            restApiId: "abc123",
            stage: "prod",
            apiGatewayToolConfiguration: {
              toolFilters: [{ filterPath: "/pets", methods: ["GET", "POST"] }],
              toolOverrides: [
                {
                  name: "getPet",
                  path: "/pets/{id}",
                  method: "GET",
                  description: "Get one pet",
                },
              ],
            },
          },
        },
      }),
    ).toEqual({
      target: {
        name: "api",
        targetType: "apiGateway",
        apiGateway: {
          restApiId: "abc123",
          stage: "prod",
          apiGatewayToolConfiguration: {
            toolFilters: [{ filterPath: "/pets", methods: ["GET", "POST"] }],
            toolOverrides: [
              {
                name: "getPet",
                path: "/pets/{id}",
                method: "GET",
                description: "Get one pet",
              },
            ],
          },
        },
      },
    });

    expect(
      translateTargetConfiguration("http", {
        http: {
          passthrough: {
            endpoint: "https://api.example.com",
            protocolType: "CUSTOM",
            stickinessConfiguration: { identifier: "$context.header.x-session", timeout: 900 },
          },
        },
      }),
    ).toEqual({
      target: {
        name: "http",
        targetType: "passthrough",
        passthrough: {
          endpoint: "https://api.example.com",
          protocolType: "CUSTOM",
          stickinessConfiguration: { identifier: "$context.header.x-session", timeout: 900 },
        },
      },
    });
  });

  test("maps supported connector configuration without dropping fields", () => {
    expect(
      translateTargetConfiguration("search", {
        mcp: {
          connector: {
            source: { connectorId: "web-search" },
            configurations: [
              {
                name: "WebSearch",
                description: "Search selected sites",
                parameterValues: { maxResults: 5 },
                parameterOverrides: [
                  { path: "/query", description: "Search query", visible: true },
                ],
              },
            ],
          },
        },
      }),
    ).toEqual({
      target: {
        name: "search",
        targetType: "connector",
        connectorId: "web-search",
        configurations: [
          {
            name: "WebSearch",
            description: "Search selected sites",
            parameterValues: { maxResults: 5 },
            parameterOverrides: [{ path: "/query", description: "Search query", visible: true }],
          },
        ],
      },
    });
  });

  test.each([
    [
      "MCP tool schema",
      {
        mcp: {
          mcpServer: {
            endpoint: "https://mcp.example.com",
            mcpToolSchema: { inlinePayload: "[]" },
          },
        },
      },
      "mcp.mcpServer.mcpToolSchema",
    ],
    [
      "connector version",
      {
        mcp: {
          connector: { source: { connectorId: "web-search", version: "1.1.0" } },
        },
      },
      "mcp.connector.source.version",
    ],
    [
      "connector enabled tools",
      {
        mcp: {
          connector: {
            source: { connectorId: "web-search" },
            enabled: ["WebSearch"],
          },
        },
      },
      "mcp.connector.enabled",
    ],
    [
      "HTTP schema",
      {
        http: {
          passthrough: {
            endpoint: "https://api.example.com",
            protocolType: "CUSTOM",
            schema: { source: { inlinePayload: "{}" } },
          },
        },
      },
      "http.passthrough.schema",
    ],
    [
      "Runtime ARN",
      {
        http: {
          agentcoreRuntime: {
            arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/runtime-id",
          },
        },
      },
      "--runtime",
    ],
    [
      "inference",
      {
        inference: {
          connector: { source: { connectorId: "bedrock-mantle" } },
        },
      },
      "inference",
    ],
    [
      "unknown field",
      {
        mcp: {
          mcpServer: {
            endpoint: "https://mcp.example.com",
            futureField: true,
          },
        },
      } as unknown as TargetConfiguration,
      "mcp.mcpServer.futureField",
    ],
    [
      "non-HTTPS MCP endpoint",
      {
        mcp: {
          mcpServer: {
            endpoint: "http://mcp.example.com",
          },
        },
      },
      "must use HTTPS",
    ],
  ] satisfies [string, TargetConfiguration, string][])(
    "rejects unsupported %s input",
    (_label, configuration, expected) => {
      expect(() => translateTargetConfiguration("target", configuration)).toThrow(expected);
    },
  );
});

describe("connectorTargetFromShortcut", () => {
  test("builds web search and knowledge base connector targets", () => {
    expect(connectorTargetFromShortcut("search", "web-search")).toEqual({
      name: "search",
      targetType: "connector",
      connectorId: "web-search",
      configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
    });
    expect(
      connectorTargetFromShortcut("knowledge", "bedrock-knowledge-bases", "ProductDocs"),
    ).toEqual({
      name: "knowledge",
      targetType: "connector",
      connectorId: "bedrock-knowledge-bases",
      configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: "ProductDocs" } }],
    });
  });

  test("requires a knowledge base reference", () => {
    expect(() => connectorTargetFromShortcut("knowledge", "bedrock-knowledge-bases")).toThrow(
      "--knowledge-base",
    );
  });
});
