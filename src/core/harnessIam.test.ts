import { describe, expect, test } from "bun:test";
import {
  CreateHarnessCommand,
  DeleteHarnessCommand,
  DeleteHarnessEndpointCommand,
  GetApiKeyCredentialProviderCommand,
  GetHarnessCommand,
  UpdateHarnessCommand,
  type BedrockAgentCoreControlClient,
  type CreateHarnessResponse,
  type DeleteHarnessResponse,
  type DeleteHarnessEndpointResponse,
  type GetHarnessResponse,
  type UpdateHarnessResponse,
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
import { HarnessClient } from "./harness";
import { ExecutionRoleManager } from "./executionRoleManager";
import type { AwsClients } from "./types";

const REGION = "us-west-2";
const ACCOUNT = "123456789012";
const ROLE_NAME = "AgentCoreCliHarness-orders";
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}`;
const HARNESS_ID = "orders-abc123";
const HARNESS_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:harness/orders-abc123";
const MEMORY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/harness_orders-abc123";
const BROWSER_ARN = "arn:aws:bedrock-agentcore:us-west-2:aws:browser/orders";
const API_KEY_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/openai";

type IamCommand =
  | CreateRoleCommand
  | DeleteRoleCommand
  | DeleteRolePolicyCommand
  | GetRoleCommand
  | GetRolePolicyCommand
  | ListRolePoliciesCommand
  | PutRolePolicyCommand;

function atoms(document: string): string[] {
  const parsed = JSON.parse(document) as {
    Statement: { Action: string[]; Resource: string[] }[];
  };
  return parsed.Statement.flatMap((statement) =>
    statement.Action.flatMap((action) =>
      statement.Resource.map((resource) => `${action} ${resource}`),
    ),
  ).sort();
}

class InMemoryHarnessIam {
  readonly policies = new Map<string, string>();
  readonly client: IAMClient;

  constructor(public roleExists = true) {
    this.client = {
      send: (command: IamCommand) => this.send(command),
    } as unknown as IAMClient;
  }

  private async send(command: IamCommand): Promise<unknown> {
    if (command instanceof GetRoleCommand) {
      if (!this.roleExists) {
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
      this.roleExists = true;
      return { Role: { RoleName: ROLE_NAME, Arn: ROLE_ARN } };
    }
    if (command instanceof ListRolePoliciesCommand) {
      return { PolicyNames: [...this.policies.keys()], IsTruncated: false };
    }
    if (command instanceof PutRolePolicyCommand) {
      this.policies.set(command.input.PolicyName!, command.input.PolicyDocument!);
      return {};
    }
    if (command instanceof GetRolePolicyCommand) {
      const document = this.policies.get(command.input.PolicyName!);
      if (!document) {
        const error = new Error("missing");
        error.name = "NoSuchEntityException";
        throw error;
      }
      return { PolicyDocument: document };
    }
    if (command instanceof DeleteRolePolicyCommand) {
      this.policies.delete(command.input.PolicyName!);
      return {};
    }
    if (command instanceof DeleteRoleCommand) {
      this.roleExists = false;
      return {};
    }
    throw new Error("unexpected IAM command");
  }
}

describe("HarnessClient managed execution role", () => {
  test("stages managed Memory and finalizes its generated ARN after READY", async () => {
    const iam = new InMemoryHarnessIam(false);
    const creating: CreateHarnessResponse = {
      harness: {
        harnessId: HARNESS_ID,
        harnessName: "orders",
        arn: HARNESS_ARN,
        status: "CREATING",
        executionRoleArn: ROLE_ARN,
        harnessVersion: "1",
      } as never,
    };
    const ready: GetHarnessResponse = {
      harness: {
        ...creating.harness!,
        status: "READY",
        memory: { managedMemoryConfiguration: { arn: MEMORY_ARN } },
      },
    };
    const control = {
      send: async (command: CreateHarnessCommand | GetHarnessCommand) => {
        if (command instanceof CreateHarnessCommand) {
          const staged = atoms([...iam.policies.values()][0]!);
          expect(
            staged.some((value) => value.startsWith("bedrock-agentcore:CreateEvent ")),
          ).toBeFalse();
          return creating;
        }
        return ready;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new HarnessClient(
      {
        control: () => control,
        iam: () => iam.client,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.createHarness({ harnessName: "orders" }, { region: REGION }),
    ).resolves.toEqual(creating);
    expect(iam.roleExists).toBeTrue();
    expect(iam.policies.size).toBe(1);
    expect(atoms([...iam.policies.values()][0]!)).toContain(
      `bedrock-agentcore:CreateEvent ${MEMORY_ARN}`,
    );
  });

  test("leaves explicit-role create entirely outside IAM reconciliation", async () => {
    const response: CreateHarnessResponse = {
      harness: {
        harnessId: HARNESS_ID,
        harnessName: "orders",
        status: "CREATING",
        executionRoleArn: "arn:aws:iam::123456789012:role/CustomerHarnessRole",
      } as never,
    };
    const control = {
      send: async (command: CreateHarnessCommand) => {
        expect(command).toBeInstanceOf(CreateHarnessCommand);
        return response;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const iam = {
      send: async () => {
        throw new Error("explicit-role create must not call IAM");
      },
    } as unknown as IAMClient;
    const client = new HarnessClient({
      control: () => control,
      iam: () => iam,
    } as unknown as AwsClients);

    await expect(
      client.createHarness(
        {
          harnessName: "orders",
          executionRoleArn: "arn:aws:iam::123456789012:role/CustomerHarnessRole",
        },
        { region: REGION },
      ),
    ).resolves.toEqual(response);
  });

  test("removes a newly created role when credential enrichment fails", async () => {
    const iam = new InMemoryHarnessIam(false);
    const control = {
      send: async (command: GetApiKeyCredentialProviderCommand) => {
        expect(command).toBeInstanceOf(GetApiKeyCredentialProviderCommand);
        throw new Error("credential provider is missing");
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new HarnessClient(
      {
        control: () => control,
        iam: () => iam.client,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
      },
    );

    await expect(
      client.createHarness(
        {
          harnessName: "orders",
          model: {
            openAiModelConfig: {
              modelId: "gpt-5",
              apiKeyArn: API_KEY_ARN,
            },
          },
        },
        { region: REGION },
      ),
    ).rejects.toThrow("credential provider is missing");
    expect(iam.roleExists).toBeFalse();
    expect(iam.policies.size).toBe(0);
  });

  test("does not poll or mutate IAM when an update explicitly retains its role", async () => {
    const current: GetHarnessResponse = {
      harness: {
        harnessId: HARNESS_ID,
        harnessName: "orders",
        arn: HARNESS_ARN,
        status: "READY",
        executionRoleArn: ROLE_ARN,
      } as never,
    };
    const response: UpdateHarnessResponse = {
      harness: {
        ...current.harness!,
        status: "UPDATING",
      },
    };
    const commands: string[] = [];
    const control = {
      send: async (command: GetHarnessCommand | UpdateHarnessCommand) => {
        commands.push(command.constructor.name);
        if (command instanceof GetHarnessCommand) return current;
        if (command instanceof UpdateHarnessCommand) return response;
        throw new Error("unexpected control command");
      },
    } as unknown as BedrockAgentCoreControlClient;
    const iam = {
      send: async () => {
        throw new Error("explicit-role update must not call IAM");
      },
    } as unknown as IAMClient;
    const client = new HarnessClient({
      control: () => control,
      iam: () => iam,
    } as unknown as AwsClients);

    await expect(
      client.updateHarness(
        {
          harnessId: HARNESS_ID,
          executionRoleArn: ROLE_ARN,
          maxIterations: 10,
        },
        { region: REGION },
      ),
    ).resolves.toEqual(response);
    expect(commands).toEqual(["GetHarnessCommand", "UpdateHarnessCommand"]);
  });

  test("makes skip-role-policy-update a direct service update", async () => {
    const response: UpdateHarnessResponse = {
      harness: {
        harnessId: HARNESS_ID,
        harnessName: "orders",
        status: "UPDATING",
        executionRoleArn: ROLE_ARN,
      } as never,
    };
    const control = {
      send: async (command: UpdateHarnessCommand) => {
        expect(command).toBeInstanceOf(UpdateHarnessCommand);
        return response;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const iam = {
      send: async () => {
        throw new Error("skipped update must not call IAM");
      },
    } as unknown as IAMClient;
    const client = new HarnessClient({
      control: () => control,
      iam: () => iam,
    } as unknown as AwsClients);

    await expect(
      client.updateHarness(
        {
          harnessId: HARNESS_ID,
          maxIterations: 10,
          skipRolePolicyUpdate: true,
        },
        { region: REGION },
      ),
    ).resolves.toEqual(response);
  });

  test("keeps current and desired grants through a managed update, then tightens", async () => {
    const iam = new InMemoryHarnessIam();
    const current: GetHarnessResponse = {
      harness: {
        harnessId: HARNESS_ID,
        harnessName: "orders",
        arn: HARNESS_ARN,
        status: "READY",
        executionRoleArn: ROLE_ARN,
        memory: { agentCoreMemoryConfiguration: { arn: MEMORY_ARN } },
        tools: [],
      } as never,
    };
    const ready: GetHarnessResponse = {
      harness: {
        ...current.harness!,
        status: "READY",
        memory: { disabled: {} },
        tools: [
          {
            type: "agentcore_browser",
            config: { agentCoreBrowser: { browserArn: BROWSER_ARN } },
          },
        ],
        harnessVersion: "2",
      },
    };
    const updating: UpdateHarnessResponse = {
      harness: { ...ready.harness!, status: "UPDATING" },
    };
    let getCount = 0;
    const control = {
      send: async (command: GetHarnessCommand | UpdateHarnessCommand) => {
        if (command instanceof GetHarnessCommand) {
          getCount += 1;
          return getCount <= 3 ? current : ready;
        }
        const transition = atoms([...iam.policies.values()][0]!);
        expect(transition).toContain(`bedrock-agentcore:CreateEvent ${MEMORY_ARN}`);
        expect(transition).toContain(`bedrock-agentcore:StartBrowserSession ${BROWSER_ARN}`);
        return updating;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new HarnessClient(
      {
        control: () => control,
        iam: () => iam.client,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.updateHarness(
        {
          harnessId: HARNESS_ID,
          memory: { optionalValue: { disabled: {} } },
          tools: ready.harness!.tools,
        },
        { region: REGION },
      ),
    ).resolves.toEqual(updating);

    const finalPolicy = atoms([...iam.policies.values()][0]!);
    expect(finalPolicy).not.toContain(`bedrock-agentcore:CreateEvent ${MEMORY_ARN}`);
    expect(finalPolicy).toContain(`bedrock-agentcore:StartBrowserSession ${BROWSER_ARN}`);
  });

  test("restores current grants when a managed update fails", async () => {
    const iam = new InMemoryHarnessIam();
    const current: GetHarnessResponse = {
      harness: {
        harnessId: HARNESS_ID,
        harnessName: "orders",
        arn: HARNESS_ARN,
        status: "READY",
        executionRoleArn: ROLE_ARN,
        memory: { agentCoreMemoryConfiguration: { arn: MEMORY_ARN } },
        tools: [],
      } as never,
    };
    const control = {
      send: async (command: GetHarnessCommand | UpdateHarnessCommand) => {
        if (command instanceof GetHarnessCommand) return current;
        const transition = atoms([...iam.policies.values()][0]!);
        expect(transition).toContain(`bedrock-agentcore:CreateEvent ${MEMORY_ARN}`);
        expect(transition).toContain(`bedrock-agentcore:StartBrowserSession ${BROWSER_ARN}`);
        throw new Error("service rejected update");
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new HarnessClient(
      {
        control: () => control,
        iam: () => iam.client,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.updateHarness(
        {
          harnessId: HARNESS_ID,
          tools: [
            {
              type: "agentcore_browser",
              config: { agentCoreBrowser: { browserArn: BROWSER_ARN } },
            },
          ],
        },
        { region: REGION },
      ),
    ).rejects.toThrow("service rejected update");

    const restored = atoms([...iam.policies.values()][0]!);
    expect(restored).toContain(`bedrock-agentcore:CreateEvent ${MEMORY_ARN}`);
    expect(restored).not.toContain(`bedrock-agentcore:StartBrowserSession ${BROWSER_ARN}`);
  });

  test("deletes only the generated policy after confirmed Harness deletion", async () => {
    const iam = new InMemoryHarnessIam();
    const policyName = ExecutionRoleManager.generatedPolicyName("harness", {
      accountId: ACCOUNT,
      region: REGION,
      stableResourceKey: ROLE_NAME,
    });
    iam.policies.set(
      policyName,
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["bedrock-agentcore:CreateEvent"],
            Resource: [MEMORY_ARN],
          },
        ],
      }),
    );
    const current: GetHarnessResponse = {
      harness: {
        harnessId: HARNESS_ID,
        harnessName: "orders",
        arn: HARNESS_ARN,
        status: "READY",
        executionRoleArn: ROLE_ARN,
      } as never,
    };
    const deleting: DeleteHarnessResponse = {
      harness: { ...current.harness!, status: "DELETING" },
    };
    let getCount = 0;
    const control = {
      send: async (command: GetHarnessCommand | DeleteHarnessCommand) => {
        if (command instanceof DeleteHarnessCommand) return deleting;
        getCount += 1;
        if (getCount === 1) return current;
        const error = new Error("deleted");
        error.name = "ResourceNotFoundException";
        throw error;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new HarnessClient(
      {
        control: () => control,
        iam: () => iam.client,
      } as unknown as AwsClients,
      {
        policyUpdater: { propagationDelayMs: 0, retryDelayMs: 0 },
        waitDelayMs: 0,
      },
    );

    await expect(
      client.deleteHarness({ harnessId: HARNESS_ID }, { region: REGION }),
    ).resolves.toEqual(deleting);
    expect(iam.policies.has(policyName)).toBeFalse();
    expect(iam.roleExists).toBeTrue();
  });

  test("does not claim a CLI role owned by a different Harness", async () => {
    const current: GetHarnessResponse = {
      harness: {
        harnessId: "invoices-abc123",
        harnessName: "invoices",
        status: "READY",
        executionRoleArn: ROLE_ARN,
      } as never,
    };
    const deleting: DeleteHarnessResponse = {
      harness: { ...current.harness!, status: "DELETING" },
    };
    const commands: string[] = [];
    const control = {
      send: async (command: GetHarnessCommand | DeleteHarnessCommand) => {
        commands.push(command.constructor.name);
        return command instanceof GetHarnessCommand ? current : deleting;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const iam = {
      send: async () => {
        throw new Error("shared CLI role must remain externally managed");
      },
    } as unknown as IAMClient;
    const client = new HarnessClient({
      control: () => control,
      iam: () => iam,
    } as unknown as AwsClients);

    await expect(
      client.deleteHarness({ harnessId: "invoices-abc123" }, { region: REGION }),
    ).resolves.toEqual(deleting);
    expect(commands).toEqual(["GetHarnessCommand", "DeleteHarnessCommand"]);
  });

  test("keeps endpoint deletion independent from execution-role reconciliation", async () => {
    const response: DeleteHarnessEndpointResponse = {
      endpoint: {
        harnessId: HARNESS_ID,
        endpointName: "live",
        status: "DELETING",
      } as never,
    };
    const control = {
      send: async (command: DeleteHarnessEndpointCommand) => {
        expect(command).toBeInstanceOf(DeleteHarnessEndpointCommand);
        return response;
      },
    } as unknown as BedrockAgentCoreControlClient;
    const client = new HarnessClient({
      control: () => control,
    } as unknown as AwsClients);

    await expect(
      client.deleteHarnessEndpoint(
        {
          harnessId: HARNESS_ID,
          endpointName: "live",
        },
        { region: REGION },
      ),
    ).resolves.toEqual(response);
  });
});
