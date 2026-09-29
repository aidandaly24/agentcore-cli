import { afterEach, describe, expect, test } from "bun:test";
import type { InvokeAgentRuntimeCommandRequest } from "@aws-sdk/client-bedrock-agentcore";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderImperativeScreen,
  TestCoreClient,
  waitForText,
} from "../../../testing";
import { RuntimeExecLaunchContextKey } from "./launchContext";

afterEach(cleanupScreens);
const ID = "checkout-AbCdEf1234";
const ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${ID}`;
const PATH = `/agentcore/runtime/exec/${ID}`;

function core() {
  const value = new TestCoreClient();
  value.runtime.setGetResponse({
    agentRuntimeId: ID,
    agentRuntimeArn: ARN,
    status: "READY",
  } as GetAgentRuntimeResponse);
  value.runtime.setListResponse({
    agentRuntimes: [
      {
        agentRuntimeId: ID,
        agentRuntimeArn: ARN,
        agentRuntimeName: "checkout",
        description: "",
        agentRuntimeVersion: "1",
        status: "READY",
        lastUpdatedAt: new Date(),
      },
    ],
  });
  value.runtime.setListEndpointsResponse({
    runtimeEndpoints: ["DEFAULT", "prod"].map((name) => ({
      name,
      id: name,
      agentRuntimeArn: ARN,
      agentRuntimeEndpointArn: `${ARN}/runtime-endpoint/${name}`,
      status: "READY",
      liveVersion: "1",
      createdAt: new Date(),
      lastUpdatedAt: new Date(),
    })),
  });
  value.runtime.setExecEvents(
    { chunk: { contentDelta: { stdout: "hello\n" } } },
    { chunk: { contentStop: { status: "COMPLETED", exitCode: 0 } } },
  );
  return value;
}

describe("Runtime exec routing", () => {
  test("selects a Runtime and endpoint before opening the shared exec-only console", async () => {
    const screen = renderImperativeScreen("/agentcore/runtime/exec", { core: core() });
    await waitForText(screen.lastFrame, ID);
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "run a command");
    await screen.write("\x05");
    expect(screen.lastFrame()).not.toContain("chat mode");
    expect(screen.lastFrame()).toContain("run a command");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose an endpoint");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "choose a Runtime");
  });

  test("retains CLI session and timeout through endpoint selection", async () => {
    const value = core();
    const session = "session-012345678901234567890123456789";
    const screen = renderImperativeScreen(PATH, {
      core: value,
      withContext: (ctx) =>
        ctx.withValue(RuntimeExecLaunchContextKey, {
          runtimeId: ID,
          runtimeSessionId: session,
          timeout: 60,
        }),
    });
    await waitForText(screen.lastFrame, "prod");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, `session: ${session}`);
    await screen.write("pwd");
    await screen.press("return");
    await waitForText(screen.lastFrame, "hello");
    const call = value.runtime.calls.find(({ method }) => method === "invokeAgentRuntimeCommand")!;
    expect(call.args[0]).toMatchObject({
      runtimeSessionId: session,
      qualifier: "prod",
      body: { command: "pwd", timeout: 60 },
    });
    expect(value.runtime.calls.some(({ method }) => method === "listRuntimes")).toBe(false);
  });

  test("switching endpoints starts a fresh session and clears the transcript", async () => {
    const value = core();
    const screen = renderImperativeScreen(`${PATH}/DEFAULT`, { core: value });
    await waitForText(screen.lastFrame, "run a command");
    await screen.write("ls");
    await screen.press("return");
    await waitForText(screen.lastFrame, "hello");
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "prod");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "qualifier: prod");
    expect(screen.lastFrame()).not.toContain("$ ls");
    await screen.write("pwd");
    await screen.press("return");
    await waitForText(screen.lastFrame, "hello");
    const [first, second] = value.runtime.calls
      .filter(({ method }) => method === "invokeAgentRuntimeCommand")
      .map(({ args }) => args[0] as InvokeAgentRuntimeCommandRequest);
    expect(second!.qualifier).toBe("prod");
    expect(second!.runtimeSessionId).not.toBe(first!.runtimeSessionId);
  });
});
