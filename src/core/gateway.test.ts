import { describe, expect, mock, test } from "bun:test";
import {
  CreateGatewayCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  GetApiKeyCredentialProviderCommand,
  GetGatewayCommand,
  GetGatewayTargetCommand,
  GetOauth2CredentialProviderCommand,
  GetTokenVaultCommand,
  ListGatewayTargetsCommand,
  TargetType,
  UpdateGatewayCommand,
  UpdateGatewayTargetCommand,
  type BedrockAgentCoreControlClient,
  type CredentialProviderConfiguration,
  type GetGatewayResponse,
  type GetGatewayTargetResponse,
  type TargetSummary,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { ERROR_SOURCE, ResultTruncationError } from "../errors";
import type { GatewayTargetUpdatePatch, GatewayUpdatePatch } from "../handlers/gateway/types";
import type { AwsClients } from "./types";
import { GatewayClient } from "./gateway";
import { GatewayMutationIndeterminateError } from "./gatewayExecutionRole";

const options = { region: "us-west-2", endpointUrl: "https://agentcore.example.test" };

function connector(targetId: string): TargetSummary {
  return { targetId, targetType: TargetType.CONNECTOR } as TargetSummary;
}

function ordinary(targetId: string): TargetSummary {
  return { targetId, targetType: TargetType.MCP_SERVER } as TargetSummary;
}

function gatewayClient(
  send: (command: GetGatewayTargetCommand | ListGatewayTargetsCommand) => Promise<unknown>,
): GatewayClient {
  return new GatewayClient({
    control: () => ({ send: mock(send) }) as never,
  } as unknown as AwsClients);
}

describe("GatewayClient Connector facade", () => {
  test("filters Connector Targets from the final service page", async () => {
    const connectorTarget = connector("connector-1");
    const client = gatewayClient(async (command) => {
      expect(command).toBeInstanceOf(ListGatewayTargetsCommand);
      expect(command.input).toEqual({
        gatewayIdentifier: "gateway-1",
        nextToken: "page-2",
        maxResults: 10,
      });
      return { items: [connectorTarget, ordinary("target-1")] };
    });

    await expect(client.listGatewayConnectors("gateway-1", "page-2", 10, options)).resolves.toEqual(
      {
        items: [connectorTarget],
      },
    );
  });

  test("fills a Connector page and returns a token known to lead to another Connector", async () => {
    const requests: unknown[] = [];
    const connectors = [
      connector("connector-1"),
      connector("connector-2"),
      connector("connector-3"),
    ];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      switch (command.input.nextToken) {
        case undefined:
          return {
            items: [ordinary("target-1"), connectors[0], ordinary("target-2")],
            nextToken: "page-2",
          };
        case "page-2":
          return {
            items: [ordinary("target-3"), connectors[1]],
            nextToken: "page-3",
          };
        case "page-3":
          return { items: [connectors[2]], nextToken: "page-4" };
        case "page-4":
          return { items: [ordinary("target-4"), connector("connector-4")], nextToken: "page-5" };
        default:
          throw new Error(`unexpected token ${command.input.nextToken}`);
      }
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 3, options)).resolves.toEqual(
      {
        items: connectors,
        nextToken: "page-4",
      },
    );
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 3 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 2 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-3", maxResults: 1 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-4", maxResults: 100 },
    ]);
  });

  test("omits nextToken when lookahead finds no more Connectors", async () => {
    const connectorTarget = connector("connector-1");
    const requests: unknown[] = [];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      return command.input.nextToken === undefined
        ? { items: [connectorTarget], nextToken: "page-2" }
        : { items: [ordinary("target-2")] };
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 1, options)).resolves.toEqual(
      {
        items: [connectorTarget],
        nextToken: undefined,
      },
    );
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 1 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 100 },
    ]);
  });

  test("returns a partial Connector page when Targets are exhausted", async () => {
    const connectorTarget = connector("connector-1");
    const requests: unknown[] = [];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      return command.input.nextToken === undefined
        ? { items: [ordinary("target-1"), connectorTarget], nextToken: "page-2" }
        : { items: [ordinary("target-2")] };
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 3, options)).resolves.toEqual(
      {
        items: [connectorTarget],
      },
    );
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 3 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 2 },
    ]);
  });

  test("fills the default Connector page when maxResults is omitted", async () => {
    const connectors = [connector("connector-1"), connector("connector-2")];
    const requests: unknown[] = [];
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      requests.push(command.input);
      return command.input.nextToken === undefined
        ? { items: [connectors[0], ordinary("target-1")], nextToken: "page-2" }
        : { items: [connectors[1], ordinary("target-2")] };
    });

    await expect(
      client.listGatewayConnectors("gateway-1", undefined, undefined, options),
    ).resolves.toEqual({
      items: connectors,
    });
    expect(requests).toEqual([
      { gatewayIdentifier: "gateway-1", nextToken: undefined, maxResults: 100 },
      { gatewayIdentifier: "gateway-1", nextToken: "page-2", maxResults: 99 },
    ]);
  });

  test("throws when Connector discovery exceeds the Target page cap", async () => {
    let calls = 0;
    const client = gatewayClient(async (command) => {
      if (!(command instanceof ListGatewayTargetsCommand)) {
        throw new Error("expected ListGatewayTargetsCommand");
      }
      calls += 1;
      return { items: [], nextToken: `page-${calls}` };
    });

    await expect(client.listGatewayConnectors("gateway-1", undefined, 1, options)).rejects.toThrow(
      ResultTruncationError,
    );
    expect(calls).toBe(101);
  });

  test("gets a Connector-backed Target", async () => {
    const connector = {
      targetId: "connector-1",
      targetConfiguration: {
        mcp: { connector: { source: { connectorId: "web-search" } } },
      },
    } as GetGatewayTargetResponse;
    const client = gatewayClient(async (command) => {
      expect(command).toBeInstanceOf(GetGatewayTargetCommand);
      expect(command.input).toEqual({
        gatewayIdentifier: "gateway-1",
        targetId: "connector-1",
      });
      return connector;
    });

    await expect(client.getGatewayConnector("gateway-1", "connector-1", options)).resolves.toEqual(
      connector,
    );
  });

  test("rejects a Target that is not Connector-backed", async () => {
    const client = gatewayClient(async () => ({
      targetId: "target-1",
      targetConfiguration: {
        mcp: { mcpServer: { endpoint: "https://example.test/mcp" } },
      },
    }));

    await expect(client.getGatewayConnector("gateway-1", "target-1", options)).rejects.toThrow(
      'Gateway Target "target-1" is not connector-backed',
    );
  });
});

const OPTIONS = { region: "us-west-2" };
const MANAGED_ROLE_NAME = "AgentCoreCliGateway-us-west-2-orders";
const MANAGED_ROLE_ARN = `arn:aws:iam::123456789012:role/${MANAGED_ROLE_NAME}`;
const MANAGED_ROLE_TAGS = [
  { Key: "AgentCoreCLIManaged", Value: "true" },
  { Key: "AgentCoreCLIResourceType", Value: "Gateway" },
  { Key: "AgentCoreCLIRegion", Value: OPTIONS.region },
  { Key: "AgentCoreCLIResourceName", Value: "orders" },
];

function managedRole() {
  return {
    Arn: MANAGED_ROLE_ARN,
    RoleName: MANAGED_ROLE_NAME,
    Tags: MANAGED_ROLE_TAGS,
  };
}

test("creates a Gateway execution role when no role ARN is supplied", async () => {
  const controlCommands: unknown[] = [];
  const iamCommands: unknown[] = [];
  const clients = {
    control: () =>
      ({
        send: async (command: unknown) => {
          controlCommands.push(command);
          return command instanceof CreateGatewayCommand
            ? {
                gatewayId: "gateway-1",
                gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-1",
              }
            : { gatewayId: "gateway-1", status: "READY" };
        },
      }) as unknown as BedrockAgentCoreControlClient,
    iam: () =>
      ({
        send: async (command: GetRoleCommand | CreateRoleCommand) => {
          iamCommands.push(command);
          if (command instanceof GetRoleCommand) {
            const error = new Error("missing");
            error.name = "NoSuchEntityException";
            throw error;
          }
          return {
            Role: {
              RoleName: MANAGED_ROLE_NAME,
              Arn: MANAGED_ROLE_ARN,
            },
          };
        },
      }) as unknown as IAMClient,
  } as unknown as AwsClients;

  await new GatewayClient(clients, { propagationDelayMs: 0 }).createGateway(
    { name: "orders", authorizerType: "NONE" },
    OPTIONS,
  );

  expect(iamCommands[0]).toBeInstanceOf(GetRoleCommand);
  expect(iamCommands[1]).toBeInstanceOf(CreateRoleCommand);
  expect((iamCommands[1] as CreateRoleCommand).input).toMatchObject({
    RoleName: MANAGED_ROLE_NAME,
    Tags: MANAGED_ROLE_TAGS,
  });
  expect(controlCommands[0]).toBeInstanceOf(CreateGatewayCommand);
  expect((controlCommands[0] as CreateGatewayCommand).input.roleArn).toBe(MANAGED_ROLE_ARN);
});

test("stages a Lambda grant without dropping existing target and auth grants", async () => {
  const providerArn =
    "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/orders";
  const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:orders";
  const gatewayResponse = {
    ...gateway(),
    roleArn: MANAGED_ROLE_ARN,
    workloadIdentityDetails: {
      workloadIdentityArn:
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default/workload-identity/orders",
    },
  };
  const existingTarget = {
    targetId: "web-search",
    targetConfiguration: {
      mcp: { connector: { source: { connectorId: "web-search" } } },
    },
  } as GetGatewayTargetResponse;
  const authenticatedTarget = {
    targetId: "authenticated",
    targetConfiguration: {
      mcp: { mcpServer: { endpoint: "https://example.test/mcp" } },
    },
    credentialProviderConfigurations: [
      {
        credentialProviderType: "API_KEY",
        credentialProvider: {
          apiKeyCredentialProvider: { providerArn },
        },
      },
    ],
  } as GetGatewayTargetResponse;
  const policies: unknown[] = [];
  const clients = {
    control: () =>
      ({
        send: async (command: unknown) => {
          if (command instanceof GetGatewayCommand) return gatewayResponse;
          if (command instanceof ListGatewayTargetsCommand) {
            return {
              items: [
                { targetId: existingTarget.targetId },
                { targetId: authenticatedTarget.targetId },
              ],
            };
          }
          if (command instanceof GetGatewayTargetCommand) {
            if (command.input.targetId === existingTarget.targetId) return existingTarget;
            if (command.input.targetId === authenticatedTarget.targetId) {
              return authenticatedTarget;
            }
            return { targetId: "lambda", status: "READY" };
          }
          if (command instanceof GetApiKeyCredentialProviderCommand) {
            expect(command.input.name).toBe("orders");
            return {
              credentialProviderArn: providerArn,
              apiKeySecretArn: { secretArn },
            };
          }
          if (command instanceof GetTokenVaultCommand) {
            return {
              tokenVaultId: "default",
              kmsConfiguration: { keyType: "ServiceManagedKey" },
            };
          }
          if (command instanceof CreateGatewayTargetCommand) {
            expect(JSON.stringify(policies.at(-1))).toContain(
              "arn:aws:lambda:us-west-2:123456789012:function:orders",
            );
            expect(JSON.stringify(policies.at(-1))).toContain("InvokeWebSearch");
            expect(JSON.stringify(policies.at(-1))).toContain(secretArn);
            return { targetId: "lambda" };
          }
          throw new Error(`unexpected command ${command}`);
        },
      }) as unknown as BedrockAgentCoreControlClient,
    iam: () =>
      ({
        send: async (command: GetRoleCommand | PutRolePolicyCommand) => {
          if (command instanceof GetRoleCommand) return { Role: managedRole() };
          policies.push(JSON.parse(command.input.PolicyDocument!));
          return {};
        },
      }) as unknown as IAMClient,
  } as unknown as AwsClients;

  await new GatewayClient(clients, { propagationDelayMs: 0 }).createGatewayTarget(
    {
      gatewayIdentifier: "gateway-1",
      name: "lambda",
      targetConfiguration: {
        mcp: {
          lambda: {
            lambdaArn: "arn:aws:lambda:us-west-2:123456789012:function:orders",
            toolSchema: { inlinePayload: [] },
          },
        },
      },
    },
    OPTIONS,
  );

  expect(policies).toHaveLength(1);
});

test("bypasses policy discovery when Target create skips role updates", async () => {
  const commands: unknown[] = [];
  const clients = {
    control: () =>
      ({
        send: async (command: unknown) => {
          commands.push(command);
          return { targetId: "target-1" };
        },
      }) as unknown as BedrockAgentCoreControlClient,
    iam: () => {
      throw new Error("unexpected IAM client");
    },
  } as unknown as AwsClients;

  await new GatewayClient(clients).createGatewayTarget(
    {
      gatewayIdentifier: "gateway-1",
      name: "calendar",
      targetConfiguration: {
        mcp: { mcpServer: { endpoint: "https://example.test/mcp" } },
      },
      skipRolePolicyUpdate: true,
    },
    OPTIONS,
  );

  expect(commands).toHaveLength(1);
  expect(commands[0]).toBeInstanceOf(CreateGatewayTargetCommand);
  expect((commands[0] as CreateGatewayTargetCommand).input).not.toHaveProperty(
    "skipRolePolicyUpdate",
  );
});

test("preserves a newly created role when Gateway mutation outcome is indeterminate", async () => {
  const iamCommands: unknown[] = [];
  const clients = {
    control: () =>
      ({
        send: async () => {
          throw new Error("connection reset");
        },
      }) as unknown as BedrockAgentCoreControlClient,
    iam: () =>
      ({
        send: async (command: unknown) => {
          iamCommands.push(command);
          if (command instanceof GetRoleCommand) {
            const error = new Error("missing");
            error.name = "NoSuchEntityException";
            throw error;
          }
          return { Role: { Arn: MANAGED_ROLE_ARN, RoleName: MANAGED_ROLE_NAME } };
        },
      }) as unknown as IAMClient,
  } as unknown as AwsClients;

  await expect(
    new GatewayClient(clients, { propagationDelayMs: 0 }).createGateway(
      { name: "orders", authorizerType: "NONE" },
      OPTIONS,
    ),
  ).rejects.toBeInstanceOf(GatewayMutationIndeterminateError);

  expect(iamCommands.some((command) => command instanceof DeleteRolePolicyCommand)).toBe(false);
  expect(iamCommands.some((command) => command instanceof DeleteRoleCommand)).toBe(false);
});

async function updateTargetCredentials(
  currentCredentials: CredentialProviderConfiguration[],
  desiredCredentials: CredentialProviderConfiguration[] | null,
  secretSource: "MANAGED" | "EXTERNAL" = "MANAGED",
): Promise<unknown[]> {
  const apiKeyProviderArn =
    "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/orders";
  const oauthProviderArn =
    "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/orders";
  const secretArn = "arn:aws:secretsmanager:us-west-2:123456789012:secret:orders";
  const currentTarget = {
    ...target(),
    credentialProviderConfigurations: currentCredentials,
  };
  const gatewayResponse = {
    ...gateway(),
    roleArn: MANAGED_ROLE_ARN,
    workloadIdentityDetails: {
      workloadIdentityArn:
        "arn:aws:bedrock-agentcore:us-west-2:123456789012:workload-identity-directory/default/workload-identity/orders",
    },
  };
  let targetReads = 0;
  const policies: unknown[] = [];
  const clients = {
    control: () =>
      ({
        send: async (command: unknown) => {
          if (command instanceof GetGatewayTargetCommand) {
            targetReads += 1;
            return targetReads === 1 ? currentTarget : { ...currentTarget, status: "READY" };
          }
          if (command instanceof GetGatewayCommand) return gatewayResponse;
          if (command instanceof ListGatewayTargetsCommand) {
            return { items: [{ targetId: currentTarget.targetId }] };
          }
          if (command instanceof GetApiKeyCredentialProviderCommand) {
            return {
              credentialProviderArn: apiKeyProviderArn,
              apiKeySecretArn: { secretArn },
              apiKeySecretSource: secretSource,
            };
          }
          if (command instanceof GetOauth2CredentialProviderCommand) {
            return {
              credentialProviderArn: oauthProviderArn,
              clientSecretArn: { secretArn },
              clientSecretSource: secretSource,
            };
          }
          if (command instanceof GetTokenVaultCommand) {
            return {
              tokenVaultId: "default",
              kmsConfiguration: {
                keyType: "CustomerManagedKey",
                kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/token-vault",
              },
            };
          }
          if (command instanceof UpdateGatewayTargetCommand) return { targetId: "target-1" };
          throw new Error(`unexpected command ${command}`);
        },
      }) as unknown as BedrockAgentCoreControlClient,
    iam: () =>
      ({
        send: async (command: GetRoleCommand | PutRolePolicyCommand) => {
          if (command instanceof GetRoleCommand) return { Role: managedRole() };
          policies.push(JSON.parse(command.input.PolicyDocument!));
          return {};
        },
      }) as unknown as IAMClient,
  } as unknown as AwsClients;

  await new GatewayClient(clients, { propagationDelayMs: 0 }).updateGatewayTarget(
    {
      gatewayId: "gateway-1",
      targetId: "target-1",
      credentialProviderConfigurations: desiredCredentials,
    },
    OPTIONS,
  );
  return policies;
}

test("adds credential grants when a Target changes from JWT passthrough to API key", async () => {
  const providerArn =
    "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/orders";
  const policies = await updateTargetCredentials(
    [{ credentialProviderType: "JWT_PASSTHROUGH" }],
    [
      {
        credentialProviderType: "API_KEY",
        credentialProvider: {
          apiKeyCredentialProvider: { providerArn },
        },
      },
    ],
  );

  expect(policies).toHaveLength(2);
  expect(JSON.stringify(policies.at(-1))).toContain("GetResourceApiKey");
  expect(JSON.stringify(policies.at(-1))).toContain("secretsmanager:GetSecretValue");
  expect(JSON.stringify(policies.at(-1))).toContain("kms:Decrypt");
});

test.each(["API-key", "OAuth"] as const)(
  "rejects external %s secrets before mutating a managed Target",
  async (kind) => {
    const configuration: CredentialProviderConfiguration =
      kind === "API-key"
        ? {
            credentialProviderType: "API_KEY",
            credentialProvider: {
              apiKeyCredentialProvider: {
                providerArn:
                  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/orders",
              },
            },
          }
        : {
            credentialProviderType: "OAUTH",
            credentialProvider: {
              oauthCredentialProvider: {
                providerArn:
                  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/orders",
                scopes: ["orders.read"],
                grantType: "CLIENT_CREDENTIALS",
              },
            },
          };

    await expect(
      updateTargetCredentials(
        [{ credentialProviderType: "JWT_PASSTHROUGH" }],
        [configuration],
        "EXTERNAL",
      ),
    ).rejects.toThrow(/--skip-role-policy-update/);
  },
);

function gateway(): GetGatewayResponse {
  return {
    gatewayId: "gateway-1",
    gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-1",
    name: "orders",
    roleArn: "arn:aws:iam::123456789012:role/orders",
    status: "READY",
    authorizerType: "CUSTOM_JWT",
    authorizerConfiguration: {
      customJWTAuthorizer: {
        discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
      },
    },
    protocolType: "MCP",
    protocolConfiguration: { mcp: { supportedVersions: ["2025-11-25"] } },
    description: "before",
    kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/key-1",
    policyEngineConfiguration: {
      arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/engine-1",
      mode: "LOG_ONLY",
    },
    exceptionLevel: "DEBUG",
  } as GetGatewayResponse;
}

function target(): GetGatewayTargetResponse {
  return {
    targetId: "target-1",
    name: "calendar",
    description: "before",
    targetConfiguration: {
      mcp: {
        mcpServer: {
          endpoint: "https://old.example.test/mcp",
          mcpToolSchema: { s3: { uri: "s3://schemas/calendar.json" } },
          listingMode: "DEFAULT",
          resourcePriority: 100,
        },
      },
    },
    credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
    metadataConfiguration: { allowedRequestHeaders: ["x-request-id"] },
  } as unknown as GetGatewayTargetResponse;
}

test("maps Gateway, Target, and Rule selectors to their delete commands", async () => {
  const { client, commands } = recordingGatewayClient([gateway(), {}, gateway(), {}, {}]);

  await client.deleteGateway("gateway-1", OPTIONS);
  await client.deleteGatewayTarget("gateway-1", "target-1", OPTIONS);
  await client.deleteGatewayRule("gateway-1", "rule-1", OPTIONS);

  expect(commands).toHaveLength(5);
  expect(commands[0]).toBeInstanceOf(GetGatewayCommand);
  expect(commands[1]).toBeInstanceOf(DeleteGatewayCommand);
  expect((commands[1] as DeleteGatewayCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
  });
  expect(commands[2]).toBeInstanceOf(GetGatewayCommand);
  expect(commands[3]).toBeInstanceOf(DeleteGatewayTargetCommand);
  expect((commands[3] as DeleteGatewayTargetCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
    targetId: "target-1",
  });
  expect(commands[4]).toBeInstanceOf(DeleteGatewayRuleCommand);
  expect((commands[4] as DeleteGatewayRuleCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
    ruleId: "rule-1",
  });
});

test("reconciles stale grants when a Target delete retry finds the Target missing", async () => {
  const policies: unknown[] = [];
  const clients = {
    control: () =>
      ({
        send: async (command: unknown) => {
          if (command instanceof GetGatewayCommand) {
            return { ...gateway(), roleArn: MANAGED_ROLE_ARN };
          }
          if (command instanceof DeleteGatewayTargetCommand) {
            const error = new Error("missing");
            error.name = "ResourceNotFoundException";
            throw error;
          }
          if (command instanceof ListGatewayTargetsCommand) return { items: [] };
          throw new Error(`unexpected command ${command}`);
        },
      }) as unknown as BedrockAgentCoreControlClient,
    iam: () =>
      ({
        send: async (command: GetRoleCommand | PutRolePolicyCommand) => {
          if (command instanceof GetRoleCommand) return { Role: managedRole() };
          policies.push(JSON.parse(command.input.PolicyDocument!));
          return {};
        },
      }) as unknown as IAMClient,
  } as unknown as AwsClients;

  await expect(
    new GatewayClient(clients).deleteGatewayTarget("gateway-1", "target-1", OPTIONS),
  ).rejects.toMatchObject({ name: "ResourceNotFoundException" });

  expect(policies).toHaveLength(1);
  expect(JSON.stringify(policies[0])).toContain("bedrock-agentcore:InvokeGateway");
});

test("retries an indeterminate Gateway deletion read before preserving its policy", async () => {
  let gatewayReads = 0;
  const iamCommands: unknown[] = [];
  const clients = {
    control: () =>
      ({
        send: async (command: unknown) => {
          if (command instanceof GetGatewayCommand) {
            gatewayReads += 1;
            if (gatewayReads === 1) {
              return { ...gateway(), roleArn: MANAGED_ROLE_ARN };
            }
            const error = new Error(gatewayReads === 2 ? "throttled" : "missing");
            error.name = gatewayReads === 2 ? "ThrottlingException" : "ResourceNotFoundException";
            throw error;
          }
          if (command instanceof DeleteGatewayCommand) {
            return { gatewayId: "gateway-1", status: "DELETING" };
          }
          throw new Error(`unexpected command ${command}`);
        },
      }) as unknown as BedrockAgentCoreControlClient,
    iam: () =>
      ({
        send: async (command: unknown) => {
          iamCommands.push(command);
          if (command instanceof GetRoleCommand) return { Role: managedRole() };
          return {};
        },
      }) as unknown as IAMClient,
  } as unknown as AwsClients;

  await expect(
    new GatewayClient(clients, { waitAttempts: 2, waitDelayMs: 0 }).deleteGateway(
      "gateway-1",
      OPTIONS,
    ),
  ).resolves.toMatchObject({ gatewayId: "gateway-1" });

  expect(iamCommands.some((command) => command instanceof DeleteRolePolicyCommand)).toBe(true);
});

function recordingGatewayClient(responses: unknown[]): {
  client: GatewayClient;
  commands: unknown[];
} {
  const commands: unknown[] = [];
  const control = {
    send: async (command: unknown) => {
      commands.push(command);
      return responses.shift();
    },
  } as unknown as BedrockAgentCoreControlClient;
  const clients: AwsClients = {
    control: () => control,
    data: () => {
      throw new Error("unexpected data client");
    },
    iam: () => {
      throw new Error("unexpected IAM client");
    },
    logs: () => {
      throw new Error("unexpected Logs client");
    },
  };
  return { client: new GatewayClient(clients), commands };
}

async function gatewayUpdateInput(
  patch: GatewayUpdatePatch,
  current: GetGatewayResponse = gateway(),
): Promise<UpdateGatewayCommand["input"]> {
  const { client, commands } = recordingGatewayClient([current, {}]);
  await client.updateGateway(patch, OPTIONS);
  expect(commands[0]).toBeInstanceOf(GetGatewayCommand);
  expect((commands[0] as GetGatewayCommand).input).toEqual({
    gatewayIdentifier: patch.id,
  });
  return (commands[1] as UpdateGatewayCommand).input;
}

async function targetUpdateInput(
  patch: GatewayTargetUpdatePatch,
  current: GetGatewayTargetResponse = target(),
): Promise<UpdateGatewayTargetCommand["input"]> {
  const { client, commands } = recordingGatewayClient([current, gateway(), {}]);
  await client.updateGatewayTarget(patch, OPTIONS);
  expect(commands[0]).toBeInstanceOf(GetGatewayTargetCommand);
  expect((commands[0] as GetGatewayTargetCommand).input).toEqual({
    gatewayIdentifier: patch.gatewayId,
    targetId: patch.targetId,
  });
  return (commands[2] as UpdateGatewayTargetCommand).input;
}

describe("GatewayClient updateGateway", () => {
  test("does not touch IAM when replacing a role with policy updates skipped", async () => {
    const { client, commands } = recordingGatewayClient([
      { ...gateway(), roleArn: MANAGED_ROLE_ARN },
      { gatewayId: "gateway-1" },
    ]);
    const replacementRoleArn = "arn:aws:iam::123456789012:role/customer-managed";

    await client.updateGateway(
      {
        id: "gateway-1",
        roleArn: replacementRoleArn,
        skipRolePolicyUpdate: true,
      },
      OPTIONS,
    );

    expect(commands).toHaveLength(2);
    expect(commands[1]).toBeInstanceOf(UpdateGatewayCommand);
    expect((commands[1] as UpdateGatewayCommand).input.roleArn).toBe(replacementRoleArn);
  });

  test("stages Policy Engine permissions before updating a CLI-owned Gateway", async () => {
    const order: string[] = [];
    const current = {
      ...gateway(),
      gatewayArn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-1",
      roleArn: MANAGED_ROLE_ARN,
      policyEngineConfiguration: undefined,
    };
    const clients = {
      control: () =>
        ({
          send: async (command: GetGatewayCommand | UpdateGatewayCommand) => {
            if (command instanceof GetGatewayCommand) {
              order.push("get");
              return current;
            }
            if (command instanceof ListGatewayTargetsCommand) return { items: [] };
            order.push("update");
            return { gatewayId: "gateway-1" };
          },
        }) as unknown as BedrockAgentCoreControlClient,
      iam: () =>
        ({
          send: async (command: GetRoleCommand | PutRolePolicyCommand) => {
            if (command instanceof GetRoleCommand) {
              order.push("role");
              return { Role: managedRole() };
            }
            order.push("policy");
            return {};
          },
        }) as unknown as IAMClient,
    } as unknown as AwsClients;
    const client = new GatewayClient(clients, { propagationDelayMs: 0 });

    await client.updateGateway(
      {
        id: "gateway-1",
        roleArn: MANAGED_ROLE_ARN,
        policyEngineConfiguration: {
          arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/engine-2",
          mode: "ENFORCE",
        },
      },
      OPTIONS,
    );

    expect(order).toEqual(["get", "role", "policy", "update", "get"]);
  });

  test("clears requested fields and merges a Policy Engine mode change", async () => {
    expect(
      await gatewayUpdateInput({
        id: "gateway-1",
        clearProtocol: true,
        description: null,
        protocolConfiguration: null,
        policyEngineConfiguration: { mode: "ENFORCE" },
        exceptionLevel: null,
      }),
    ).toEqual({
      gatewayIdentifier: "gateway-1",
      name: "orders",
      roleArn: "arn:aws:iam::123456789012:role/orders",
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJWTAuthorizer: {
          discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
        },
      },
      kmsKeyArn: "arn:aws:kms:us-west-2:123456789012:key/key-1",
      policyEngineConfiguration: {
        arn: "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/engine-1",
        mode: "ENFORCE",
      },
    });
  });

  test("rejects CUSTOM_JWT configuration on another authorizer type", async () => {
    const { client } = recordingGatewayClient([
      { ...gateway(), authorizerType: "NONE", authorizerConfiguration: undefined },
    ]);
    await expect(
      client.updateGateway(
        {
          id: "gateway-1",
          authorizerConfiguration: {
            customJWTAuthorizer: {
              discoveryUrl: "https://auth.example.test/.well-known/openid-configuration",
            },
          },
        },
        OPTIONS,
      ),
    ).rejects.toThrow(/CUSTOM_JWT/);
  });

  test("classifies missing required service fields as service errors", async () => {
    const { client } = recordingGatewayClient([{ ...gateway(), name: undefined }]);

    await expect(
      client.updateGateway({ id: "gateway-1", description: "after" }, OPTIONS),
    ).rejects.toMatchObject({ source: ERROR_SOURCE.SERVICE });
  });
});

describe("GatewayClient updateGatewayTarget", () => {
  test("updates an MCP endpoint while preserving its schema and ancillary fields", async () => {
    expect(
      await targetUpdateInput({
        gatewayId: "gateway-1",
        targetId: "target-1",
        endpoint: "https://new.example.test/mcp",
      }),
    ).toEqual({
      gatewayIdentifier: "gateway-1",
      targetId: "target-1",
      name: "calendar",
      description: "before",
      targetConfiguration: {
        mcp: {
          mcpServer: {
            endpoint: "https://new.example.test/mcp",
            mcpToolSchema: { s3: { uri: "s3://schemas/calendar.json" } },
            listingMode: "DEFAULT",
            resourcePriority: 100,
          },
        },
      },
      credentialProviderConfigurations: [{ credentialProviderType: "JWT_PASSTHROUGH" }],
      metadataConfiguration: { allowedRequestHeaders: ["x-request-id"] },
    });
  });

  test("clears optional fields while preserving the Target configuration", async () => {
    expect(
      await targetUpdateInput({
        gatewayId: "gateway-1",
        targetId: "target-1",
        description: null,
        credentialProviderConfigurations: null,
        metadataConfiguration: null,
      }),
    ).toEqual({
      gatewayIdentifier: "gateway-1",
      targetId: "target-1",
      name: "calendar",
      targetConfiguration: target().targetConfiguration,
    });
  });

  test("does not echo empty service metadata arrays into an update", async () => {
    const input = await targetUpdateInput(
      {
        gatewayId: "gateway-1",
        targetId: "target-1",
        description: "after",
      },
      {
        ...target(),
        metadataConfiguration: { allowedRequestHeaders: [] },
      },
    );
    expect(input.metadataConfiguration).toBeUndefined();
  });

  test("rejects endpoint shorthand for a non-MCP-server Target", async () => {
    const { client } = recordingGatewayClient([
      {
        targetId: "target-1",
        targetConfiguration: {
          http: {
            passthrough: {
              endpoint: "https://example.test",
              protocolType: "CUSTOM",
            },
          },
        },
      } as GetGatewayTargetResponse,
    ]);
    await expect(
      client.updateGatewayTarget(
        {
          gatewayId: "gateway-1",
          targetId: "target-1",
          endpoint: "https://new.example.test/mcp",
        },
        OPTIONS,
      ),
    ).rejects.toThrow(/existing MCP server Target/);
  });
});

describe("GatewayClient updateGatewayConnector", () => {
  test("updates an existing inference connector Target", async () => {
    const targetConfiguration = {
      inference: { connector: { source: { connectorId: "bedrock-mantle" } } },
    };
    const { client, commands } = recordingGatewayClient([
      { targetId: "target-1", targetConfiguration } as GetGatewayTargetResponse,
      gateway(),
      {},
    ]);

    await client.updateGatewayConnector(
      {
        gatewayId: "gateway-1",
        targetId: "target-1",
        description: "after",
      },
      OPTIONS,
    );

    expect(commands[2]).toBeInstanceOf(UpdateGatewayTargetCommand);
    expect((commands[2] as UpdateGatewayTargetCommand).input.targetConfiguration).toEqual(
      targetConfiguration,
    );
  });

  test("rejects an existing non-connector Target", async () => {
    const { client, commands } = recordingGatewayClient([target()]);

    await expect(
      client.updateGatewayConnector(
        {
          gatewayId: "gateway-1",
          targetId: "target-1",
          description: "after",
        },
        OPTIONS,
      ),
    ).rejects.toThrow(/not connector-backed/);
    expect(commands).toHaveLength(1);
  });
});
