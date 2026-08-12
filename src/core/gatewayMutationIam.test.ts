import { describe, expect, test } from "bun:test";
import {
  DeleteGatewayCommand,
  DeleteGatewayTargetCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  ListGatewayTargetsCommand,
  UpdateGatewayCommand,
  UpdateGatewayTargetCommand,
  type BedrockAgentCoreControlClient,
  type GetGatewayResponse,
  type GetGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  DeleteRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { GatewayClient, GatewayTargetTerminalStateError } from "./gateway";
import { ExecutionRoleManager } from "./executionRoleManager";
import { PolicyOperationOutcomeUnknownError } from "./executionRolePolicyUpdater";
import type { AwsClients } from "./types";

const REGION = "us-west-2";
const ACCOUNT_ID = "123456789012";
const GATEWAY_ID = "orders-abc123";
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
const ROLE_NAME = "AgentCoreCliGateway-orders";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}`;
const TARGET_ID = "lambda-target";
const LAMBDA_A = "arn:aws:lambda:us-west-2:123456789012:function:orders-a";
const LAMBDA_B = "arn:aws:lambda:us-west-2:123456789012:function:orders-b";
const CUSTOMER_ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/CustomerGatewayRole`;
const POLICY_NAME = ExecutionRoleManager.generatedPolicyName("gateway", {
  accountId: ACCOUNT_ID,
  region: REGION,
  stableResourceKey: ROLE_NAME,
});

type IamCommand =
  | DeleteRolePolicyCommand
  | GetRoleCommand
  | GetRolePolicyCommand
  | ListRolePoliciesCommand
  | PutRolePolicyCommand;

function policyPermissions(document: string): string[] {
  const parsed = JSON.parse(document) as {
    Statement: { Action: string | string[]; Resource: string | string[] }[];
  };
  return parsed.Statement.flatMap((statement) => {
    const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
    const resources = Array.isArray(statement.Resource) ? statement.Resource : [statement.Resource];
    return actions.flatMap((action) => resources.map((resource) => `${action} ${resource}`));
  }).sort();
}

function lambdaTarget(
  lambdaArn: string,
  status = "READY",
  targetId = TARGET_ID,
): GetGatewayTargetResponse {
  return {
    gatewayArn: GATEWAY_ARN,
    targetId,
    createdAt: new Date("2026-08-12T00:00:00Z"),
    updatedAt: new Date("2026-08-12T00:00:00Z"),
    status: status as GetGatewayTargetResponse["status"],
    name: "orders",
    targetConfiguration: {
      mcp: {
        lambda: {
          lambdaArn,
          toolSchema: { inlinePayload: [] },
        },
      },
    },
    credentialProviderConfigurations: [{ credentialProviderType: "GATEWAY_IAM_ROLE" }],
  };
}

function managedIam(policies: Map<string, string>): IAMClient {
  return {
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
      if (command instanceof GetRolePolicyCommand) {
        const policy = policies.get(command.input.PolicyName!);
        if (!policy) {
          const error = new Error("missing");
          error.name = "NoSuchEntityException";
          throw error;
        }
        return { PolicyDocument: policy };
      }
      if (command instanceof PutRolePolicyCommand) {
        policies.set(command.input.PolicyName!, command.input.PolicyDocument!);
        return {};
      }
      if (command instanceof DeleteRolePolicyCommand) {
        policies.delete(command.input.PolicyName!);
        return {};
      }
      throw new Error("unexpected IAM command");
    },
  } as unknown as IAMClient;
}

describe("GatewayClient managed Target IAM reconciliation", () => {
  test("stages old and new Lambda permissions and tightens after Target update", async () => {
    const policies = new Map([
      [
        POLICY_NAME,
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "bedrock-agentcore:InvokeGateway",
              Resource: GATEWAY_ARN,
            },
            {
              Effect: "Allow",
              Action: "lambda:InvokeFunction",
              Resource: LAMBDA_A,
            },
          ],
        }),
      ],
    ]);
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
    let target = lambdaTarget(LAMBDA_A);
    let updateObserved = false;
    let failNextUpdate = false;
    let timeoutNextUpdate = false;
    const control = {
      send: async (
        command:
          | GetGatewayCommand
          | GetGatewayTargetCommand
          | ListGatewayTargetsCommand
          | UpdateGatewayTargetCommand,
      ) => {
        if (command instanceof GetGatewayCommand) return gateway;
        if (command instanceof ListGatewayTargetsCommand) {
          return { items: [{ targetId: TARGET_ID, name: "orders", status: target.status }] };
        }
        if (command instanceof GetGatewayTargetCommand) {
          if (updateObserved && target.status === "UPDATING") {
            target = lambdaTarget(LAMBDA_B);
          }
          return target;
        }

        expect(policyPermissions(policies.get(POLICY_NAME)!)).toEqual([
          `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
          `lambda:InvokeFunction ${LAMBDA_A}`,
          `lambda:InvokeFunction ${LAMBDA_B}`,
        ]);
        updateObserved = true;
        if (timeoutNextUpdate) {
          const error = new Error("update response timed out");
          error.name = "TimeoutError";
          throw error;
        }
        if (failNextUpdate) {
          target = {
            ...lambdaTarget(LAMBDA_A, "UPDATE_UNSUCCESSFUL"),
            statusReasons: ["target rejected replacement"],
          };
          return lambdaTarget(LAMBDA_A, "UPDATING");
        }
        target = lambdaTarget(LAMBDA_B, "UPDATING");
        return target;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => managedIam(policies),
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.updateGatewayTarget(
        {
          gatewayId: GATEWAY_ID,
          targetId: TARGET_ID,
          targetConfiguration: lambdaTarget(LAMBDA_B).targetConfiguration,
        },
        { region: REGION },
      ),
    ).resolves.toMatchObject({ status: "UPDATING" });

    expect(updateObserved).toBeTrue();
    expect(policyPermissions(policies.get(POLICY_NAME)!)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_B}`,
    ]);

    failNextUpdate = true;
    await expect(
      client.updateGatewayTarget(
        {
          gatewayId: GATEWAY_ID,
          targetId: TARGET_ID,
          targetConfiguration: lambdaTarget(LAMBDA_A).targetConfiguration,
        },
        { region: REGION },
      ),
    ).rejects.toBeInstanceOf(GatewayTargetTerminalStateError);
    expect(policyPermissions(policies.get(POLICY_NAME)!)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_B}`,
    ]);

    failNextUpdate = false;
    timeoutNextUpdate = true;
    target = lambdaTarget(LAMBDA_B);
    const error = await client
      .updateGatewayTarget(
        {
          gatewayId: GATEWAY_ID,
          targetId: TARGET_ID,
          targetConfiguration: lambdaTarget(LAMBDA_A).targetConfiguration,
        },
        { region: REGION },
      )
      .catch((caught) => caught);
    expect(error).toBeInstanceOf(PolicyOperationOutcomeUnknownError);
    expect(policyPermissions(policies.get(POLICY_NAME)!)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_A}`,
      `lambda:InvokeFunction ${LAMBDA_B}`,
    ]);
  });

  test("removes a shared Target grant only after its final owner is deleted", async () => {
    const policies = new Map([
      [
        POLICY_NAME,
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "bedrock-agentcore:InvokeGateway",
              Resource: GATEWAY_ARN,
            },
            {
              Effect: "Allow",
              Action: "lambda:InvokeFunction",
              Resource: LAMBDA_A,
            },
          ],
        }),
      ],
    ]);
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
    const targets = new Map([
      ["target-a", lambdaTarget(LAMBDA_A, "READY", "target-a")],
      ["target-b", lambdaTarget(LAMBDA_A, "READY", "target-b")],
    ]);
    const deleting = new Set<string>();
    const control = {
      send: async (
        command:
          | DeleteGatewayTargetCommand
          | GetGatewayCommand
          | GetGatewayTargetCommand
          | ListGatewayTargetsCommand,
      ) => {
        if (command instanceof GetGatewayCommand) return gateway;
        if (command instanceof ListGatewayTargetsCommand) {
          return {
            items: [...targets.values()].map((target) => ({
              targetId: target.targetId,
              name: target.name,
              status: target.status,
            })),
          };
        }
        if (command instanceof GetGatewayTargetCommand) {
          const targetId = command.input.targetId!;
          if (deleting.delete(targetId)) targets.delete(targetId);
          const target = targets.get(targetId);
          if (!target) {
            const error = new Error("missing");
            error.name = "ResourceNotFoundException";
            throw error;
          }
          return target;
        }

        expect(policyPermissions(policies.get(POLICY_NAME)!)).toContain(
          `lambda:InvokeFunction ${LAMBDA_A}`,
        );
        deleting.add(command.input.targetId!);
        return {
          gatewayArn: GATEWAY_ARN,
          targetId: command.input.targetId,
          status: "DELETING",
        };
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => managedIam(policies),
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await client.deleteGatewayTarget(GATEWAY_ID, "target-a", { region: REGION });
    expect(policyPermissions(policies.get(POLICY_NAME)!)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `lambda:InvokeFunction ${LAMBDA_A}`,
    ]);

    await client.deleteGatewayTarget(GATEWAY_ID, "target-b", { region: REGION });
    expect(policyPermissions(policies.get(POLICY_NAME)!)).toEqual([
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
    ]);
  });

  test("removes only the generated policy after a Gateway is deleted", async () => {
    const policies = new Map([
      [
        POLICY_NAME,
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "bedrock-agentcore:InvokeGateway",
              Resource: GATEWAY_ARN,
            },
          ],
        }),
      ],
      [
        "CustomerPolicy",
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "s3:GetObject",
              Resource: "arn:aws:s3:::customer/*",
            },
          ],
        }),
      ],
    ]);
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
    let deleting = false;
    const control = {
      send: async (command: DeleteGatewayCommand | GetGatewayCommand) => {
        if (command instanceof DeleteGatewayCommand) {
          expect(policies.has(POLICY_NAME)).toBeTrue();
          deleting = true;
          return { gatewayId: GATEWAY_ID, status: "DELETING" };
        }
        if (deleting) {
          const error = new Error("missing");
          error.name = "ResourceNotFoundException";
          throw error;
        }
        return gateway;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => managedIam(policies),
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(client.deleteGateway(GATEWAY_ID, { region: REGION })).resolves.toEqual({
      gatewayId: GATEWAY_ID,
      status: "DELETING",
    });
    expect(policies.has(POLICY_NAME)).toBeFalse();
    expect(policies.has("CustomerPolicy")).toBeTrue();
  });

  test("does not mutate IAM or AgentCore when Target inventory is incomplete", async () => {
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
    const currentTarget = lambdaTarget(LAMBDA_A);
    let updateCalled = false;
    const control = {
      send: async (
        command:
          | GetGatewayCommand
          | GetGatewayTargetCommand
          | ListGatewayTargetsCommand
          | UpdateGatewayTargetCommand,
      ) => {
        if (command instanceof GetGatewayCommand) return gateway;
        if (command instanceof GetGatewayTargetCommand) return currentTarget;
        if (command instanceof ListGatewayTargetsCommand) {
          return {
            items: [{ targetId: TARGET_ID, name: "orders", status: "READY" }],
            nextToken: "repeated",
          };
        }
        updateCalled = true;
        return currentTarget;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => {
          throw new Error("IAM must not be requested for incomplete inventory");
        },
      } as unknown as AwsClients,
      { waitDelayMs: 0 },
    );

    await expect(
      client.updateGatewayTarget(
        {
          gatewayId: GATEWAY_ID,
          targetId: TARGET_ID,
          targetConfiguration: lambdaTarget(LAMBDA_B).targetConfiguration,
        },
        { region: REGION },
      ),
    ).rejects.toThrow(/repeated Target pagination token/);
    expect(updateCalled).toBeFalse();
  });

  test("skipRolePolicyUpdate bypasses IAM for a recognized role", async () => {
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
    let target = lambdaTarget(LAMBDA_A);
    let updateCalled = false;
    const control = {
      send: async (
        command: GetGatewayCommand | GetGatewayTargetCommand | UpdateGatewayTargetCommand,
      ) => {
        if (command instanceof GetGatewayCommand) return gateway;
        if (command instanceof GetGatewayTargetCommand) return target;
        updateCalled = true;
        target = lambdaTarget(LAMBDA_B);
        return lambdaTarget(LAMBDA_B, "UPDATING");
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => {
          throw new Error("IAM must not be requested when role policy update is skipped");
        },
      } as unknown as AwsClients,
      { waitDelayMs: 0 },
    );

    await expect(
      client.updateGatewayTarget(
        {
          gatewayId: GATEWAY_ID,
          targetId: TARGET_ID,
          targetConfiguration: lambdaTarget(LAMBDA_B).targetConfiguration,
          skipRolePolicyUpdate: true,
        },
        { region: REGION },
      ),
    ).resolves.toMatchObject({ status: "UPDATING" });
    expect(updateCalled).toBeTrue();
  });

  test("switching to an explicit role cleans only the old generated policy", async () => {
    const policies = new Map([
      [
        POLICY_NAME,
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "bedrock-agentcore:InvokeGateway",
              Resource: GATEWAY_ARN,
            },
          ],
        }),
      ],
      [
        "CustomerPolicy",
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: "s3:GetObject",
              Resource: "arn:aws:s3:::customer/*",
            },
          ],
        }),
      ],
    ]);
    const current: GetGatewayResponse = {
      gatewayArn: GATEWAY_ARN,
      gatewayId: GATEWAY_ID,
      createdAt: new Date("2026-08-12T00:00:00Z"),
      updatedAt: new Date("2026-08-12T00:00:00Z"),
      status: "READY",
      name: "orders",
      roleArn: ROLE_ARN,
      authorizerType: "NONE",
    };
    const ready: GetGatewayResponse = {
      ...current,
      roleArn: CUSTOMER_ROLE_ARN,
      description: "customer managed",
    };
    let updated = false;
    const control = {
      send: async (command: GetGatewayCommand | UpdateGatewayCommand) => {
        if (command instanceof GetGatewayCommand) return updated ? ready : current;
        expect(policies.has(POLICY_NAME)).toBeTrue();
        updated = true;
        return { ...ready, status: "UPDATING" };
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => managedIam(policies),
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.updateGateway(
        {
          id: GATEWAY_ID,
          roleArn: CUSTOMER_ROLE_ARN,
          description: "customer managed",
        },
        { region: REGION },
      ),
    ).resolves.toMatchObject({ status: "UPDATING", roleArn: CUSTOMER_ROLE_ARN });
    expect(policies.has(POLICY_NAME)).toBeFalse();
    expect(policies.has("CustomerPolicy")).toBeTrue();
  });
});
