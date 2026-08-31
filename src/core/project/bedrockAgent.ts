import {
  BedrockAgentClient,
  GetAgentAliasCommand,
  GetAgentCommand,
  type GetAgentAliasCommandOutput,
  type GetAgentCommandOutput,
} from "@aws-sdk/client-bedrock-agent";
import { InputValidationError, MalformedServiceResponseError } from "../../errors";

/**
 * Regions where an Amazon Bedrock Agent can live for `--type import`,
 * mirroring the original CLI's supported-region list.
 */
export const BEDROCK_AGENT_IMPORT_REGIONS = [
  "us-east-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-central-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-south-1",
  "ca-central-1",
  "sa-east-1",
  "us-gov-west-1",
] as const;

export type BedrockAgentImportRegion = (typeof BEDROCK_AGENT_IMPORT_REGIONS)[number];

export type DescribeBedrockAgentInput = {
  region: string;
  agentId: string;
  agentAliasId: string;
};

/** What the proxy scaffold needs to know about the imported agent. */
export type BedrockAgentMetadata = {
  agentName: string;
  agentStatus: string;
  agentAliasArn: string;
  agentAliasName: string;
  agentAliasStatus: string;
  foundationModel?: string;
  description?: string;
};

export type DescribeBedrockAgent = (
  input: DescribeBedrockAgentInput,
) => Promise<BedrockAgentMetadata>;

export interface BedrockAgentControlClient {
  getAgent(agentId: string): Promise<GetAgentCommandOutput>;
  getAgentAlias(agentId: string, agentAliasId: string): Promise<GetAgentAliasCommandOutput>;
}

class AwsBedrockAgentControlClient implements BedrockAgentControlClient {
  private readonly client: BedrockAgentClient;

  constructor(region: string) {
    this.client = new BedrockAgentClient({ region });
  }

  getAgent(agentId: string): Promise<GetAgentCommandOutput> {
    return this.client.send(new GetAgentCommand({ agentId }));
  }

  getAgentAlias(agentId: string, agentAliasId: string): Promise<GetAgentAliasCommandOutput> {
    return this.client.send(new GetAgentAliasCommand({ agentId, agentAliasId }));
  }
}

function isNamedError(error: unknown, name: string): boolean {
  return error instanceof Error && error.name === name;
}

/**
 * Describes the agent and its alias through the Bedrock Agent control plane,
 * both to fail fast on a nonexistent agent/alias and to capture the metadata
 * the scaffolded proxy embeds.
 */
export function createDescribeBedrockAgent(
  createClient: (region: string) => BedrockAgentControlClient = (region) =>
    new AwsBedrockAgentControlClient(region),
): DescribeBedrockAgent {
  return async (input) => {
    const client = createClient(input.region);

    let agent;
    try {
      ({ agent } = await client.getAgent(input.agentId));
    } catch (error) {
      if (isNamedError(error, "ResourceNotFoundException")) {
        throw new InputValidationError(
          `no Bedrock Agent with id '${input.agentId}' exists in ${input.region}; ` +
            `check --agent-id and --region`,
          { cause: error },
        );
      }
      throw error;
    }

    if (!agent?.agentId || agent.agentId !== input.agentId || !agent.agentName) {
      throw new MalformedServiceResponseError(
        `the Bedrock Agent service returned an incomplete description for agent '${input.agentId}'`,
      );
    }

    let agentAlias;
    try {
      ({ agentAlias } = await client.getAgentAlias(input.agentId, input.agentAliasId));
    } catch (error) {
      if (isNamedError(error, "ResourceNotFoundException")) {
        throw new InputValidationError(
          `Bedrock Agent '${input.agentId}' has no alias with id '${input.agentAliasId}' in ` +
            `${input.region}; check --agent-alias-id`,
          { cause: error },
        );
      }
      throw error;
    }

    if (
      !agentAlias?.agentId ||
      agentAlias.agentId !== input.agentId ||
      !agentAlias.agentAliasId ||
      agentAlias.agentAliasId !== input.agentAliasId ||
      !agentAlias.agentAliasArn ||
      !agentAlias.agentAliasName
    ) {
      throw new MalformedServiceResponseError(
        `the Bedrock Agent service returned an incomplete description for agent ` +
          `'${input.agentId}' / alias '${input.agentAliasId}'`,
      );
    }

    return {
      agentName: agent.agentName,
      agentStatus: agent.agentStatus ?? "UNKNOWN",
      agentAliasArn: agentAlias.agentAliasArn,
      agentAliasName: agentAlias.agentAliasName,
      agentAliasStatus: agentAlias.agentAliasStatus ?? "UNKNOWN",
      foundationModel: agent.foundationModel,
      description: agent.description,
    };
  };
}

export const describeBedrockAgent = createDescribeBedrockAgent();
