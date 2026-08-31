import { describe, expect, test } from "bun:test";
import type {
  GetAgentAliasCommandOutput,
  GetAgentCommandOutput,
} from "@aws-sdk/client-bedrock-agent";
import { InputValidationError, MalformedServiceResponseError } from "../../errors";
import { createDescribeBedrockAgent, type BedrockAgentControlClient } from "./bedrockAgent";

const agent = {
  agentId: "A1B2C3D4E5",
  agentName: "SupportAgent",
  agentArn: "arn:aws:bedrock:us-east-1:111122223333:agent/A1B2C3D4E5",
  agentVersion: "DRAFT",
  agentStatus: "PREPARED",
  idleSessionTTLInSeconds: 600,
  agentResourceRoleArn: "arn:aws:iam::111122223333:role/BedrockAgentRole",
  createdAt: new Date(0),
  updatedAt: new Date(0),
  foundationModel: "us.amazon.nova-lite-v1:0",
};

const agentAlias = {
  agentId: agent.agentId,
  agentAliasId: "TSTALIASID",
  agentAliasName: "live",
  agentAliasArn: `arn:aws:bedrock:us-east-1:111122223333:agent-alias/${agent.agentId}/TSTALIASID`,
  routingConfiguration: [{ agentVersion: "1" }],
  createdAt: new Date(0),
  updatedAt: new Date(0),
  agentAliasStatus: "PREPARED",
};

class TestBedrockAgentControlClient implements BedrockAgentControlClient {
  readonly calls: string[] = [];
  agentOutput: GetAgentCommandOutput = { agent } as GetAgentCommandOutput;
  aliasOutput: GetAgentAliasCommandOutput = {
    agentAlias,
  } as GetAgentAliasCommandOutput;
  agentError?: Error;
  aliasError?: Error;

  async getAgent(): Promise<GetAgentCommandOutput> {
    this.calls.push("getAgent");
    if (this.agentError) throw this.agentError;
    return this.agentOutput;
  }

  async getAgentAlias(): Promise<GetAgentAliasCommandOutput> {
    this.calls.push("getAgentAlias");
    if (this.aliasError) throw this.aliasError;
    return this.aliasOutput;
  }
}

function resourceNotFound(): Error {
  return Object.assign(new Error("not found"), { name: "ResourceNotFoundException" });
}

describe("describeBedrockAgent", () => {
  test("returns metadata from the requested agent and alias", async () => {
    const client = new TestBedrockAgentControlClient();
    const describeAgent = createDescribeBedrockAgent(() => client);

    await expect(
      describeAgent({
        region: "us-east-1",
        agentId: agent.agentId,
        agentAliasId: agentAlias.agentAliasId,
      }),
    ).resolves.toEqual({
      agentName: agent.agentName,
      agentStatus: agent.agentStatus,
      agentAliasArn: agentAlias.agentAliasArn,
      agentAliasName: agentAlias.agentAliasName,
      agentAliasStatus: agentAlias.agentAliasStatus,
      foundationModel: agent.foundationModel,
      description: undefined,
    });
    expect(client.calls).toEqual(["getAgent", "getAgentAlias"]);
  });

  test("rejects an incomplete agent response before requesting the alias", async () => {
    const client = new TestBedrockAgentControlClient();
    client.agentOutput = {} as GetAgentCommandOutput;
    const describeAgent = createDescribeBedrockAgent(() => client);

    await expect(
      describeAgent({
        region: "us-east-1",
        agentId: agent.agentId,
        agentAliasId: agentAlias.agentAliasId,
      }),
    ).rejects.toBeInstanceOf(MalformedServiceResponseError);
    expect(client.calls).toEqual(["getAgent"]);
  });

  test("rejects an alias response for a different agent", async () => {
    const client = new TestBedrockAgentControlClient();
    client.aliasOutput = {
      agentAlias: { ...agentAlias, agentId: "OTHERAGENT" },
    } as GetAgentAliasCommandOutput;
    const describeAgent = createDescribeBedrockAgent(() => client);

    await expect(
      describeAgent({
        region: "us-east-1",
        agentId: agent.agentId,
        agentAliasId: agentAlias.agentAliasId,
      }),
    ).rejects.toBeInstanceOf(MalformedServiceResponseError);
  });

  test("maps agent and alias not-found errors independently", async () => {
    const missingAgentClient = new TestBedrockAgentControlClient();
    missingAgentClient.agentError = resourceNotFound();
    const describeMissingAgent = createDescribeBedrockAgent(() => missingAgentClient);
    await expect(
      describeMissingAgent({
        region: "us-east-1",
        agentId: agent.agentId,
        agentAliasId: agentAlias.agentAliasId,
      }),
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(missingAgentClient.calls).toEqual(["getAgent"]);

    const missingAliasClient = new TestBedrockAgentControlClient();
    missingAliasClient.aliasError = resourceNotFound();
    const describeMissingAlias = createDescribeBedrockAgent(() => missingAliasClient);
    await expect(
      describeMissingAlias({
        region: "us-east-1",
        agentId: agent.agentId,
        agentAliasId: agentAlias.agentAliasId,
      }),
    ).rejects.toBeInstanceOf(InputValidationError);
    expect(missingAliasClient.calls).toEqual(["getAgent", "getAgentAlias"]);
  });
});
