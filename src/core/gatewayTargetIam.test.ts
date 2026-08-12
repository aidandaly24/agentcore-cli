import { describe, expect, test } from "bun:test";
import {
  CreateGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  ListGatewayTargetsCommand,
  type BedrockAgentCoreControlClient,
  type GetGatewayResponse,
  type GetGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  GetRoleCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { ExecutionRoleManager } from "./executionRoleManager";
import { PolicyCompiler } from "./executionRolePolicy";
import { GatewayPolicyPlanner } from "./gatewayPolicy";
import type { AwsClients } from "./types";
import { GatewayClient } from "./gateway";

const REGION = "us-west-2";
const ACCOUNT_ID = "123456789012";
const ROLE_NAME = "AgentCoreCliGateway-orders";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}`;
const GATEWAY_ID = "orders-abc123";
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
const LAMBDA_ARN = "arn:aws:lambda:us-west-2:123456789012:function:orders";
const WEB_SEARCH_ARN = "arn:aws:bedrock-agentcore::aws:tool/web-search.v1";
const REGIONAL_WEB_SEARCH_ARN = "arn:aws:bedrock-agentcore:us-west-2:aws:tool/web-search.v1";
const POLICY_NAME = ExecutionRoleManager.generatedPolicyName("gateway", {
  accountId: ACCOUNT_ID,
  region: REGION,
  stableResourceKey: ROLE_NAME,
});

type IamCommand =
  GetRoleCommand | GetRolePolicyCommand | ListRolePoliciesCommand | PutRolePolicyCommand;

function permissions(document: string): string[] {
  const parsed = JSON.parse(document) as {
    Statement: { Action: string[]; Resource: string[] }[];
  };
  return parsed.Statement.flatMap((statement) =>
    statement.Action.flatMap((action) =>
      statement.Resource.map((resource) => `${action} ${resource}`),
    ),
  ).sort();
}

describe("GatewayClient Target IAM reconciliation", () => {
  test("stages and finalizes exact Lambda permission on a recognized role", async () => {
    const planner = new GatewayPolicyPlanner();
    const policies = new Map([
      [
        POLICY_NAME,
        new PolicyCompiler().compile(planner.plan({ gatewayArn: GATEWAY_ARN, targets: [] })).json,
      ],
    ]);
    const iam = {
      send: async (command: IamCommand) => {
        if (command instanceof GetRoleCommand) {
          return {
            Role: {
              RoleName: ROLE_NAME,
              Arn: ROLE_ARN,
              AssumeRolePolicyDocument: JSON.stringify({
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "bedrock-agentcore.amazonaws.com" },
                    Action: "sts:AssumeRole",
                  },
                ],
              }),
            },
          };
        }
        if (command instanceof ListRolePoliciesCommand) {
          return { PolicyNames: [...policies.keys()], IsTruncated: false };
        }
        if (command instanceof PutRolePolicyCommand) {
          policies.set(command.input.PolicyName!, command.input.PolicyDocument!);
          return {};
        }
        if (command instanceof GetRolePolicyCommand) {
          return { PolicyDocument: policies.get(command.input.PolicyName!) };
        }
        throw new Error("unexpected IAM command");
      },
    } as unknown as IAMClient;

    const gateway: GetGatewayResponse = {
      gatewayArn: GATEWAY_ARN,
      gatewayId: GATEWAY_ID,
      createdAt: new Date("2026-08-12T00:00:00Z"),
      updatedAt: new Date("2026-08-12T00:00:00Z"),
      status: "READY",
      name: "orders",
      roleArn: ROLE_ARN,
      authorizerType: "NONE",
    };
    const lambdaTarget: GetGatewayTargetResponse = {
      gatewayArn: GATEWAY_ARN,
      targetId: "lambda-target",
      createdAt: new Date("2026-08-12T00:00:00Z"),
      updatedAt: new Date("2026-08-12T00:00:00Z"),
      status: "READY",
      name: "lambda",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: LAMBDA_ARN,
            toolSchema: { inlinePayload: [] },
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    };
    const webSearchTarget: GetGatewayTargetResponse = {
      gatewayArn: GATEWAY_ARN,
      targetId: "web-search-target",
      createdAt: new Date("2026-08-12T00:00:00Z"),
      updatedAt: new Date("2026-08-12T00:00:00Z"),
      status: "READY",
      name: "web-search",
      targetConfiguration: {
        mcp: {
          connector: {
            source: { connectorId: "web-search" },
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
    };
    const targets: GetGatewayTargetResponse[] = [];
    const listedTokens: (string | undefined)[] = [];
    const control = {
      send: async (
        command:
          | CreateGatewayTargetCommand
          | GetGatewayCommand
          | GetGatewayTargetCommand
          | ListGatewayTargetsCommand,
      ) => {
        if (command instanceof GetGatewayCommand) return gateway;
        if (command instanceof ListGatewayTargetsCommand) {
          listedTokens.push(command.input.nextToken);
          if (targets.length > 1) {
            return command.input.nextToken
              ? {
                  items: [
                    {
                      targetId: targets[1]!.targetId,
                      name: targets[1]!.name,
                      status: targets[1]!.status,
                    },
                  ],
                }
              : {
                  items: [
                    {
                      targetId: targets[0]!.targetId,
                      name: targets[0]!.name,
                      status: targets[0]!.status,
                    },
                  ],
                  nextToken: "page-2",
                };
          }
          return {
            items: targets.map((target) => ({
              targetId: target.targetId,
              name: target.name,
              status: target.status,
            })),
          };
        }
        if (command instanceof GetGatewayTargetCommand) {
          return targets.find((target) => target.targetId === command.input.targetId);
        }
        if (command instanceof CreateGatewayTargetCommand) {
          const staged = permissions(policies.get(POLICY_NAME)!);
          expect(staged).toContain(`bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`);
          if (command.input.targetConfiguration?.mcp?.lambda) {
            expect(staged).toContain(`lambda:InvokeFunction ${LAMBDA_ARN}`);
            targets.push(lambdaTarget);
            return { ...lambdaTarget, status: "CREATING" };
          }
          expect(staged).toContain(`lambda:InvokeFunction ${LAMBDA_ARN}`);
          expect(staged).toContain(`bedrock-agentcore:InvokeWebSearch ${WEB_SEARCH_ARN}`);
          expect(staged).toContain(`bedrock-agentcore:InvokeWebSearch ${REGIONAL_WEB_SEARCH_ARN}`);
          targets.push(webSearchTarget);
          return { ...webSearchTarget, status: "CREATING" };
        }
        throw new Error("unexpected control command");
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => iam,
      } as unknown as AwsClients,
      {
        policyUpdater: {
          propagationDelayMs: 0,
          retryDelayMs: 0,
        },
        waitDelayMs: 0,
      },
    );

    const lambdaResult = await client.createGatewayTarget(
      {
        gatewayIdentifier: GATEWAY_ID,
        name: "lambda",
        targetConfiguration: lambdaTarget.targetConfiguration!,
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      },
      { region: REGION },
    );

    expect(lambdaResult).toEqual({
      response: { ...lambdaTarget, status: "CREATING" },
    });
    expect(permissions(policies.get(POLICY_NAME)!)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_ARN}`,
    ]);

    const webSearchResult = await client.createGatewayTarget(
      {
        gatewayIdentifier: GATEWAY_ID,
        name: "web-search",
        targetConfiguration: webSearchTarget.targetConfiguration!,
        credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
      },
      { region: REGION },
    );

    expect(webSearchResult).toEqual({
      response: { ...webSearchTarget, status: "CREATING" },
    });
    expect(permissions(policies.get(POLICY_NAME)!)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `bedrock-agentcore:InvokeWebSearch ${WEB_SEARCH_ARN}`,
      `bedrock-agentcore:InvokeWebSearch ${REGIONAL_WEB_SEARCH_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_ARN}`,
    ]);
    expect(listedTokens).toContain("page-2");
  });

  test("returns pending OAuth authorization data for an external role", async () => {
    const customerRoleArn = `arn:aws:iam::${ACCOUNT_ID}:role/CustomerGatewayRole`;
    const gateway: GetGatewayResponse = {
      gatewayArn: GATEWAY_ARN,
      gatewayId: GATEWAY_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "READY",
      name: "orders",
      roleArn: customerRoleArn,
      authorizerType: "NONE",
    };
    const created = {
      gatewayArn: GATEWAY_ARN,
      targetId: "oauth-target",
      createdAt: new Date(),
      updatedAt: new Date(),
      status: "CREATING",
      name: "oauth",
      targetConfiguration: {
        mcp: { mcpServer: { endpoint: "https://example.com/mcp" } },
      },
    } as GetGatewayTargetResponse;
    const pending = {
      ...created,
      status: "CREATE_PENDING_AUTH",
      authorizationData: {
        oauth2: {
          authorizationUrl: "https://example.com/authorize",
          userId: "user-1",
        },
      },
    } as GetGatewayTargetResponse;
    const control = {
      send: async (
        command: CreateGatewayTargetCommand | GetGatewayCommand | GetGatewayTargetCommand,
      ) => {
        if (command instanceof GetGatewayCommand) return gateway;
        if (command instanceof CreateGatewayTargetCommand) return created;
        return pending;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => {
          throw new Error("IAM must not be requested");
        },
      } as unknown as AwsClients,
      { waitAttempts: 2, waitDelayMs: 0 },
    );

    const result = await client.createGatewayTarget(
      {
        gatewayIdentifier: GATEWAY_ID,
        name: "oauth",
        targetConfiguration: created.targetConfiguration!,
        credentialProviderConfigurations: [{ credentialProviderType: "OAUTH" }],
      },
      { region: REGION },
    );
    expect(result).toMatchObject({
      response: {
        status: "CREATE_PENDING_AUTH",
        authorizationData: {
          oauth2: {
            authorizationUrl: "https://example.com/authorize",
          },
        },
      },
      rolePolicyWarning: {
        reason: "unknown-role",
        roleArn: customerRoleArn,
      },
    });
  });
});
