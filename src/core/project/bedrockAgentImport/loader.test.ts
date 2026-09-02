import { describe, expect, test } from "bun:test";
import {
  BedrockAgentClient,
  GetAgentActionGroupCommand,
  GetAgentAliasCommand,
  GetAgentVersionCommand,
  GetKnowledgeBaseCommand,
  ListAgentActionGroupsCommand,
  ListAgentCollaboratorsCommand,
  ListAgentKnowledgeBasesCommand,
  type AgentVersion,
} from "@aws-sdk/client-bedrock-agent";
import { InputValidationError } from "../../../errors";
import { BedrockAgentSnapshotLoader } from "./loader";

const AGENT_ID = "A1B2C3D4E5";
const ALIAS_ID = "TSTALIASID";
const AGENT_VERSION = "7";

type CommandHandler = (command: unknown) => unknown;

class FakeBedrockAgentClient {
  readonly commands: unknown[] = [];

  constructor(private readonly handler: CommandHandler) {}

  async send(command: unknown): Promise<unknown> {
    this.commands.push(command);
    return this.handler(command);
  }
}

function validAgentVersion(agentId = AGENT_ID, version = AGENT_VERSION): AgentVersion {
  return {
    agentId,
    agentName: agentId === AGENT_ID ? "SupportAgent" : "BillingAgent",
    agentArn: `arn:aws:bedrock:us-east-1:111122223333:agent/${agentId}`,
    version,
    agentStatus: "PREPARED",
    foundationModel: "us.amazon.nova-lite-v1:0",
    instruction: "Answer support questions.",
    idleSessionTTLInSeconds: 600,
    agentResourceRoleArn: "arn:aws:iam::111122223333:role/BedrockAgentRole",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    promptOverrideConfiguration: {
      promptConfigurations: [
        {
          promptType: "ORCHESTRATION",
          promptState: "ENABLED",
          promptCreationMode: "OVERRIDDEN",
          basePromptTemplate: "System: $instruction$",
          inferenceConfiguration: { temperature: 0.2, maximumLength: 1024 },
        },
        {
          promptType: "POST_PROCESSING",
          promptState: "DISABLED",
          basePromptTemplate: "disabled",
        },
      ],
    },
  };
}

function defaultHandler(command: unknown): unknown {
  if (command instanceof GetAgentAliasCommand) {
    return {
      agentAlias: {
        agentId: AGENT_ID,
        agentAliasId: ALIAS_ID,
        agentAliasName: "live",
        routingConfiguration: [{ agentVersion: AGENT_VERSION }],
      },
    };
  }
  if (command instanceof GetAgentVersionCommand) {
    return {
      agentVersion: validAgentVersion(command.input.agentId, command.input.agentVersion),
    };
  }
  if (command instanceof ListAgentActionGroupsCommand) {
    return { actionGroupSummaries: [] };
  }
  if (command instanceof ListAgentKnowledgeBasesCommand) {
    return { agentKnowledgeBaseSummaries: [] };
  }
  if (command instanceof ListAgentCollaboratorsCommand) {
    return { agentCollaboratorSummaries: [] };
  }
  throw new Error(`unexpected command: ${String(command)}`);
}

function loaderWith(handler: CommandHandler): {
  loader: BedrockAgentSnapshotLoader;
  client: FakeBedrockAgentClient;
} {
  const client = new FakeBedrockAgentClient(handler);
  return {
    client,
    loader: new BedrockAgentSnapshotLoader(() => client as unknown as BedrockAgentClient),
  };
}

describe("BedrockAgentSnapshotLoader", () => {
  test("loads the immutable version selected by the alias", async () => {
    const subject = loaderWith(defaultHandler);

    const result = await subject.loader.load({
      region: "us-east-1",
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
    });

    expect(result).toMatchObject({
      sourceAgentId: AGENT_ID,
      sourceAgentAliasId: ALIAS_ID,
      sourceAgentAliasName: "live",
      sourceAgentVersion: AGENT_VERSION,
      agentName: "SupportAgent",
      foundationModel: "us.amazon.nova-lite-v1:0",
      inferenceConfiguration: { temperature: 0.2, maximumLength: 1024 },
      hasPromptOverrides: true,
    });
    const versionCommand = subject.client.commands.find(
      (command) => command instanceof GetAgentVersionCommand,
    ) as GetAgentVersionCommand;
    expect(versionCommand.input).toEqual({
      agentId: AGENT_ID,
      agentVersion: AGENT_VERSION,
    });
  });

  test("rejects an alias that routes to the mutable DRAFT version", async () => {
    const subject = loaderWith((command) => {
      if (command instanceof GetAgentAliasCommand) {
        return {
          agentAlias: {
            agentId: AGENT_ID,
            agentAliasId: ALIAS_ID,
            agentAliasName: "AgentTestAlias",
            routingConfiguration: [{ agentVersion: "DRAFT" }],
          },
        };
      }
      return defaultHandler(command);
    });

    await expect(
      subject.loader.load({ region: "us-east-1", agentId: AGENT_ID, agentAliasId: ALIAS_ID }),
    ).rejects.toThrow(InputValidationError);
    expect(
      subject.client.commands.some((command) => command instanceof GetAgentVersionCommand),
    ).toBe(false);
  });

  test("does not copy Bedrock's internal default orchestration template", async () => {
    const subject = loaderWith((command) => {
      if (command instanceof GetAgentVersionCommand) {
        const agentVersion = validAgentVersion(command.input.agentId, command.input.agentVersion);
        agentVersion.promptOverrideConfiguration = {
          promptConfigurations: [
            {
              promptType: "ORCHESTRATION",
              promptState: "ENABLED",
              promptCreationMode: "DEFAULT",
              basePromptTemplate: '{"system":"$instruction$","messages":[]}',
              inferenceConfiguration: {
                temperature: 1,
                stopSequences: ["</answer>"],
              },
            },
          ],
        };
        return { agentVersion };
      }
      return defaultHandler(command);
    });

    const result = await subject.loader.load({
      region: "us-east-1",
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
    });

    expect(result.instruction).toBe("Answer support questions.");
    expect(result.hasPromptOverrides).toBe(false);
    // Bedrock echoes its internal orchestration defaults for a DEFAULT prompt; neither the
    // template nor its inference settings belong in the generated agent.
    expect(result.inferenceConfiguration).toBeUndefined();
  });

  test("carries ORCHESTRATION inference settings the customer overrode", async () => {
    const subject = loaderWith((command) => {
      if (command instanceof GetAgentVersionCommand) {
        const agentVersion = validAgentVersion(command.input.agentId, command.input.agentVersion);
        agentVersion.promptOverrideConfiguration = {
          promptConfigurations: [
            {
              promptType: "ORCHESTRATION",
              promptState: "ENABLED",
              promptCreationMode: "OVERRIDDEN",
              inferenceConfiguration: { temperature: 0.2, topP: 0.9, maximumLength: 1024 },
            },
            {
              promptType: "POST_PROCESSING",
              promptState: "ENABLED",
              promptCreationMode: "OVERRIDDEN",
              inferenceConfiguration: { temperature: 0.9 },
            },
          ],
        };
        return { agentVersion };
      }
      return defaultHandler(command);
    });

    const result = await subject.loader.load({
      region: "us-east-1",
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
    });

    expect(result.inferenceConfiguration).toEqual({
      temperature: 0.2,
      topP: 0.9,
      maximumLength: 1024,
    });
    expect(result.hasPromptOverrides).toBe(true);
  });

  test("paginates and normalizes enabled action groups and knowledge bases", async () => {
    const subject = loaderWith((command) => {
      if (command instanceof ListAgentActionGroupsCommand) {
        return command.input.nextToken
          ? {
              actionGroupSummaries: [
                {
                  actionGroupId: "disabled",
                  actionGroupState: "DISABLED",
                },
              ],
            }
          : {
              actionGroupSummaries: [
                {
                  actionGroupId: "weather",
                  actionGroupState: "ENABLED",
                },
              ],
              nextToken: "next-actions",
            };
      }
      if (command instanceof GetAgentActionGroupCommand) {
        return {
          agentActionGroup: {
            agentId: AGENT_ID,
            agentVersion: AGENT_VERSION,
            actionGroupId: "weather",
            actionGroupName: "weather-tools",
            actionGroupState: "ENABLED",
            functionSchema: {
              functions: [
                {
                  name: "get_weather",
                  description: "Get weather",
                  parameters: {
                    city: { type: "string", required: true },
                  },
                },
              ],
            },
          },
        };
      }
      if (command instanceof ListAgentKnowledgeBasesCommand) {
        return command.input.nextToken
          ? { agentKnowledgeBaseSummaries: [] }
          : {
              agentKnowledgeBaseSummaries: [
                {
                  knowledgeBaseId: "KB123",
                  knowledgeBaseState: "ENABLED",
                  description: "Product docs",
                },
              ],
              nextToken: "next-kbs",
            };
      }
      if (command instanceof GetKnowledgeBaseCommand) {
        return {
          knowledgeBase: {
            name: "ProductDocs",
            description: "Product docs",
            knowledgeBaseArn: "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/KB123",
          },
        };
      }
      return defaultHandler(command);
    });

    const result = await subject.loader.load({
      region: "us-east-1",
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
    });

    expect(result.actionGroups).toEqual([
      {
        name: "weather-tools",
        description: undefined,
        parentActionSignature: undefined,
        functions: [
          {
            name: "get_weather",
            description: "Get weather",
            parameters: {
              city: { type: "string", description: undefined, required: true },
            },
            requiresConfirmation: false,
          },
        ],
        hasApiSchema: false,
        hasLambdaExecutor: false,
        returnsControl: false,
      },
    ]);
    expect(result.knowledgeBases).toEqual([
      {
        id: "KB123",
        name: "ProductDocs",
        description: "Product docs",
        arn: "arn:aws:bedrock:us-east-1:111122223333:knowledge-base/KB123",
      },
    ]);
  });

  test("loads collaborators at the version recorded in the parent snapshot", async () => {
    const collaboratorId = "B1B2B3B4B5";
    const collaboratorVersion = "3";
    const subject = loaderWith((command) => {
      if (command instanceof ListAgentCollaboratorsCommand && command.input.agentId === AGENT_ID) {
        return {
          agentCollaboratorSummaries: [
            {
              agentId: collaboratorId,
              agentVersion: collaboratorVersion,
              agentDescriptor: {
                aliasArn:
                  `arn:aws:bedrock:us-east-1:111122223333:agent-alias/` +
                  `${collaboratorId}/COLLABALIAS`,
              },
              collaboratorName: "billing",
              collaborationInstruction: "Handle billing questions.",
              relayConversationHistory: "TO_COLLABORATOR",
            },
          ],
        };
      }
      return defaultHandler(command);
    });

    const result = await subject.loader.load({
      region: "us-east-1",
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
    });

    expect(result.collaborators[0]).toMatchObject({
      name: "billing",
      instruction: "Handle billing questions.",
      relayConversationHistory: "TO_COLLABORATOR",
      agent: {
        sourceAgentId: collaboratorId,
        sourceAgentAliasId: "COLLABALIAS",
        sourceAgentVersion: collaboratorVersion,
        agentName: "BillingAgent",
      },
    });
  });

  test("records and skips collaborator cycles", async () => {
    const subject = loaderWith((command) => {
      if (command instanceof ListAgentCollaboratorsCommand) {
        return {
          agentCollaboratorSummaries: [
            {
              agentId: AGENT_ID,
              agentVersion: AGENT_VERSION,
              agentDescriptor: {
                aliasArn:
                  `arn:aws:bedrock:us-east-1:111122223333:agent-alias/` + `${AGENT_ID}/${ALIAS_ID}`,
              },
              collaboratorName: "self",
              collaborationInstruction: "Delegate to self.",
            },
          ],
        };
      }
      return defaultHandler(command);
    });

    const result = await subject.loader.load({
      region: "us-east-1",
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
    });

    expect(result.collaborators).toEqual([]);
    expect(result.notes).toEqual([
      {
        category: "collaborator-cycle",
        message:
          `Skipped collaborator 'self' because it creates a cycle at ` +
          `${AGENT_ID}:${AGENT_VERSION}.`,
      },
    ]);
  });

  test("does not treat a collaborator reused by sibling entries as a cycle", async () => {
    const collaboratorId = "B1B2B3B4B5";
    const collaboratorVersion = "3";
    const subject = loaderWith((command) => {
      if (command instanceof ListAgentCollaboratorsCommand && command.input.agentId === AGENT_ID) {
        return {
          agentCollaboratorSummaries: ["billing-primary", "billing-backup"].map(
            (collaboratorName) => ({
              agentId: collaboratorId,
              agentVersion: collaboratorVersion,
              collaboratorName,
              collaborationInstruction: "Handle billing questions.",
            }),
          ),
        };
      }
      return defaultHandler(command);
    });

    const result = await subject.loader.load({
      region: "us-east-1",
      agentId: AGENT_ID,
      agentAliasId: ALIAS_ID,
    });

    expect(result.collaborators.map(({ name }) => name)).toEqual([
      "billing-primary",
      "billing-backup",
    ]);
    expect(result.notes).toEqual([]);
  });

  test("rejects an alias without exactly one routed version", async () => {
    const subject = loaderWith((command) => {
      if (command instanceof GetAgentAliasCommand) {
        return {
          agentAlias: {
            agentId: AGENT_ID,
            agentAliasId: ALIAS_ID,
            agentAliasName: "detached",
            routingConfiguration: [],
          },
        };
      }
      return defaultHandler(command);
    });

    await expect(
      subject.loader.load({
        region: "us-east-1",
        agentId: AGENT_ID,
        agentAliasId: ALIAS_ID,
      }),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("maps a missing alias to an input error", async () => {
    const subject = loaderWith((command) => {
      if (command instanceof GetAgentAliasCommand) {
        throw Object.assign(new Error("not found"), {
          name: "ResourceNotFoundException",
        });
      }
      return defaultHandler(command);
    });

    await expect(
      subject.loader.load({
        region: "us-east-1",
        agentId: AGENT_ID,
        agentAliasId: ALIAS_ID,
      }),
    ).rejects.toBeInstanceOf(InputValidationError);
  });
});
