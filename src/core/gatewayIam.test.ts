import { describe, expect, test } from "bun:test";
import {
  CreateGatewayCommand,
  GetGatewayCommand,
  ListGatewaysCommand,
  type BedrockAgentCoreControlClient,
  type CreateGatewayResponse,
  type GetGatewayResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import type { AwsClients } from "./types";
import { GatewayClient, GatewayTerminalStateError } from "./gateway";
import { PolicyFinalizationError } from "./executionRolePolicyUpdater";
import { ExecutionRoleManager } from "./executionRoleManager";

const REGION = "us-west-2";
const ACCOUNT_ID = "123456789012";
const ROLE_NAME = "AgentCoreCliGateway-orders";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}`;
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/orders-abc123";
const POLICY_ENGINE_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/orders";

type IamCommand =
  | CreateRoleCommand
  | DeleteRoleCommand
  | DeleteRolePolicyCommand
  | GetRoleCommand
  | GetRolePolicyCommand
  | ListRolePoliciesCommand
  | PutRolePolicyCommand;

function policyPermissions(document: string): string[] {
  const parsed = JSON.parse(document) as {
    Statement: { Action: string[]; Resource: string[] }[];
  };
  return parsed.Statement.flatMap((statement) =>
    statement.Action.flatMap((action) =>
      statement.Resource.map((resource) => `${action} ${resource}`),
    ),
  ).sort();
}

describe("GatewayClient managed execution role", () => {
  test("creates the role, stages Policy Engine access, waits, and finalizes exact Gateway access", async () => {
    const events: string[] = [];
    const policies = new Map<string, string>();
    let roleExists = false;
    const iam = {
      send: async (command: IamCommand) => {
        events.push(command.constructor.name);
        if (command instanceof GetRoleCommand) {
          if (!roleExists) {
            const error = new Error("missing");
            error.name = "NoSuchEntityException";
            throw error;
          }
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
        if (command instanceof CreateRoleCommand) {
          roleExists = true;
          return { Role: { RoleName: ROLE_NAME, Arn: ROLE_ARN } };
        }
        if (command instanceof ListRolePoliciesCommand) {
          return { PolicyNames: [...policies.keys()], IsTruncated: false };
        }
        if (command instanceof PutRolePolicyCommand) {
          policies.set(command.input.PolicyName!, command.input.PolicyDocument!);
          return {};
        }
        if (command instanceof GetRolePolicyCommand) {
          const document = policies.get(command.input.PolicyName!);
          if (!document) {
            const error = new Error("missing");
            error.name = "NoSuchEntityException";
            throw error;
          }
          return { PolicyDocument: document };
        }
        if (command instanceof DeleteRolePolicyCommand) {
          policies.delete(command.input.PolicyName!);
          return {};
        }
        if (command instanceof DeleteRoleCommand) {
          roleExists = false;
          return {};
        }
        throw new Error("unexpected IAM command");
      },
    } as unknown as IAMClient;

    const created: CreateGatewayResponse = {
      gatewayArn: GATEWAY_ARN,
      gatewayId: "orders-abc123",
      createdAt: new Date("2026-08-12T00:00:00Z"),
      updatedAt: new Date("2026-08-12T00:00:00Z"),
      status: "CREATING",
      name: "orders",
      roleArn: ROLE_ARN,
      authorizerType: "NONE",
    };
    const ready: GetGatewayResponse = {
      ...created,
      status: "READY",
      policyEngineConfiguration: {
        arn: POLICY_ENGINE_ARN,
        mode: "ENFORCE",
      },
    };
    let createInput: CreateGatewayCommand["input"] | undefined;
    const createTokens: string[] = [];
    const sleeps: number[] = [];
    const control = {
      send: async (command: CreateGatewayCommand | GetGatewayCommand) => {
        events.push(command.constructor.name);
        if (command instanceof CreateGatewayCommand) {
          createInput = command.input;
          createTokens.push(command.input.clientToken!);
          const staged = [...policies.values()][0];
          expect(staged).toBeDefined();
          expect(policyPermissions(staged!)).toEqual([
            `bedrock-agentcore:AuthorizeAction arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/*`,
            `bedrock-agentcore:AuthorizeAction ${POLICY_ENGINE_ARN}`,
            `bedrock-agentcore:GetPolicyEngine ${POLICY_ENGINE_ARN}`,
            `bedrock-agentcore:PartiallyAuthorizeActions arn:aws:bedrock-agentcore:${REGION}:${ACCOUNT_ID}:gateway/*`,
            `bedrock-agentcore:PartiallyAuthorizeActions ${POLICY_ENGINE_ARN}`,
          ]);
          if (createTokens.length === 1) {
            const error = new Error("execution role cannot be assumed yet");
            error.name = "ValidationException";
            throw error;
          }
          return created;
        }
        return ready;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const clients = {
      control: () => control,
      iam: () => iam,
    } as unknown as AwsClients;
    const gateway = new GatewayClient(clients, {
      policyUpdater: {
        retryDelayMs: 0,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
      waitDelayMs: 0,
    });

    const response = await gateway.createGateway(
      {
        name: "orders",
        roleArn: undefined,
        authorizerType: "NONE",
        policyEngineConfiguration: {
          arn: POLICY_ENGINE_ARN,
          mode: "ENFORCE",
        },
      },
      { region: REGION },
    );

    expect(response).toEqual(created);
    expect(createInput).toMatchObject({
      name: "orders",
      roleArn: ROLE_ARN,
      authorizerType: "NONE",
      policyEngineConfiguration: {
        arn: POLICY_ENGINE_ARN,
        mode: "ENFORCE",
      },
      clientToken: expect.any(String),
    });
    expect(events.indexOf("PutRolePolicyCommand")).toBeLessThan(
      events.indexOf("CreateGatewayCommand"),
    );
    expect(createTokens).toHaveLength(2);
    expect(createTokens[0]).toBe(createTokens[1]);
    expect(sleeps).toEqual([10_000, 2_000, 10_000]);
    expect(events).toContain("GetGatewayCommand");
    expect(roleExists).toBeTrue();
    expect(policies.size).toBe(1);
    const [policyName, finalPolicy] = [...policies.entries()][0]!;
    expect(policyName).toMatch(/^AgentCoreCliGatewayExecutionPolicy-[0-9a-f]{16}$/);
    expect(policyPermissions(finalPolicy)).toEqual([
      `bedrock-agentcore:AuthorizeAction ${GATEWAY_ARN}`,
      `bedrock-agentcore:AuthorizeAction ${POLICY_ENGINE_ARN}`,
      `bedrock-agentcore:GetPolicyEngine ${POLICY_ENGINE_ARN}`,
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
      `bedrock-agentcore:PartiallyAuthorizeActions ${GATEWAY_ARN}`,
      `bedrock-agentcore:PartiallyAuthorizeActions ${POLICY_ENGINE_ARN}`,
    ]);
  });

  test("removes a newly created role after Gateway reaches FAILED", async () => {
    let roleExists = false;
    const policies = new Map<string, string>();
    const iam = {
      send: async (command: IamCommand) => {
        if (command instanceof GetRoleCommand) {
          const error = new Error("missing");
          error.name = "NoSuchEntityException";
          throw error;
        }
        if (command instanceof CreateRoleCommand) {
          roleExists = true;
          return { Role: { RoleName: ROLE_NAME, Arn: ROLE_ARN } };
        }
        if (command instanceof DeleteRolePolicyCommand) {
          policies.delete(command.input.PolicyName!);
          return {};
        }
        if (command instanceof DeleteRoleCommand) {
          roleExists = false;
          return {};
        }
        if (command instanceof GetRolePolicyCommand) {
          const error = new Error("missing");
          error.name = "NoSuchEntityException";
          throw error;
        }
        if (command instanceof ListRolePoliciesCommand) {
          return { PolicyNames: [...policies.keys()], IsTruncated: false };
        }
        if (command instanceof PutRolePolicyCommand) {
          policies.set(command.input.PolicyName!, command.input.PolicyDocument!);
          return {};
        }
        throw new Error("unexpected IAM command");
      },
    } as unknown as IAMClient;
    const control = {
      send: async (command: CreateGatewayCommand | GetGatewayCommand) =>
        command instanceof CreateGatewayCommand
          ? {
              gatewayArn: GATEWAY_ARN,
              gatewayId: "orders-abc123",
              status: "CREATING",
              name: "orders",
              roleArn: ROLE_ARN,
              authorizerType: "NONE",
              createdAt: new Date(),
              updatedAt: new Date(),
            }
          : {
              gatewayArn: GATEWAY_ARN,
              gatewayId: "orders-abc123",
              status: "FAILED",
              statusReasons: ["service rejected the configuration"],
              name: "orders",
              roleArn: ROLE_ARN,
              authorizerType: "NONE",
              createdAt: new Date(),
              updatedAt: new Date(),
            },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => iam,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        roleManager: { cleanupRetryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.createGateway(
        {
          name: "orders",
          roleArn: undefined,
          authorizerType: "NONE",
        },
        { region: REGION },
      ),
    ).rejects.toBeInstanceOf(GatewayTerminalStateError);
    expect(roleExists).toBeFalse();
    expect(policies.size).toBe(0);
  });

  test("retains the role and transition policy when finalization fails after READY", async () => {
    let roleExists = false;
    let putCount = 0;
    const policies = new Map<string, string>();
    const iam = {
      send: async (command: IamCommand) => {
        if (command instanceof GetRoleCommand) {
          if (!roleExists) {
            const error = new Error("missing");
            error.name = "NoSuchEntityException";
            throw error;
          }
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
        if (command instanceof CreateRoleCommand) {
          roleExists = true;
          return { Role: { RoleName: ROLE_NAME, Arn: ROLE_ARN } };
        }
        if (command instanceof ListRolePoliciesCommand) {
          return { PolicyNames: [...policies.keys()], IsTruncated: false };
        }
        if (command instanceof PutRolePolicyCommand) {
          putCount++;
          if (putCount === 2) throw new Error("final PutRolePolicy failed");
          policies.set(command.input.PolicyName!, command.input.PolicyDocument!);
          return {};
        }
        if (command instanceof GetRolePolicyCommand) {
          return { PolicyDocument: policies.get(command.input.PolicyName!) };
        }
        if (command instanceof DeleteRolePolicyCommand) {
          policies.delete(command.input.PolicyName!);
          return {};
        }
        if (command instanceof DeleteRoleCommand) {
          roleExists = false;
          return {};
        }
        throw new Error("unexpected IAM command");
      },
    } as unknown as IAMClient;
    const created = {
      gatewayArn: GATEWAY_ARN,
      gatewayId: "orders-abc123",
      status: "CREATING" as const,
      name: "orders",
      roleArn: ROLE_ARN,
      authorizerType: "NONE" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
      policyEngineConfiguration: { arn: POLICY_ENGINE_ARN, mode: "ENFORCE" as const },
    };
    const control = {
      send: async (command: CreateGatewayCommand | GetGatewayCommand) =>
        command instanceof CreateGatewayCommand ? created : { ...created, status: "READY" },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => iam,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        roleManager: { cleanupRetryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    const error = await client
      .createGateway(
        {
          name: "orders",
          roleArn: undefined,
          authorizerType: "NONE",
          policyEngineConfiguration: { arn: POLICY_ENGINE_ARN, mode: "ENFORCE" },
        },
        { region: REGION },
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PolicyFinalizationError);
    expect((error as Error).message).toContain("gatewayId orders-abc123");
    expect((error as Error).message).toContain("may not be invokable");
    expect((error as Error).message).toContain("Rerun the same command");
    expect(roleExists).toBeTrue();
    expect(policies.size).toBe(1);
    expect(policyPermissions([...policies.values()][0]!)).not.toContain(
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
    );
  });

  test("observes an ambiguously successful create instead of deleting its role", async () => {
    let roleExists = false;
    const policies = new Map<string, string>();
    const iam = {
      send: async (command: IamCommand) => {
        if (command instanceof GetRoleCommand) {
          if (!roleExists) {
            const error = new Error("missing");
            error.name = "NoSuchEntityException";
            throw error;
          }
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
        if (command instanceof CreateRoleCommand) {
          roleExists = true;
          return { Role: { RoleName: ROLE_NAME, Arn: ROLE_ARN } };
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
        if (command instanceof DeleteRolePolicyCommand) {
          policies.delete(command.input.PolicyName!);
          return {};
        }
        if (command instanceof DeleteRoleCommand) {
          roleExists = false;
          return {};
        }
        throw new Error("unexpected IAM command");
      },
    } as unknown as IAMClient;
    let accepted = false;
    const settled: GetGatewayResponse = {
      gatewayArn: GATEWAY_ARN,
      gatewayId: "orders-abc123",
      createdAt: new Date("2026-08-12T00:00:00Z"),
      updatedAt: new Date("2026-08-12T00:00:00Z"),
      status: "READY",
      name: "orders",
      roleArn: ROLE_ARN,
      authorizerType: "NONE",
    };
    const control = {
      send: async (command: CreateGatewayCommand | GetGatewayCommand | ListGatewaysCommand) => {
        if (command instanceof CreateGatewayCommand) {
          accepted = true;
          const error = new Error("response connection closed");
          error.name = "TimeoutError";
          throw error;
        }
        if (command instanceof ListGatewaysCommand) {
          return {
            items: accepted
              ? [
                  {
                    gatewayId: settled.gatewayId,
                    name: settled.name,
                    status: "CREATING",
                  },
                ]
              : [],
          };
        }
        return settled;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => iam,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.createGateway(
        {
          name: "orders",
          roleArn: undefined,
          authorizerType: "NONE",
        },
        { region: REGION },
      ),
    ).resolves.toMatchObject({
      gatewayId: "orders-abc123",
      status: "READY",
    });
    expect(roleExists).toBeTrue();
    expect(policyPermissions([...policies.values()][0]!)).toContain(
      `bedrock-agentcore:InvokeGateway ${GATEWAY_ARN}`,
    );
  });

  test("preserves an existing managed role policy after confirmed create failure", async () => {
    const policyName = ExecutionRoleManager.generatedPolicyName("gateway", {
      accountId: ACCOUNT_ID,
      region: REGION,
      stableResourceKey: ROLE_NAME,
    });
    const existingResource = "arn:aws:s3:::existing-gateway/schema.json";
    const policies = new Map([
      [
        policyName,
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:GetObject"],
              Resource: [existingResource],
            },
          ],
        }),
      ],
    ]);
    let roleDeleted = false;
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
        if (command instanceof GetRolePolicyCommand) {
          return { PolicyDocument: policies.get(command.input.PolicyName!) };
        }
        if (command instanceof PutRolePolicyCommand) {
          policies.set(command.input.PolicyName!, command.input.PolicyDocument!);
          return {};
        }
        if (command instanceof DeleteRolePolicyCommand) {
          policies.delete(command.input.PolicyName!);
          return {};
        }
        if (command instanceof DeleteRoleCommand) {
          roleDeleted = true;
          return {};
        }
        throw new Error("unexpected IAM command");
      },
    } as unknown as IAMClient;
    const control = {
      send: async () => {
        const error = new Error("request rejected before create");
        error.name = "ValidationException";
        throw error;
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

    await expect(
      client.createGateway(
        {
          name: "orders",
          roleArn: undefined,
          authorizerType: "NONE",
        },
        { region: REGION },
      ),
    ).rejects.toThrow("request rejected before create");
    expect(roleDeleted).toBeFalse();
    expect(policies.size).toBe(1);
    expect(policyPermissions(policies.get(policyName)!)).toContain(
      `s3:GetObject ${existingResource}`,
    );
  });
});

describe("GatewayClient customer-managed execution role", () => {
  test("passes an explicit role through without any IAM calls", async () => {
    const response: CreateGatewayResponse = {
      gatewayArn: GATEWAY_ARN,
      gatewayId: "orders-abc123",
      createdAt: new Date("2026-08-12T00:00:00Z"),
      updatedAt: new Date("2026-08-12T00:00:00Z"),
      status: "CREATING",
      name: "orders",
      roleArn: "arn:aws:iam::123456789012:role/CustomerGatewayRole",
      authorizerType: "AWS_IAM",
    };
    let sentInput: CreateGatewayCommand["input"] | undefined;
    const control = {
      send: async (command: CreateGatewayCommand | GetGatewayCommand) => {
        if (command instanceof CreateGatewayCommand) {
          sentInput = command.input;
          return response;
        }
        return { ...response, status: "READY" };
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new GatewayClient(
      {
        control: () => control,
        iam: () => {
          throw new Error("IAM must not be requested");
        },
      } as unknown as AwsClients,
      {
        waitAttempts: 1,
        waitDelayMs: 0,
      },
    );

    await expect(
      client.createGateway(
        {
          name: "orders",
          roleArn: response.roleArn,
          authorizerType: "AWS_IAM",
        },
        { region: REGION },
      ),
    ).resolves.toEqual(response);
    expect(sentInput).toEqual({
      name: "orders",
      clientToken: expect.any(String),
      roleArn: response.roleArn,
      authorizerType: "AWS_IAM",
    });
  });
});
