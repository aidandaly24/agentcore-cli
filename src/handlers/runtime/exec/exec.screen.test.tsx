import { afterEach, describe, expect, test } from "bun:test";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderImperativeScreen,
  renderScreen,
  StreamController,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";
import { RuntimeExecLaunchContextKey } from "./launchContext";

afterEach(cleanupScreens);

const ID = "checkout-AbCdEf1234";
const ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${ID}`;
const PATH = `/agentcore/runtime/exec/${ID}`;
const SESSION = "session-012345678901234567890123456789";

function execCore() {
  const core = new TestCoreClient();
  core.runtime.setGetResponse({
    agentRuntimeId: ID,
    agentRuntimeArn: ARN,
    status: "READY",
  } as GetAgentRuntimeResponse);
  core.runtime.setListResponse({
    agentRuntimes: [
      {
        agentRuntimeId: ID,
        agentRuntimeArn: ARN,
        agentRuntimeName: "checkout",
        description: "Runtime exec test",
        agentRuntimeVersion: "1",
        status: "READY",
        lastUpdatedAt: new Date(),
      },
    ],
  });
  core.runtime.setListEndpointsResponse({
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
  core.runtime.setExecEvents(
    { chunk: { contentDelta: { stdout: "hello\n" } } },
    { chunk: { contentStop: { status: "COMPLETED", exitCode: 0 } } },
  );
  return core;
}

function execCalls(core: TestCoreClient) {
  return core.runtime.calls.filter(({ method }) => method === "invokeAgentRuntimeCommand");
}

async function run(screen: ReturnType<typeof renderScreen>, command: string) {
  await screen.write(command);
  await screen.press("return");
}

describe("Runtime exec screen", () => {
  test("selects a Runtime and endpoint, runs commands, and reuses the session", async () => {
    const core = execCore();
    const screen = renderImperativeScreen("/agentcore/runtime/exec", { core });
    await waitForText(screen.lastFrame, ID);
    await screen.press("return");
    await waitForText(screen.lastFrame, "choose an endpoint to exec into");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "run a command...");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "hello");
    expect(screen.lastFrame()).toContain("$ ls");
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "$ pwd");
    const requests = execCalls(core).map(({ args }) => args[0] as InvokeAgentRuntimeCommandRequest);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      agentRuntimeArn: ARN,
      qualifier: "DEFAULT",
      body: { command: "ls" },
    });
    expect(requests[0]!.runtimeSessionId).toHaveLength(36);
    expect(requests[1]!.runtimeSessionId).toBe(requests[0]!.runtimeSessionId);
    expect(core.harness.calls).toEqual([]);
  });

  test("retains CLI session and timeout through endpoint selection", async () => {
    const core = execCore();
    const screen = renderImperativeScreen(PATH, {
      core,
      withContext: (ctx) =>
        ctx.withValue(RuntimeExecLaunchContextKey, {
          runtimeId: ID,
          runtimeSessionId: SESSION,
          timeout: 60,
        }),
    });
    await waitForText(screen.lastFrame, "prod");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, `session: ${SESSION}`);
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "hello");
    expect(execCalls(core)[0]!.args[0]).toMatchObject({
      runtimeSessionId: SESSION,
      qualifier: "prod",
      body: { command: "pwd", timeout: 60 },
    });
    expect(core.runtime.calls.some(({ method }) => method === "listRuntimes")).toBe(false);
  });

  test("is reachable from Runtime details with standalone commands disabled and Esc returns", async () => {
    const core = execCore();
    const screen = renderScreen(`/agentcore/runtime/get/${ID}`, { core });
    await waitForText(screen.lastFrame, "run a shell command");
    for (let i = 0; i < 3; i++) await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "show the full JSON definition");
    for (let i = 0; i < 3; i++) await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "run a command...");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "hello");
    await screen.press("escape");
    await waitForText(screen.lastFrame, "show the full JSON definition");
  });

  test("streams output, ignores duplicate submits, interrupts, and can run again", async () => {
    const core = execCore();
    const stream = new StreamController<InvokeAgentRuntimeCommandStreamOutput>();
    core.runtime.queueExecStream(stream);
    const screen = renderImperativeScreen(`${PATH}/DEFAULT`, { core });
    await waitForText(screen.lastFrame, "run a command...");
    await run(screen, "sleep 999");
    await waitForText(screen.lastFrame, "working...");
    stream.emit({ chunk: { contentDelta: { stdout: "partial\n" } } });
    await waitForText(screen.lastFrame, "partial");
    await run(screen, "ls");
    expect(execCalls(core)).toHaveLength(1);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "interrupted");
    expect((execCalls(core)[0]!.args[2] as AbortSignal).aborted).toBe(true);
    await screen.press("return");
    await waitForText(screen.lastFrame, "hello");
    expect(execCalls(core)).toHaveLength(2);
  });

  test("unmount aborts an active command", async () => {
    const core = execCore();
    core.runtime.queueExecStream(new StreamController<InvokeAgentRuntimeCommandStreamOutput>());
    const screen = renderImperativeScreen(`${PATH}/DEFAULT`, { core });
    await waitForText(screen.lastFrame, "run a command...");
    await run(screen, "sleep 999");
    await waitForText(screen.lastFrame, "working...");
    screen.unmount();
    await waitFor(() => (execCalls(core)[0]!.args[2] as AbortSignal).aborted);
  });

  test("renders failing commands and transport errors, then recovers", async () => {
    const core = execCore();
    core.runtime.setExecEvents(
      { chunk: { contentDelta: { stderr: "permission denied\n" } } },
      { chunk: { contentStop: { exitCode: 2, status: "COMPLETED" } } },
    );
    const screen = renderImperativeScreen(`${PATH}/DEFAULT`, { core });
    await waitForText(screen.lastFrame, "run a command...");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "exit 2");
    expect(screen.lastFrame()).toContain("permission denied");
    core.runtime.setError(new Error("runtime unreachable"));
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "runtime unreachable");
    core.runtime
      .setError(undefined)
      .setExecEvents({ chunk: { contentStop: { exitCode: 0, status: "COMPLETED" } } });
    await run(screen, "true");
    await waitForText(screen.lastFrame, "$ true");
    await waitForText(screen.lastFrame, "session:");
  });

  test("endpoint switching starts a new session and clears the previous transcript", async () => {
    const core = execCore();
    const screen = renderImperativeScreen(`${PATH}/DEFAULT`, { core });
    await waitForText(screen.lastFrame, "run a command...");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "hello");
    await screen.write("\x14");
    await waitForText(screen.lastFrame, "prod");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "qualifier: prod");
    expect(screen.lastFrame()).not.toContain("$ ls");
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "hello");
    const [first, second] = execCalls(core).map(
      ({ args }) => args[0] as InvokeAgentRuntimeCommandRequest,
    );
    expect(second!.qualifier).toBe("prod");
    expect(second!.runtimeSessionId).not.toBe(first!.runtimeSessionId);
  });

  test("empty input does not execute and a narrow terminal stays bounded", async () => {
    const core = execCore();
    const screen = renderImperativeScreen(`${PATH}/DEFAULT`, { core });
    await waitForText(screen.lastFrame, "run a command...");
    await screen.press("return");
    expect(execCalls(core)).toEqual([]);
    await screen.resize(60, 20);
    await run(screen, "printf hello");
    await waitForText(screen.lastFrame, "hello");
    expect(screen.lastFrame()!.split("\n")).toHaveLength(20);
    expect(screen.lastFrame()).toContain("session:");
  });

  test("a long command draft keeps its cursor, status, and footer visible", async () => {
    const core = execCore();
    const screen = renderImperativeScreen(`${PATH}/DEFAULT`, { core });
    await waitForText(screen.lastFrame, "run a command...");
    await screen.resize(60, 20);
    const command = `printf '${"command-".repeat(20)}visible-tail'`;
    await screen.write(command);
    expect(screen.lastFrame()).toContain("visible-tail'");
    expect(screen.lastFrame()).toContain("session:");
    expect(screen.lastFrame()).toContain("[enter] run");
    expect(screen.lastFrame()!.split("\n")).toHaveLength(20);
    await screen.press("return");
    await waitForText(screen.lastFrame, "hello");
    expect(execCalls(core)[0]!.args[0]).toMatchObject({ body: { command } });
  });
});
