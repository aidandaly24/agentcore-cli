import { describe, expect, test } from "bun:test";
import type {
  BedrockAgentMetadata,
  DescribeBedrockAgent,
  DescribeBedrockAgentInput,
} from "../../core/project/bedrockAgent";
import { resolveImportBedrockAgentInput } from "./importBedrockAgent";

const metadata: BedrockAgentMetadata = {
  agentName: "SupportAgent",
  agentStatus: "PREPARED",
  agentAliasArn: "arn:aws:bedrock:us-east-1:111122223333:agent-alias/A1B2C3D4E5/TSTALIASID",
  agentAliasName: "live",
  agentAliasStatus: "PREPARED",
};

function describer(result: BedrockAgentMetadata = metadata): {
  describeBedrockAgent: DescribeBedrockAgent;
  calls: DescribeBedrockAgentInput[];
} {
  const calls: DescribeBedrockAgentInput[] = [];
  return {
    calls,
    describeBedrockAgent: async (input) => {
      calls.push(input);
      return result;
    },
  };
}

describe("resolveImportBedrockAgentInput", () => {
  test.each(["ap-southeast-2", "eu-central-2", "eu-west-2", "eu-west-3"])(
    "accepts predecessor-supported region %s",
    async (region) => {
      const subject = describer();

      const result = await resolveImportBedrockAgentInput({
        describeBedrockAgent: subject.describeBedrockAgent,
        region,
        agentId: "A1B2C3D4E5",
        agentAliasId: "TSTALIASID",
      });

      expect(result.imported.region).toBe(region);
      expect(subject.calls).toEqual([
        { region, agentId: "A1B2C3D4E5", agentAliasId: "TSTALIASID" },
      ]);
    },
  );

  test("warns when the selected alias is not prepared", async () => {
    const subject = describer({ ...metadata, agentAliasStatus: "FAILED" });

    const result = await resolveImportBedrockAgentInput({
      describeBedrockAgent: subject.describeBedrockAgent,
      region: "us-east-1",
      agentId: "A1B2C3D4E5",
      agentAliasId: "TSTALIASID",
    });

    expect(result.warnings).toEqual([
      "Warning: Bedrock Agent alias 'live' is in status FAILED (not PREPARED); invocations may fail until the alias is prepared.",
    ]);
  });

  test("does not warn about the mutable agent draft when the alias is prepared", async () => {
    const subject = describer({ ...metadata, agentStatus: "NOT_PREPARED" });

    const result = await resolveImportBedrockAgentInput({
      describeBedrockAgent: subject.describeBedrockAgent,
      region: "us-east-1",
      agentId: "A1B2C3D4E5",
      agentAliasId: "TSTALIASID",
    });

    expect(result.warnings).toEqual([]);
  });
});
