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
const TRANSFORM_LAMBDA_ARN = "arn:aws:lambda:us-west-2:123456789012:function:orders-transform";
const WEB_SEARCH_ARN = "arn:aws:bedrock-agentcore::aws:tool/web-search.v1";
const REGIONAL_WEB_SEARCH_ARN = "arn:aws:bedrock-agentcore:us-west-2:aws:tool/web-search.v1";
const RUNTIME_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders";
const API_GATEWAY_ARN = "arn:aws:execute-api:us-west-2:123456789012:orders/prod/*/*";
const KNOWLEDGE_BASE_ARN = "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB12345678";
const AGENTIC_KNOWLEDGE_BASE_ARN =
  "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB87654321";
const MANTLE_PROJECT_ARN = "arn:aws:bedrock-mantle:us-west-2:123456789012:project/*";
const MANTLE_DEFAULT_PROJECT_ARN = "arn:aws:bedrock-mantle:us-west-2:123456789012:project/default";
const WORKLOAD_IDENTITY_DIRECTORY_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default";
const WORKLOAD_IDENTITY_ARN = `${WORKLOAD_IDENTITY_DIRECTORY_ARN}/workload-identity/orders-abc123`;
const API_KEY_PROVIDER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/orders";
const OAUTH_PROVIDER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/orders";
const API_KEY_SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:123456789012:secret:bedrock-agentcore-api-key";
const OAUTH_SECRET_ARN =
  "arn:aws:secretsmanager:us-west-2:123456789012:secret:bedrock-agentcore-oauth";
const S3_OBJECT_ARNS = [
  "arn:aws:s3:::schemas/http.json",
  "arn:aws:s3:::schemas/lambda.json",
  "arn:aws:s3:::schemas/mcp.json",
  "arn:aws:s3:::schemas/openapi.json",
  "arn:aws:s3:::schemas/runtime.json",
  "arn:aws:s3:::schemas/service.smithy",
];

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

  test("plans exact Lambda permissions for interceptors and custom transforms", () => {
    const compiled = new PolicyCompiler().compile(
      new GatewayPolicyPlanner().plan({
        gatewayArn: GATEWAY_ARN,
        interceptorConfigurations: [
          {
            interceptor: { lambda: { arn: LAMBDA_ARN } },
            interceptionPoints: ["REQUEST"],
          },
        ],
        customTransformConfiguration: {
          lambda: { arn: TRANSFORM_LAMBDA_ARN },
        },
        targets: [],
      }),
    );

    expect(compiled.permissions.map(({ action, resource }) => `${action} ${resource}`)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_ARN}`,
      `lambda:InvokeFunction ${TRANSFORM_LAMBDA_ARN}`,
    ]);
  });

  test("plans exact S3 object access for every schema-bearing Target shape", () => {
    const compiled = new PolicyCompiler().compile(
      new GatewayPolicyPlanner().plan({
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "lambda",
            targetConfiguration: {
              mcp: {
                lambda: {
                  lambdaArn: LAMBDA_ARN,
                  toolSchema: { s3: { uri: "s3://schemas/lambda.json" } },
                },
              },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
          },
          {
            targetId: "openapi",
            targetConfiguration: {
              mcp: { openApiSchema: { s3: { uri: "s3://schemas/openapi.json" } } },
            },
          },
          {
            targetId: "smithy",
            targetConfiguration: {
              mcp: { smithyModel: { s3: { uri: "s3://schemas/service.smithy" } } },
            },
          },
          {
            targetId: "mcp-server",
            targetConfiguration: {
              mcp: {
                mcpServer: {
                  endpoint: "https://example.com/mcp",
                  mcpToolSchema: { s3: { uri: "s3://schemas/mcp.json" } },
                },
              },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
          },
          {
            targetId: "runtime",
            targetConfiguration: {
              http: {
                agentcoreRuntime: {
                  arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders",
                  schema: { source: { s3: { uri: "s3://schemas/runtime.json" } } },
                },
              },
            },
            credentialProviderConfigurations: [
              { credentialProviderType: "CALLER_IAM_CREDENTIALS" },
            ],
          },
          {
            targetId: "passthrough",
            targetConfiguration: {
              http: {
                passthrough: {
                  endpoint: "https://example.com",
                  protocolType: "CUSTOM",
                  schema: { source: { s3: { uri: "s3://schemas/http.json" } } },
                },
              },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
          },
        ],
      }),
    );

    expect(compiled.permissions.map(({ action, resource }) => `${action} ${resource}`)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_ARN}`,
      ...S3_OBJECT_ARNS.map((arn) => `s3:GetObject ${arn}`),
    ]);
  });

  test("plans API Gateway, Runtime, Knowledge Base, and Bedrock Mantle target access", () => {
    const compiled = new PolicyCompiler().compile(
      new GatewayPolicyPlanner().plan({
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "api-gateway",
            targetConfiguration: {
              mcp: {
                apiGateway: {
                  restApiId: "orders",
                  stage: "prod",
                  apiGatewayToolConfiguration: { toolFilters: [] },
                },
              },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
          },
          {
            targetId: "runtime",
            targetConfiguration: {
              http: { agentcoreRuntime: { arn: RUNTIME_ARN } },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
          },
          {
            targetId: "knowledge-base",
            targetConfiguration: {
              mcp: {
                connector: {
                  source: { connectorId: "bedrock-knowledge-bases" },
                  configurations: [
                    {
                      name: "AgenticRetrieveStream",
                      parameterValues: {
                        retrievers: [
                          {
                            configuration: {
                              knowledgeBase: { knowledgeBaseId: "KB87654321" },
                            },
                          },
                        ],
                        agenticRetrieveConfiguration: {},
                      },
                    },
                    {
                      name: "Retrieve",
                      parameterValues: { knowledgeBaseId: "KB12345678" },
                    },
                  ],
                },
              },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
          },
          {
            targetId: "mantle",
            targetConfiguration: {
              inference: { connector: { source: { connectorId: "bedrock-mantle" } } },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
          },
        ],
      }),
    );
    const permissions = compiled.permissions.map(({ action, resource }) => `${action} ${resource}`);

    expect(permissions).toEqual(
      expect.arrayContaining([
        `bedrock-agentcore:InvokeAgentRuntime ${RUNTIME_ARN}`,
        `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
        "bedrock-mantle:CallWithBearerToken *",
        `bedrock-mantle:CreateInference ${MANTLE_PROJECT_ARN}`,
        `bedrock-mantle:ListModels ${MANTLE_DEFAULT_PROJECT_ARN}`,
        "bedrock:AgenticRetrieveStream *",
        `bedrock:GetKnowledgeBase ${AGENTIC_KNOWLEDGE_BASE_ARN}`,
        `bedrock:GetKnowledgeBase ${KNOWLEDGE_BASE_ARN}`,
        `bedrock:Retrieve ${KNOWLEDGE_BASE_ARN}`,
        `execute-api:Invoke ${API_GATEWAY_ARN}`,
      ]),
    );
    expect(permissions).toHaveLength(10);
  });

  test("plans exact workload, provider, and secret access for API key and OAuth auth", () => {
    const compiled = new PolicyCompiler().compile(
      new GatewayPolicyPlanner().plan({
        gatewayArn: GATEWAY_ARN,
        workloadIdentityArn: WORKLOAD_IDENTITY_ARN,
        credentialProviders: [
          { providerArn: API_KEY_PROVIDER_ARN, secretArn: API_KEY_SECRET_ARN },
          { providerArn: OAUTH_PROVIDER_ARN, secretArn: OAUTH_SECRET_ARN },
        ],
        targets: [
          {
            targetId: "api-key",
            targetConfiguration: {
              mcp: { mcpServer: { endpoint: "https://example.com/api-key" } },
            },
            credentialProviderConfigurations: [
              {
                credentialProviderType: "API_KEY",
                credentialProvider: {
                  apiKeyCredentialProvider: {
                    providerArn: API_KEY_PROVIDER_ARN,
                    credentialLocation: "HEADER",
                    credentialParameterName: "x-api-key",
                  },
                },
              },
            ],
          },
          {
            targetId: "oauth",
            targetConfiguration: {
              mcp: { mcpServer: { endpoint: "https://example.com/oauth" } },
            },
            credentialProviderConfigurations: [
              {
                credentialProviderType: "OAUTH",
                credentialProvider: {
                  oauthCredentialProvider: {
                    providerArn: OAUTH_PROVIDER_ARN,
                    scopes: ["orders.read"],
                    grantType: "CLIENT_CREDENTIALS",
                  },
                },
              },
            ],
          },
        ],
      }),
    );
    const permissions = compiled.permissions.map(({ action, resource }) => `${action} ${resource}`);

    expect(permissions).toEqual(
      expect.arrayContaining([
        `bedrock-agentcore:GetResourceApiKey ${API_KEY_PROVIDER_ARN}`,
        `bedrock-agentcore:GetResourceOauth2Token ${OAUTH_PROVIDER_ARN}`,
        `bedrock-agentcore:GetWorkloadAccessToken ${WORKLOAD_IDENTITY_DIRECTORY_ARN}`,
        `bedrock-agentcore:GetWorkloadAccessToken ${WORKLOAD_IDENTITY_ARN}`,
        `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
        `secretsmanager:GetSecretValue ${API_KEY_SECRET_ARN}`,
        `secretsmanager:GetSecretValue ${OAUTH_SECRET_ARN}`,
      ]),
    );
    expect(permissions).toHaveLength(7);
  });

  test("does not grant target access for caller IAM or JWT passthrough", () => {
    const compiled = new PolicyCompiler().compile(
      new GatewayPolicyPlanner().plan({
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "caller-iam",
            targetConfiguration: {
              http: { agentcoreRuntime: { arn: RUNTIME_ARN } },
            },
            credentialProviderConfigurations: [
              { credentialProviderType: "CALLER_IAM_CREDENTIALS" },
            ],
          },
          {
            targetId: "jwt",
            targetConfiguration: {
              http: {
                passthrough: {
                  endpoint: "https://example.com",
                  protocolType: "CUSTOM",
                },
              },
            },
            credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
          },
        ],
      }),
    );

    expect(compiled.permissions).toEqual([
      expect.objectContaining({
        action: "bedrock-agentcore:InvokeGateway",
        resource: GATEWAY_ARN,
      }),
    ]);
  });

  test.each([
    [
      "generic SigV4 target",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "sigv4",
            targetConfiguration: {
              mcp: {
                mcpServer: {
                  endpoint: "https://example.com/mcp",
                },
              },
            },
            credentialProviderConfigurations: [
              {
                credentialProviderType: "GATEWAY_IAM_ROLE",
                credentialProvider: {
                  iamCredentialProvider: {
                    service: "example",
                  },
                },
              },
            ],
          },
        ],
      },
    ],
    [
      "generic SigV4 HTTP passthrough",
      {
        gatewayArn: GATEWAY_ARN,
        targets: [
          {
            targetId: "sigv4-http",
            targetConfiguration: {
              http: {
                passthrough: {
                  endpoint: "https://example.com",
                  protocolType: "CUSTOM",
                },
              },
            },
            credentialProviderConfigurations: [
              {
                credentialProviderType: "GATEWAY_IAM_ROLE",
                credentialProvider: {
                  iamCredentialProvider: {
                    service: "example",
                  },
                },
              },
            ],
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
