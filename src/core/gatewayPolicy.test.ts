import { expect, test } from "bun:test";
import { gatewayPolicy } from "./gatewayPolicy";

const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders";
const ENGINE_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders";
const LAMBDA_ARN = "arn:aws:lambda:us-west-2:123456789012:function:orders";
const INTERCEPTOR_ARN = "arn:aws:lambda:us-west-2:123456789012:function:interceptor";
const TRANSFORM_ARN = "arn:aws:lambda:us-west-2:123456789012:function:transform";
const WORKLOAD_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default/workload-identity/orders";
const API_KEY_PROVIDER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/orders";
const OAUTH_PROVIDER_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/orders";
const API_KEY_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:api-key";
const OAUTH_SECRET_ARN = "arn:aws:secretsmanager:us-west-2:123456789012:secret:oauth";

test("builds exact grants for every inferable Gateway permission family", () => {
  expect(
    gatewayPolicy({
      gatewayArn: GATEWAY_ARN,
      workloadIdentityArn: WORKLOAD_ARN,
      policyEngineArn: ENGINE_ARN,
      credentialSecrets: new Map([
        [API_KEY_PROVIDER_ARN, API_KEY_SECRET_ARN],
        [OAUTH_PROVIDER_ARN, OAUTH_SECRET_ARN],
      ]),
      interceptorConfigurations: [
        {
          interceptor: { lambda: { arn: INTERCEPTOR_ARN } },
          interceptionPoints: ["REQUEST"],
        },
      ],
      customTransformConfiguration: { lambda: { arn: TRANSFORM_ARN } },
      targets: [
        {
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
          targetConfiguration: {
            mcp: {
              connector: {
                source: { connectorId: "web-search" },
              },
            },
          },
        },
        {
          targetConfiguration: {
            mcp: {
              connector: {
                source: { connectorId: "bedrock-knowledge-bases" },
                configurations: [
                  {
                    name: "Retrieve",
                    parameterValues: { knowledgeBaseId: "KB12345678" },
                  },
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
                    },
                  },
                ],
              },
            },
          },
        },
        {
          targetConfiguration: {
            inference: {
              connector: { source: { connectorId: "bedrock-mantle" } },
            },
          },
        },
        {
          targetConfiguration: {
            mcp: {
              apiGateway: {
                restApiId: "api123",
                stage: "prod",
                apiGatewayToolConfiguration: { toolFilters: [] },
              },
            },
          },
        },
        {
          targetConfiguration: {
            http: {
              agentcoreRuntime: {
                arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders",
                schema: { source: { s3: { uri: "s3://schemas/runtime.json" } } },
              },
            },
          },
          credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
        },
        {
          targetConfiguration: {
            mcp: {
              mcpServer: {
                endpoint: "https://example.test/mcp",
                mcpToolSchema: { s3: { uri: "s3://schemas/mcp.json" } },
              },
            },
          },
          credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
        },
        {
          targetConfiguration: {
            mcp: { mcpServer: { endpoint: "https://example.test/api-key" } },
          },
          credentialProviderConfigurations: [
            {
              credentialProviderType: "API_KEY",
              credentialProvider: {
                apiKeyCredentialProvider: {
                  providerArn: API_KEY_PROVIDER_ARN,
                },
              },
            },
          ],
        },
        {
          targetConfiguration: {
            mcp: { mcpServer: { endpoint: "https://example.test/oauth" } },
          },
          credentialProviderConfigurations: [
            {
              credentialProviderType: "OAUTH",
              credentialProvider: {
                oauthCredentialProvider: {
                  providerArn: OAUTH_PROVIDER_ARN,
                  scopes: ["orders.read"],
                  grantType: "AUTHORIZATION_CODE",
                },
              },
            },
          ],
        },
      ],
    }),
  ).toEqual([
    {
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: [INTERCEPTOR_ARN],
    },
    {
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: [TRANSFORM_ARN],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:InvokeGateway"],
      Resource: [GATEWAY_ARN],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetPolicyEngine"],
      Resource: [ENGINE_ARN],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
      Resource: [ENGINE_ARN, GATEWAY_ARN],
    },
    {
      Effect: "Allow",
      Action: ["lambda:InvokeFunction"],
      Resource: [LAMBDA_ARN],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:InvokeWebSearch"],
      Resource: [
        "arn:aws:bedrock-agentcore::aws:tool/web-search.v1",
        "arn:aws:bedrock-agentcore:us-west-2:aws:tool/web-search.v1",
      ],
    },
    {
      Effect: "Allow",
      Action: ["bedrock:GetKnowledgeBase"],
      Resource: [
        "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB12345678",
        "arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB87654321",
      ],
    },
    {
      Effect: "Allow",
      Action: ["bedrock:Retrieve"],
      Resource: ["arn:aws:bedrock:us-west-2:123456789012:knowledge-base/KB12345678"],
    },
    {
      Effect: "Allow",
      Action: ["bedrock:AgenticRetrieveStream"],
      Resource: ["*"],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-mantle:CreateInference"],
      Resource: ["arn:aws:bedrock-mantle:us-west-2:123456789012:project/*"],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-mantle:ListModels"],
      Resource: ["arn:aws:bedrock-mantle:us-west-2:123456789012:project/default"],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-mantle:CallWithBearerToken"],
      Resource: ["*"],
    },
    {
      Effect: "Allow",
      Action: ["execute-api:Invoke"],
      Resource: ["arn:aws:execute-api:us-west-2:123456789012:api123/prod/*/*"],
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: ["arn:aws:s3:::schemas/runtime.json"],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:InvokeAgentRuntime"],
      Resource: ["arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/orders"],
    },
    {
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: ["arn:aws:s3:::schemas/mcp.json"],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetWorkloadAccessToken"],
      Resource: [
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default",
        WORKLOAD_ARN,
      ],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetResourceApiKey"],
      Resource: [
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default",
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default",
        WORKLOAD_ARN,
        API_KEY_PROVIDER_ARN,
      ],
    },
    {
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: [API_KEY_SECRET_ARN],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
      Resource: [
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default",
        WORKLOAD_ARN,
      ],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetResourceOauth2Token"],
      Resource: [
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default",
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default",
        WORKLOAD_ARN,
        OAUTH_PROVIDER_ARN,
      ],
    },
    {
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: [OAUTH_SECRET_ARN],
    },
  ]);
});

test("rejects an IAM-signed external endpoint whose permissions cannot be inferred", () => {
  expect(() =>
    gatewayPolicy({
      gatewayArn: GATEWAY_ARN,
      targets: [
        {
          targetConfiguration: {
            http: {
              passthrough: {
                endpoint: "https://example.test",
                protocolType: "CUSTOM",
              },
            },
          },
          credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
        },
      ],
    }),
  ).toThrow(/manage this role externally/);
});

test("stages an account-scoped Gateway wildcard before create returns its ARN", () => {
  expect(gatewayPolicy({ policyEngineArn: ENGINE_ARN })).toEqual([
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:GetPolicyEngine"],
      Resource: [ENGINE_ARN],
    },
    {
      Effect: "Allow",
      Action: ["bedrock-agentcore:AuthorizeAction", "bedrock-agentcore:PartiallyAuthorizeActions"],
      Resource: [ENGINE_ARN, "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/*"],
    },
  ]);
});
