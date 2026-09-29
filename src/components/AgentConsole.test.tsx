import { afterEach, describe, expect, test } from "bun:test";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import type {
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  cleanupScreens,
  renderImperativeScreen,
  StreamController,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../testing";

afterEach(cleanupScreens);
const ID = "agent-AbCdEf1234";
type Kind = "harness" | "runtime";
const arn = (kind: Kind) => `arn:aws:bedrock-agentcore:us-east-1:123456789012:${kind}/${ID}`;
const path = (kind: Kind) => `/agentcore/${kind}/exec/${ID}${kind === "runtime" ? "/DEFAULT" : ""}`;
const calls = (core: TestCoreClient, kind: Kind) =>
  core[kind].calls.filter(({ method }) => method === "invokeAgentRuntimeCommand");

function execCore(kind: Kind) {
  const core = new TestCoreClient();
  core.harness.setGetResponse({
    harness: { harnessId: ID, arn: arn("harness") },
  } as GetHarnessResponse);
  core.runtime.setGetResponse({
    agentRuntimeId: ID,
    agentRuntimeArn: arn("runtime"),
  } as GetAgentRuntimeResponse);
  core[kind].setExecEvents(
    { chunk: { contentDelta: { stdout: "hello\n" } } },
    { chunk: { contentDelta: { stderr: "warning\n" } } },
    { chunk: { contentStop: { status: "COMPLETED", exitCode: 0 } } },
  );
  return core;
}

async function run(screen: ReturnType<typeof renderImperativeScreen>, command: string) {
  await screen.write(command);
  await screen.press("return");
}

describe.each(["harness", "runtime"] as const)("%s command console", (kind) => {
  test("renders streamed output and reuses its session across commands", async () => {
    const core = execCore(kind);
    const screen = renderImperativeScreen(path(kind), { core });
    await waitForText(screen.lastFrame, "run a command");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "hello");
    expect(screen.lastFrame()).toContain("$ ls");
    expect(screen.lastFrame()).toContain("warning");
    expect(screen.lastFrame()).not.toContain("exit 0");
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "$ pwd");
    const [first, second] = calls(core, kind).map(
      ({ args }) => args[0] as InvokeAgentRuntimeCommandRequest,
    );
    expect(first).toMatchObject({
      agentRuntimeArn: arn(kind),
      qualifier: "DEFAULT",
      body: { command: "ls" },
    });
    expect(first!.runtimeSessionId).toHaveLength(36);
    expect(second!.runtimeSessionId).toBe(first!.runtimeSessionId);
    expect(core[kind === "runtime" ? "harness" : "runtime"].calls).toEqual([]);
  });

  test("streams output, ignores duplicate submits, interrupts, and recovers", async () => {
    const core = execCore(kind);
    const stream = new StreamController<InvokeAgentRuntimeCommandStreamOutput>();
    core[kind].queueExecStream(stream);
    const screen = renderImperativeScreen(path(kind), { core });
    await waitForText(screen.lastFrame, "run a command");
    await run(screen, "sleep 999");
    await waitForText(screen.lastFrame, "working");
    stream.emit({ chunk: { contentDelta: { stdout: "partial\n" } } });
    await waitForText(screen.lastFrame, "partial");
    await run(screen, "ls");
    expect(calls(core, kind)).toHaveLength(1);
    await screen.press("escape");
    await waitForText(screen.lastFrame, "interrupted");
    expect((calls(core, kind)[0]!.args[2] as AbortSignal).aborted).toBe(true);
    await screen.press("return");
    await waitForText(screen.lastFrame, "hello");
    expect(calls(core, kind)).toHaveLength(2);
  });

  test("unmount aborts an active command", async () => {
    const core = execCore(kind);
    core[kind].queueExecStream(new StreamController<InvokeAgentRuntimeCommandStreamOutput>());
    const screen = renderImperativeScreen(path(kind), { core });
    await waitForText(screen.lastFrame, "run a command");
    await run(screen, "sleep 999");
    await waitForText(screen.lastFrame, "working");
    screen.unmount();
    await waitFor(() => (calls(core, kind)[0]!.args[2] as AbortSignal).aborted);
  });

  test("shows a command's failure output and exit code", async () => {
    const core = execCore(kind);
    core[kind].setExecEvents(
      { chunk: { contentDelta: { stderr: "permission denied\n" } } },
      { chunk: { contentStop: { exitCode: 2, status: "COMPLETED" } } },
    );
    const screen = renderImperativeScreen(path(kind), { core });
    await waitForText(screen.lastFrame, "run a command");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "exit 2");
    expect(screen.lastFrame()).toContain("permission denied");
  });

  test("reports transport failures and returns to idle", async () => {
    const core = execCore(kind);
    core[kind].queueExecStream(
      (async function* () {
        yield { chunk: { contentDelta: { stdout: "partial" } } };
        throw new Error("runtime unreachable");
      })(),
    );
    const screen = renderImperativeScreen(path(kind), { core });
    await waitForText(screen.lastFrame, "run a command");
    await run(screen, "ls");
    await waitForText(screen.lastFrame, "runtime unreachable");
    await waitForText(screen.lastFrame, "session:");
    await run(screen, "pwd");
    await waitForText(screen.lastFrame, "hello");
  });

  test("ignores empty input and keeps long drafts editable at narrow widths", async () => {
    const core = execCore(kind);
    const screen = renderImperativeScreen(path(kind), { core });
    await waitForText(screen.lastFrame, "run a command");
    await screen.press("return");
    expect(calls(core, kind)).toEqual([]);
    await screen.resize(60, 20);
    const command = `printf '${"command-".repeat(20)}visible-tail'`;
    await screen.write(command);
    expect(screen.lastFrame()).toContain("visible-tail'");
    expect(screen.lastFrame()).toContain("session:");
    expect(screen.lastFrame()).toContain("[enter] run");
    expect(screen.lastFrame()!.split("\n")).toHaveLength(20);
    await screen.press("return");
    await waitForText(screen.lastFrame, "hello");
    expect(calls(core, kind)[0]!.args[0]).toMatchObject({ body: { command } });
  });
});
