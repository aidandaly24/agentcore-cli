import { describe, expect, test } from "bun:test";
import type {
  DeleteGatewayResponse,
  DeleteGatewayRuleResponse,
  DeleteGatewayTargetResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const REGION = "us-west-2";
const GATEWAY_ID = "gateway-1";
const TARGET_ID = "target-1";
const RULE_ID = "rule-1";

async function run(
  args: string[],
  core = new TestCoreClient(),
): Promise<{ core: TestCoreClient; stdout: string }> {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });

  await root.route(["node", "agentcore", ...args, "--region", REGION]);
  return { core, stdout: io.stdout() };
}

describe("gateway delete commands", () => {
  test("deletes a Gateway", async () => {
    const response = { gatewayId: GATEWAY_ID, status: "DELETING" } as DeleteGatewayResponse;
    const core = new TestCoreClient();
    core.gateway.setDeleteResponse(response);

    const result = await run(["gateway", "delete", "--id", GATEWAY_ID], core);

    expect(core.gateway.calls).toEqual([
      {
        method: "deleteGateway",
        args: [GATEWAY_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  test("deletes a Target", async () => {
    const response = { targetId: TARGET_ID, status: "DELETING" } as DeleteGatewayTargetResponse;
    const core = new TestCoreClient();
    core.gateway.setDeleteTargetResponse(response);

    const result = await run(
      ["gateway", "target", "delete", "--gateway-id", GATEWAY_ID, "--target-id", TARGET_ID],
      core,
    );

    expect(core.gateway.calls).toEqual([
      {
        method: "deleteGatewayTarget",
        args: [GATEWAY_ID, TARGET_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });

  test("deletes a Rule", async () => {
    const response = { ruleId: RULE_ID, status: "DELETING" } as DeleteGatewayRuleResponse;
    const core = new TestCoreClient();
    core.gateway.setDeleteRuleResponse(response);

    const result = await run(
      ["gateway", "rule", "delete", "--gateway-id", GATEWAY_ID, "--rule-id", RULE_ID],
      core,
    );

    expect(core.gateway.calls).toEqual([
      {
        method: "deleteGatewayRule",
        args: [GATEWAY_ID, RULE_ID, { region: REGION }],
      },
    ]);
    expect(JSON.parse(result.stdout)).toEqual(response);
  });
});

describe("gateway delete validation", () => {
  test.each([
    ["Gateway selector", ["gateway", "delete"], /--id/],
    ["Target parent", ["gateway", "target", "delete"], /--gateway-id/],
    ["Target selector", ["gateway", "target", "delete", "--gateway-id", GATEWAY_ID], /--target-id/],
    ["Rule parent", ["gateway", "rule", "delete"], /--gateway-id/],
    ["Rule selector", ["gateway", "rule", "delete", "--gateway-id", GATEWAY_ID], /--rule-id/],
  ] as const)("rejects a missing %s before calling Core", async (_name, args, error) => {
    const core = new TestCoreClient();

    await expect(run([...args], core)).rejects.toThrow(error);
    expect(core.gateway.calls).toEqual([]);
  });
});
