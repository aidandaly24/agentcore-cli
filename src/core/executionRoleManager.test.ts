import { describe, expect, test } from "bun:test";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { ExecutionRoleManager, ExecutionRoleTrustError } from "./executionRoleManager";

const ACCOUNT = "123456789012";

function roleArn(roleName: string): string {
  return `arn:aws:iam::${ACCOUNT}:role/${roleName}`;
}

describe("ExecutionRoleManager policy ownership", () => {
  test("recognizes only the documented AgentCore role prefixes", () => {
    const recognizedRoleNames = [
      "AgentCoreCliHarness-orders",
      "AgentCoreCliGateway-orders",
      "AgentCoreCliOnlineEval-orders",
      "AmazonBedrockAgentCoreHarnessDefaultServiceRole-orders",
      "AmazonBedrockAgentCoreGatewayDefaultServiceRole",
      "AmazonBedrockAgentCoreRuntimeDefaultServiceRole-orders",
      "AgentCoreEvalsSDK-orders",
      "AmazonBedrockAgentCoreSDKRuntime-orders",
      "AgentCoreGatewayExecutionRole",
    ];

    for (const roleName of recognizedRoleNames) {
      expect(
        ExecutionRoleManager.policyManagement({
          associatedRoleArn: roleArn(roleName),
        }),
      ).toEqual({
        mode: "managed",
        roleArn: roleArn(roleName),
        roleName,
      });
    }

    expect(
      ExecutionRoleManager.policyManagement({
        associatedRoleArn: roleArn("AgentCoreMyCdkStack-ExecutionRole-A1B2C3"),
      }),
    ).toEqual({
      mode: "external",
      reason: "unknown-role",
      roleArn: roleArn("AgentCoreMyCdkStack-ExecutionRole-A1B2C3"),
    });
  });

  test("explicit and skipped role updates are always externally managed", () => {
    const associatedRoleArn = roleArn("AgentCoreCliGateway-orders");
    const explicitRoleArn = roleArn("AgentCoreCliGateway-explicit");

    expect(
      ExecutionRoleManager.policyManagement({
        associatedRoleArn,
        explicitRoleArn,
      }),
    ).toEqual({
      mode: "external",
      reason: "explicit-role",
      roleArn: explicitRoleArn,
    });
    expect(
      ExecutionRoleManager.policyManagement({
        associatedRoleArn,
        skipPolicyUpdate: true,
      }),
    ).toEqual({
      mode: "external",
      reason: "skipped",
      roleArn: associatedRoleArn,
    });
  });

  test("creates bounded deterministic role and per-parent policy names", () => {
    expect(ExecutionRoleManager.cliRoleName("gateway", "orders")).toBe(
      "AgentCoreCliGateway-orders",
    );

    const longName = "gateway_name_".repeat(10);
    const firstLongRole = ExecutionRoleManager.cliRoleName("gateway", longName);
    const secondLongRole = ExecutionRoleManager.cliRoleName("gateway", `${longName}different`);
    expect(firstLongRole).toHaveLength(64);
    expect(firstLongRole).toMatch(/^AgentCoreCliGateway-[A-Za-z0-9+=,.@_-]+-[0-9a-f]{12}$/);
    expect(secondLongRole).not.toBe(firstLongRole);

    const firstPolicy = ExecutionRoleManager.generatedPolicyName("gateway", {
      accountId: ACCOUNT,
      region: "us-west-2",
      stableResourceKey: "gateway-abc123",
    });
    const repeatedPolicy = ExecutionRoleManager.generatedPolicyName("gateway", {
      stableResourceKey: "gateway-abc123",
      region: "us-west-2",
      accountId: ACCOUNT,
    });
    const otherPolicy = ExecutionRoleManager.generatedPolicyName("gateway", {
      accountId: ACCOUNT,
      region: "us-west-2",
      stableResourceKey: "gateway-def456",
    });

    expect(firstPolicy).toMatch(/^AgentCoreCliGatewayExecutionPolicy-[0-9a-f]{16}$/);
    expect(repeatedPolicy).toBe(firstPolicy);
    expect(otherPolicy).not.toBe(firstPolicy);
  });
});

describe("ExecutionRoleManager role lifecycle", () => {
  test("creates a missing CLI role with AgentCore trust and reports ownership", async () => {
    const sent: (CreateRoleCommand | GetRoleCommand)[] = [];
    const iam = {
      send: async (command: CreateRoleCommand | GetRoleCommand) => {
        sent.push(command);
        if (command instanceof GetRoleCommand) {
          const error = new Error("missing");
          error.name = "NoSuchEntityException";
          throw error;
        }
        return {
          Role: {
            Arn: roleArn("AgentCoreCliGateway-orders"),
            RoleName: "AgentCoreCliGateway-orders",
          },
        };
      },
    } as unknown as IAMClient;

    const role = await new ExecutionRoleManager(iam).ensureCliRole({
      primitive: "gateway",
      resourceName: "orders",
    });

    expect(role).toEqual({
      arn: roleArn("AgentCoreCliGateway-orders"),
      name: "AgentCoreCliGateway-orders",
      created: true,
    });
    expect(sent.map((command) => command.constructor.name)).toEqual([
      "GetRoleCommand",
      "CreateRoleCommand",
    ]);
    expect(JSON.parse((sent[1] as CreateRoleCommand).input.AssumeRolePolicyDocument!)).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "bedrock-agentcore.amazonaws.com" },
          Action: "sts:AssumeRole",
        },
      ],
    });
  });

  test("reuses an existing trusted role without rewriting trust", async () => {
    const sent: (CreateRoleCommand | GetRoleCommand)[] = [];
    const trust = encodeURIComponent(
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: {
              Service: ["bedrock-agentcore.amazonaws.com", "lambda.amazonaws.com"],
            },
            Action: ["sts:AssumeRole"],
          },
        ],
      }),
    );
    const iam = {
      send: async (command: CreateRoleCommand | GetRoleCommand) => {
        sent.push(command);
        return {
          Role: {
            Arn: roleArn("AgentCoreCliGateway-orders"),
            RoleName: "AgentCoreCliGateway-orders",
            AssumeRolePolicyDocument: trust,
          },
        };
      },
    } as unknown as IAMClient;

    const role = await new ExecutionRoleManager(iam).ensureCliRole({
      primitive: "gateway",
      resourceName: "orders",
    });

    expect(role.created).toBeFalse();
    expect(sent.map((command) => command.constructor.name)).toEqual(["GetRoleCommand"]);
  });

  test("rejects an existing role that AgentCore cannot assume", async () => {
    const iam = {
      send: async () => ({
        Role: {
          Arn: roleArn("AgentCoreCliGateway-orders"),
          RoleName: "AgentCoreCliGateway-orders",
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "lambda.amazonaws.com" },
                Action: "sts:AssumeRole",
              },
            ],
          }),
        },
      }),
    } as unknown as IAMClient;

    await expect(
      new ExecutionRoleManager(iam).ensureCliRole({
        primitive: "gateway",
        resourceName: "orders",
      }),
    ).rejects.toBeInstanceOf(ExecutionRoleTrustError);
  });

  test("rejects malformed trust policy documents with the role context", async () => {
    const iam = {
      send: async () => ({
        Role: {
          Arn: roleArn("AgentCoreCliGateway-orders"),
          RoleName: "AgentCoreCliGateway-orders",
          AssumeRolePolicyDocument: "not-json",
        },
      }),
    } as unknown as IAMClient;

    await expect(
      new ExecutionRoleManager(iam).ensureCliRole({
        primitive: "gateway",
        resourceName: "orders",
      }),
    ).rejects.toMatchObject({
      name: "ExecutionRoleTrustError",
      roleName: "AgentCoreCliGateway-orders",
    });
  });

  test("rejects matching Deny statements and unproven trust conditions", async () => {
    const policies = [
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
          {
            Effect: "Deny",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      },
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
          {
            Effect: "Deny",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            NotAction: "sts:TagSession",
          },
        ],
      },
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
          {
            Effect: "Deny",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "STS:Assume*",
          },
        ],
      },
      {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "bedrock-agentcore.amazonaws.com" },
            Action: "sts:AssumeRole",
            Condition: {
              StringEquals: { "aws:SourceAccount": ACCOUNT },
            },
          },
        ],
      },
    ];

    for (const policy of policies) {
      const iam = {
        send: async () => ({
          Role: {
            Arn: roleArn("AgentCoreCliGateway-orders"),
            RoleName: "AgentCoreCliGateway-orders",
            AssumeRolePolicyDocument: JSON.stringify(policy),
          },
        }),
      } as unknown as IAMClient;

      await expect(
        new ExecutionRoleManager(iam).ensureCliRole({
          primitive: "gateway",
          resourceName: "orders",
        }),
      ).rejects.toBeInstanceOf(ExecutionRoleTrustError);
    }
  });

  test("accepts standard trust conditions when the Gateway context matches", async () => {
    const gatewayArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
    const iam = {
      send: async () => ({
        Role: {
          Arn: roleArn("AmazonBedrockAgentCoreGatewayDefaultServiceRole"),
          RoleName: "AmazonBedrockAgentCoreGatewayDefaultServiceRole",
          AssumeRolePolicyDocument: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "bedrock-agentcore.amazonaws.com" },
                Action: "sts:AssumeRole",
                Condition: {
                  StringEquals: { "aws:SourceAccount": ACCOUNT },
                  ArnLike: {
                    "aws:SourceArn": "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/*",
                  },
                },
              },
            ],
          }),
        },
      }),
    } as unknown as IAMClient;

    await expect(
      new ExecutionRoleManager(iam).validateAgentCoreTrust(
        "AmazonBedrockAgentCoreGatewayDefaultServiceRole",
        {
          sourceAccount: ACCOUNT,
          sourceArn: gatewayArn,
        },
      ),
    ).resolves.toMatchObject({
      arn: roleArn("AmazonBedrockAgentCoreGatewayDefaultServiceRole"),
      created: false,
    });
    await expect(
      new ExecutionRoleManager(iam).validateAgentCoreTrust(
        "AmazonBedrockAgentCoreGatewayDefaultServiceRole",
        {
          sourceAccount: "000000000000",
          sourceArn: gatewayArn,
        },
      ),
    ).rejects.toBeInstanceOf(ExecutionRoleTrustError);
  });

  test("rolls back only a role created by the current parent create", async () => {
    const sent: (DeleteRoleCommand | DeleteRolePolicyCommand)[] = [];
    const iam = {
      send: async (command: DeleteRoleCommand | DeleteRolePolicyCommand) => {
        sent.push(command);
        return {};
      },
    } as unknown as IAMClient;
    const manager = new ExecutionRoleManager(iam);

    await manager.rollbackCreatedRole(
      {
        arn: roleArn("AgentCoreCliGateway-orders"),
        name: "AgentCoreCliGateway-orders",
        created: true,
      },
      "AgentCoreCliGatewayExecutionPolicy-a1b2c3d4",
    );
    await manager.rollbackCreatedRole(
      {
        arn: roleArn("AgentCoreCliGateway-existing"),
        name: "AgentCoreCliGateway-existing",
        created: false,
      },
      "AgentCoreCliGatewayExecutionPolicy-existing",
    );

    expect(sent.map((command) => command.constructor.name)).toEqual([
      "DeleteRolePolicyCommand",
      "DeleteRoleCommand",
    ]);
    expect((sent[0] as DeleteRolePolicyCommand).input).toEqual({
      RoleName: "AgentCoreCliGateway-orders",
      PolicyName: "AgentCoreCliGatewayExecutionPolicy-a1b2c3d4",
    });
  });

  test("retries IAM conflicts while cleaning up a failed create", async () => {
    let policyAttempts = 0;
    let roleAttempts = 0;
    const sleeps: number[] = [];
    const iam = {
      send: async (command: DeleteRoleCommand | DeleteRolePolicyCommand) => {
        if (command instanceof DeleteRolePolicyCommand && ++policyAttempts === 1) {
          const error = new Error("concurrent policy update");
          error.name = "ConcurrentModificationException";
          throw error;
        }
        if (command instanceof DeleteRoleCommand && ++roleAttempts === 1) {
          const error = new Error("policy deletion is still propagating");
          error.name = "DeleteConflictException";
          throw error;
        }
        return {};
      },
    } as unknown as IAMClient;
    const manager = new ExecutionRoleManager(iam, {
      cleanupMaxAttempts: 3,
      cleanupRetryDelayMs: 7,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await manager.rollbackCreatedRole(
      {
        arn: roleArn("AgentCoreCliGateway-orders"),
        name: "AgentCoreCliGateway-orders",
        created: true,
      },
      "AgentCoreCliGatewayExecutionPolicy-a1b2c3d4",
    );

    expect(policyAttempts).toBe(2);
    expect(roleAttempts).toBe(2);
    expect(sleeps).toEqual([7, 7]);
  });

  test("preserves both parent-create and cleanup failures", async () => {
    const iam = {
      send: async () => {
        throw new Error("cleanup failed");
      },
    } as unknown as IAMClient;
    const createError = new Error("Gateway create failed");

    const error = await new ExecutionRoleManager(iam)
      .rollbackFailedCreate(
        {
          arn: roleArn("AgentCoreCliGateway-orders"),
          name: "AgentCoreCliGateway-orders",
          created: true,
        },
        "AgentCoreCliGatewayExecutionPolicy-a1b2c3d4",
        createError,
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([
      createError,
      expect.objectContaining({ message: "cleanup failed" }),
    ]);
  });
});
