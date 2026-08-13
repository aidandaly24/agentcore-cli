import { describe, expect, test } from "bun:test";
import { PolicyCompiler } from "./executionRolePolicy";
import { HarnessPolicyPlanner } from "./harnessPolicy";

const REGION = "us-west-2";
const ACCOUNT = "123456789012";
const MEMORY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/harness_orders-abc123";
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
const BROWSER_ARN = "arn:aws:bedrock-agentcore:us-west-2:aws:browser/browser-1";
const CODE_ARN = "arn:aws:bedrock-agentcore:us-west-2:aws:code-interpreter/code-1";
const API_KEY_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/openai";
const API_KEY_SECRET = "arn:aws:secretsmanager:us-west-2:123456789012:secret:openai";
const OAUTH_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/gateway";
const OAUTH_SECRET = "arn:aws:secretsmanager:us-west-2:123456789012:secret:gateway-oauth";
const WORKLOAD_DIRECTORY =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default";
const WORKLOAD_IDENTITY = `${WORKLOAD_DIRECTORY}/workload-identity/harness_orders-*`;
const TOKEN_VAULT = "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default";

function permissions(state: Parameters<HarnessPolicyPlanner["plan"]>[0]): string[] {
  return new PolicyCompiler()
    .compile(new HarnessPolicyPlanner().plan(state))
    .permissions.map(({ action, resource }) => `${action} ${resource}`);
}

describe("HarnessPolicyPlanner", () => {
  test("plans baseline Bedrock, observability, and public image access", () => {
    const actual = permissions({
      region: REGION,
      accountId: ACCOUNT,
      harnessName: "orders",
    });

    expect(actual).toEqual(
      expect.arrayContaining([
        "bedrock:InvokeModel arn:aws:bedrock:*::foundation-model/*",
        `bedrock:InvokeModel arn:aws:bedrock:${REGION}:${ACCOUNT}:*`,
        "ecr-public:GetAuthorizationToken *",
        "sts:GetServiceBearerToken *",
        "xray:PutTraceSegments *",
        `logs:CreateLogGroup arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        "cloudwatch:PutMetricData *",
      ]),
    );
    expect(actual.some((value) => value.startsWith("bedrock-agentcore:CreateEvent "))).toBeFalse();
    expect(actual).not.toContain("logs:PutResourcePolicy *");
  });

  test("adds Bedrock Mantle only for Responses and Chat Completions formats", () => {
    const responses = permissions({
      region: REGION,
      accountId: ACCOUNT,
      harnessName: "orders",
      model: {
        bedrockModelConfig: {
          modelId: "global.anthropic.claude-sonnet-4-6",
          apiFormat: "responses",
        },
      },
    });
    const converse = permissions({
      region: REGION,
      accountId: ACCOUNT,
      harnessName: "orders",
      model: {
        bedrockModelConfig: {
          modelId: "global.anthropic.claude-sonnet-4-6",
          apiFormat: "converse_stream",
        },
      },
    });

    expect(responses).toEqual(
      expect.arrayContaining([
        `bedrock-mantle:CreateInference arn:aws:bedrock-mantle:${REGION}:${ACCOUNT}:*`,
        "bedrock-mantle:CallWithBearerToken *",
      ]),
    );
    expect(converse.some((value) => value.startsWith("bedrock-mantle:"))).toBeFalse();
  });

  test("tightens managed Memory and plans exact AgentCore tools", () => {
    const actual = permissions({
      region: REGION,
      accountId: ACCOUNT,
      harnessName: "orders",
      memory: { managedMemoryConfiguration: { arn: MEMORY_ARN } },
      tools: [
        {
          type: "agentcore_browser",
          config: { agentCoreBrowser: { browserArn: BROWSER_ARN } },
        },
        {
          type: "agentcore_code_interpreter",
          config: {
            agentCoreCodeInterpreter: { codeInterpreterArn: CODE_ARN },
          },
        },
        {
          type: "agentcore_gateway",
          config: {
            agentCoreGateway: {
              gatewayArn: GATEWAY_ARN,
              outboundAuth: { awsIam: {} },
            },
          },
        },
      ],
    });

    expect(actual).toEqual(
      expect.arrayContaining([
        `bedrock-agentcore:CreateEvent ${MEMORY_ARN}`,
        `bedrock-agentcore:StartBrowserSession ${BROWSER_ARN}`,
        `bedrock-agentcore:InvokeCodeInterpreter ${CODE_ARN}`,
        `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      ]),
    );
  });

  test("plans API key, OAuth, S3 skill, EFS, and private ECR access", () => {
    const actual = permissions({
      region: REGION,
      accountId: ACCOUNT,
      harnessName: "orders",
      memory: { disabled: {} },
      model: {
        openAiModelConfig: {
          modelId: "gpt-5",
          apiKeyArn: API_KEY_ARN,
        },
      },
      tools: [
        {
          type: "agentcore_gateway",
          config: {
            agentCoreGateway: {
              gatewayArn: GATEWAY_ARN,
              outboundAuth: {
                oauth: {
                  providerArn: OAUTH_ARN,
                  scopes: ["gateway.invoke"],
                },
              },
            },
          },
        },
      ],
      skills: [
        { s3: { uri: "s3://skills-bucket/orders/" } },
        {
          git: {
            url: "https://github.com/example/private",
            auth: { credentialArn: API_KEY_ARN },
          },
        },
      ],
      environment: {
        agentCoreRuntimeEnvironment: {
          filesystemConfigurations: [
            {
              efsAccessPoint: {
                accessPointArn:
                  "arn:aws:elasticfilesystem:us-west-2:123456789012:access-point/fsap-123",
                mountPath: "/mnt/data",
              },
            },
            {
              s3FilesAccessPoint: {
                accessPointArn:
                  "arn:aws:s3files:us-west-2:123456789012:file-system/fs-0123456789abcdef0/access-point/fsap-0123456789abcdef0",
                mountPath: "/mnt/files",
              },
            },
          ],
        },
      },
      environmentArtifact: {
        containerConfiguration: {
          containerUri: "123456789012.dkr.ecr.us-west-2.amazonaws.com/orders:v1",
        },
      },
      credentialProviders: [
        { providerArn: API_KEY_ARN, secretArn: API_KEY_SECRET },
        { providerArn: OAUTH_ARN, secretArn: OAUTH_SECRET },
      ],
    });

    expect(actual).toEqual(
      expect.arrayContaining([
        `bedrock-agentcore:GetResourceApiKey ${API_KEY_ARN}`,
        `bedrock-agentcore:GetResourceApiKey ${TOKEN_VAULT}`,
        `bedrock-agentcore:GetResourceApiKey ${WORKLOAD_DIRECTORY}`,
        `bedrock-agentcore:GetResourceApiKey ${WORKLOAD_IDENTITY}`,
        `secretsmanager:GetSecretValue ${API_KEY_SECRET}`,
        `bedrock-agentcore:GetResourceOauth2Token ${OAUTH_ARN}`,
        `bedrock-agentcore:GetResourceOauth2Token ${TOKEN_VAULT}`,
        `bedrock-agentcore:GetResourceOauth2Token ${WORKLOAD_DIRECTORY}`,
        `bedrock-agentcore:GetResourceOauth2Token ${WORKLOAD_IDENTITY}`,
        `secretsmanager:GetSecretValue ${OAUTH_SECRET}`,
        `bedrock-agentcore:GetWorkloadAccessToken ${WORKLOAD_DIRECTORY}`,
        `bedrock-agentcore:GetWorkloadAccessToken ${WORKLOAD_IDENTITY}`,
        "s3:ListBucket arn:aws:s3:::skills-bucket",
        "s3:GetObject arn:aws:s3:::skills-bucket/orders/*",
        "elasticfilesystem:ClientMount arn:aws:elasticfilesystem:us-west-2:123456789012:file-system/*",
        "s3files:ClientMount arn:aws:s3files:us-west-2:123456789012:file-system/fs-0123456789abcdef0",
        "s3files:GetFileSystem *",
        "s3files:GetMountTarget *",
        "ecr:BatchGetImage arn:aws:ecr:us-west-2:123456789012:repository/orders",
        "ecr:BatchCheckLayerAvailability arn:aws:ecr:us-west-2:123456789012:repository/orders",
      ]),
    );
    expect(actual.some((value) => value.startsWith("s3files:ClientRootAccess "))).toBeFalse();
    expect(actual.some((value) => value.startsWith("bedrock:InvokeModel "))).toBeFalse();
  });
});
