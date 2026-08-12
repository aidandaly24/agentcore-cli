import { describe, expect, test } from "bun:test";
import { PolicyCompiler } from "./executionRolePolicy";
import {
  GatewayPolicyPlanner,
  UninferrableGatewayPermissionError,
  type GatewayPolicyState,
} from "./gatewayPolicy";

const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
const POLICY_ENGINE_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders";
const LAMBDA_ARN = "arn:aws:lambda:us-west-2:123456789012:function:orders";
const WEB_SEARCH_ARN = "arn:aws:bedrock-agentcore::aws:tool/web-search.v1";
const REGIONAL_WEB_SEARCH_ARN = "arn:aws:bedrock-agentcore:us-west-2:aws:tool/web-search.v1";

describe("GatewayPolicyPlanner", () => {
  test("plans exact root, Policy Engine, Lambda, and Web Search permissions", () => {
    const contributions = new GatewayPolicyPlanner().plan({
      gatewayArn: GATEWAY_ARN,
      policyEngineConfiguration: {
        arn: POLICY_ENGINE_ARN,
        mode: "ENFORCE",
      },
      targets: [
        {
          targetId: "lambda-target",
          targetConfiguration: {
            mcp: {
              lambda: {
                lambdaArn: LAMBDA_ARN,
                toolSchema: { inlinePayload: [] },
              },
            },
          },
        },
        {
          targetId: "web-search-target",
          targetConfiguration: {
            mcp: {
              connector: {
                source: { connectorId: "web-search" },
              },
            },
          },
        },
      ],
    });
    const compiled = new PolicyCompiler().compile(contributions);

    expect(compiled.permissions.map(({ action, resource }) => `${action} ${resource}`)).toEqual(
      expect.arrayContaining([
        `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
        `bedrock-agentcore:GetPolicyEngine ${POLICY_ENGINE_ARN}`,
        `bedrock-agentcore:AuthorizeAction ${POLICY_ENGINE_ARN}`,
        `bedrock-agentcore:AuthorizeAction ${GATEWAY_ARN}`,
        `bedrock-agentcore:PartiallyAuthorizeActions ${POLICY_ENGINE_ARN}`,
        `bedrock-agentcore:PartiallyAuthorizeActions ${GATEWAY_ARN}`,
        `lambda:InvokeFunction ${LAMBDA_ARN}`,
        `bedrock-agentcore:InvokeWebSearch ${WEB_SEARCH_ARN}`,
        `bedrock-agentcore:InvokeWebSearch ${REGIONAL_WEB_SEARCH_ARN}`,
      ]),
    );
    expect(compiled.permissions).toHaveLength(9);
  });

  test("allows an HTTP passthrough Target with no execution-role auth", () => {
    const contributions = new GatewayPolicyPlanner().plan({
      gatewayArn: GATEWAY_ARN,
      targets: [
        {
          targetId: "public-http",
          targetConfiguration: {
            http: {
              passthrough: {
                endpoint: "https://example.com",
                protocolType: "CUSTOM",
              },
            },
          },
        },
      ],
    });

    expect(new PolicyCompiler().compile(contributions).permissions).toEqual([
      expect.objectContaining({
        action: "bedrock-agentcore:InvokeGateway",
        resource: GATEWAY_ARN,
      }),
    ]);
  });

  test.each([
    [
      "Policy Engine interceptor",
      {
        gatewayArn: GATEWAY_ARN,
        interceptorConfigurations: [
          {
            interceptor: { lambda: { arn: LAMBDA_ARN } },
            interceptionPoints: ["REQUEST"],
          },
        ],
        targets: [],
      },
    ],
    [
      "Knowledge Base connector",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "kb",
            targetConfiguration: {
              mcp: {
                connector: {
                  source: { connectorId: "bedrock-knowledge-bases" },
                },
              },
            },
          },
        ],
      },
    ],
    [
      "API Gateway Target",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "api",
            targetConfiguration: {
              mcp: {
                apiGateway: {
                  restApiId: "api-id",
                  stage: "prod",
                  apiGatewayToolConfiguration: { toolFilters: [] },
                },
              },
            },
          },
        ],
      },
    ],
    [
      "AgentCore Runtime Target",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "runtime",
            targetConfiguration: {
              http: {
                agentcoreRuntime: {
                  arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/runtime-id",
                },
              },
            },
          },
        ],
      },
    ],
    [
      "S3 schema",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "schema",
            targetConfiguration: {
              mcp: {
                openApiSchema: {
                  s3: { uri: "s3://bucket/schema.json" },
                },
              },
            },
          },
        ],
      },
    ],
    [
      "API key auth",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "api-key",
            targetConfiguration: {
              mcp: {
                mcpServer: {
                  endpoint: "https://example.com/mcp",
                },
              },
            },
            credentialProviderConfigurations: [
              {
                credentialProviderType: "API_KEY",
              },
            ],
          },
        ],
      },
    ],
    [
      "HTTP S3 schema",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "http-schema",
            targetConfiguration: {
              http: {
                passthrough: {
                  endpoint: "https://example.com",
                  protocolType: "CUSTOM",
                  schema: {
                    source: {
                      s3: { uri: "s3://bucket/http-schema.json" },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    ],
    [
      "unknown SDK union",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "future",
            targetConfiguration: {
              $unknown: ["futureTarget", {}],
            },
          },
        ],
      },
    ],
  ] as [string, GatewayPolicyState][])(
    "rejects unimplemented permission-bearing %s before mutation",
    (_name, state) => {
      expect(() => new GatewayPolicyPlanner().plan(state)).toThrow(
        UninferrableGatewayPermissionError,
      );
    },
  );
});
