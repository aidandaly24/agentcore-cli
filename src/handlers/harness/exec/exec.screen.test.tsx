import { afterEach, describe, expect, test } from "bun:test";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeHarnessRequest,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderImperativeScreen,
  TestCoreClient,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);
const ID = "MyHarness-abc123";
const PATH = `/agentcore/harness/exec/${ID}`;

function core() {
  const value = new TestCoreClient();
  const harness = {
    harnessId: ID,
    harnessName: "MyHarness",
    arn: `arn:aws:bedrock-agentcore:us-east-1:123:harness/${ID}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    harnessVersion: "1",
    status: "READY" as const,
  };
  value.harness
    .setGetResponse({ harness } as GetHarnessResponse)
    .setListResponse({ harnesses: [harness] });
  value.harness.setExecEvents(
    { chunk: { contentDelta: { stdout: "bin\n" } } },
    { chunk: { contentStop: { exitCode: 0, status: "COMPLETED" } } },
  );
  value.harness.setInvokeEvents(
    { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "Hello from the agent" } } },
    { messageStop: { stopReason: "end_turn" } },
  );
  return value;
}

describe("Harness exec routing and chat", () => {
  test("the picker opens the shared console in exec mode", async () => {
    const screen = renderImperativeScreen("/agentcore/harness/exec", { core: core() });
    await waitForText(screen.lastFrame, "choose a harness to exec into");
    await waitForText(screen.lastFrame, "MyHarness");
    await screen.press("return");
    await waitForText(screen.lastFrame, `exec → ${ID}`);
    await waitForText(screen.lastFrame, "run a command");
    expect(screen.lastFrame()).toContain("$ ");
  });

  test("resumes the route's session and honors qualifier and timeout", async () => {
    const value = core();
    const session = "resumed-session-0123456789abcdefghijklmn";
    const screen = renderImperativeScreen(`${PATH}/${session}?qualifier=prod&timeout=60`, {
      core: value,
    });
    await waitForText(screen.lastFrame, `session: ${session}`);
    await screen.write("pwd");
    await screen.press("return");
    await waitForText(screen.lastFrame, "bin");
    const call = value.harness.calls.find(({ method }) => method === "invokeAgentRuntimeCommand")!;
    expect(call.args[0]).toMatchObject({
      runtimeSessionId: session,
      qualifier: "prod",
      body: { command: "pwd", timeout: 60 },
    });
  });

  test("chat and exec keep one session and transcript when toggling modes", async () => {
    const value = core();
    const screen = renderImperativeScreen(`/agentcore/harness/invoke/${ID}`, { core: value });
    await waitForText(screen.lastFrame, "send a message");
    await screen.write("hi agent");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Hello from the agent");
    await screen.write("\x05");
    await waitForText(screen.lastFrame, "run a command");
    expect(screen.lastFrame()).toContain("[ctrl+e] chat mode");
    await screen.write("ls /");
    await screen.press("return");
    await waitForText(screen.lastFrame, "bin");
    expect(screen.lastFrame()).toContain("❯ hi agent");
    expect(screen.lastFrame()).toContain("$ ls /");
    const invoke = value.harness.calls.find(({ method }) => method === "invokeHarness")!
      .args[0] as InvokeHarnessRequest;
    const exec = value.harness.calls.find(({ method }) => method === "invokeAgentRuntimeCommand")!
      .args[0] as InvokeAgentRuntimeCommandRequest;
    expect(exec.runtimeSessionId).toBe(invoke.runtimeSessionId!);
    await screen.write("\x05");
    await waitForText(screen.lastFrame, "send a message");
    expect(screen.lastFrame()).toContain("[ctrl+e] exec mode");
  });
});
