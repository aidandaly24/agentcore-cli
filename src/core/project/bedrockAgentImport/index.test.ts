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
import type { BedrockAgentImportRequest } from "./types";

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
  const request: BedrockAgentImportRequest = {
    runtimeName: "support",
    region: "us-east-1",
    agentId: "A1B2C3D4E5",
    agentAliasId: "TSTALIASID",
    framework: "strands",
    memory: "none",
  };

  test("translates the alias-selected version with the Strands translator", async () => {
    const importer = new BedrockAgentImporter({
      createClient: () => new FakeClient() as unknown as BedrockAgentClient,
    });

    const plan = await importer.import(request);

    expect(plan).toMatchObject({
      framework: "strands",
      sourceAgentId: "A1B2C3D4E5",
      sourceAgentAliasId: "TSTALIASID",
      sourceAgentVersion: "7",
    });
    expect(plan.files["main.py"]).toContain("from strands import Agent");
    expect(plan.files["main.py"]).toContain('SYSTEM_PROMPT = """Be helpful."""');
    expect(plan.files["pyproject.toml"]).toContain("strands-agents");
    expect(plan.files["IMPORT_NOTES.md"]).toContain("Source version: `7`");
  });

  test("translates with the LangGraph translator when requested", async () => {
    const importer = new BedrockAgentImporter({
      createClient: () => new FakeClient() as unknown as BedrockAgentClient,
    });

    const plan = await importer.import({ ...request, framework: "langgraph" });

    expect(plan.framework).toBe("langgraph");
    expect(plan.files["main.py"]).toContain("from langgraph.prebuilt import create_react_agent");
    expect(plan.files["main.py"]).not.toContain("from strands import");
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
