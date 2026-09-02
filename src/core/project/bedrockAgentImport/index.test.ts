import { describe, expect, test } from "bun:test";
import {
  BedrockAgentClient,
  GetAgentAliasCommand,
  GetAgentVersionCommand,
  ListAgentActionGroupsCommand,
  ListAgentCollaboratorsCommand,
  ListAgentKnowledgeBasesCommand,
} from "@aws-sdk/client-bedrock-agent";
import { InputValidationError } from "../../../errors";
import { BedrockAgentImporter } from ".";
import type {
  BedrockAgentImportPlan,
  BedrockAgentImportRequest,
  BedrockAgentSnapshot,
  BedrockAgentTranslator,
} from "./types";

class FakeClient {
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetAgentAliasCommand) {
      return {
        agentAlias: {
          agentId: "A1B2C3D4E5",
          agentAliasId: "TSTALIASID",
          agentAliasName: "live",
          routingConfiguration: [{ agentVersion: "7" }],
        },
      };
    }
    if (command instanceof GetAgentVersionCommand) {
      return {
        agentVersion: {
          agentId: "A1B2C3D4E5",
          agentName: "SupportAgent",
          agentArn: "arn:aws:bedrock:us-east-1:111122223333:agent/A1B2C3D4E5",
          version: "7",
          agentStatus: "PREPARED",
          foundationModel: "us.amazon.nova-lite-v1:0",
          instruction: "Be helpful.",
          idleSessionTTLInSeconds: 600,
          agentResourceRoleArn: "arn:aws:iam::111122223333:role/BedrockAgentRole",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
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
    throw new Error("unexpected command");
  }
}

describe("BedrockAgentImporter", () => {
  test("loads the selected snapshot and delegates to the requested translator", async () => {
    const calls: {
      snapshot: BedrockAgentSnapshot;
      request: BedrockAgentImportRequest;
    }[] = [];
    const plan: BedrockAgentImportPlan = {
      framework: "strands",
      sourceAgentId: "A1B2C3D4E5",
      sourceAgentAliasId: "TSTALIASID",
      sourceAgentVersion: "7",
      files: { "main.py": "# translated" },
      notes: [],
    };
    const translator: BedrockAgentTranslator = {
      translate: (snapshot, request) => {
        calls.push({ snapshot, request });
        return plan;
      },
    };
    const importer = new BedrockAgentImporter({
      createClient: () => new FakeClient() as unknown as BedrockAgentClient,
      translators: { strands: translator },
    });
    const request: BedrockAgentImportRequest = {
      runtimeName: "support",
      region: "us-east-1",
      agentId: "A1B2C3D4E5",
      agentAliasId: "TSTALIASID",
      framework: "strands",
      memory: "none",
    };

    await expect(importer.import(request)).resolves.toBe(plan);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toBe(request);
    expect(calls[0]!.snapshot).toMatchObject({
      sourceAgentVersion: "7",
      instruction: "Be helpful.",
    });
  });

  test("rejects unsupported regions before creating a service client", async () => {
    let clientCreated = false;
    const importer = new BedrockAgentImporter({
      createClient: () => {
        clientCreated = true;
        return new FakeClient() as unknown as BedrockAgentClient;
      },
    });

    await expect(
      importer.import({
        runtimeName: "support",
        region: "eu-north-1",
        agentId: "A1B2C3D4E5",
        agentAliasId: "TSTALIASID",
        framework: "strands",
        memory: "none",
      }),
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(clientCreated).toBe(false);
  });
});
