import { expect, test } from "bun:test";
import {
  DeleteGatewayCommand,
  DeleteGatewayRuleCommand,
  DeleteGatewayTargetCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { GatewayClient } from "./gateway";
import type { AwsClients } from "./types";

test("maps Gateway, Target, and Rule selectors to their delete commands", async () => {
  const commands: unknown[] = [];
  const control = {
    send: async (command: unknown) => {
      commands.push(command);
      return {};
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
  };
  const gateway = new GatewayClient(clients);
  const options = { region: "us-west-2" };

  await gateway.deleteGateway("gateway-1", options);
  await gateway.deleteGatewayTarget("gateway-1", "target-1", options);
  await gateway.deleteGatewayRule("gateway-1", "rule-1", options);

  expect(commands).toHaveLength(3);
  expect(commands[0]).toBeInstanceOf(DeleteGatewayCommand);
  expect((commands[0] as DeleteGatewayCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
  });
  expect(commands[1]).toBeInstanceOf(DeleteGatewayTargetCommand);
  expect((commands[1] as DeleteGatewayTargetCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
    targetId: "target-1",
  });
  expect(commands[2]).toBeInstanceOf(DeleteGatewayRuleCommand);
  expect((commands[2] as DeleteGatewayRuleCommand).input).toEqual({
    gatewayIdentifier: "gateway-1",
    ruleId: "rule-1",
  });
});
