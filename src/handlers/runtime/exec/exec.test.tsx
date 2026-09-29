import { describe, expect, spyOn, test } from "bun:test";
import type { InvokeAgentRuntimeCommandStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import { AccessDeniedException } from "@aws-sdk/client-bedrock-agentcore";
import type { GetAgentRuntimeResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../../index";
import { DEFAULT_GLOBAL_CONFIG } from "../../../globalConfig";
import {
  IMPERATIVE_GLOBAL_CONFIG,
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import * as tui from "../../../tui";
import { RuntimeExecLaunchContextKey } from "./launchContext";

const ID = "checkout-AbCdEf1234";
const ARN = `arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/${ID}`;
const SESSION = "session-012345678901234567890123456789";
const EVENTS: InvokeAgentRuntimeCommandStreamOutput[] = [
  { chunk: { contentDelta: { stdout: "hello\n" } } },
  { chunk: { contentDelta: { stderr: "warning\n" } } },
  { chunk: { contentStop: { status: "COMPLETED", exitCode: 0 } } },
];

function setup(imperative = true) {
  const core = new TestCoreClient();
  core.runtime
    .setGetResponse({ agentRuntimeArn: ARN } as GetAgentRuntimeResponse)
    .setExecEvents(...EVENTS);
  const io = testIO();
  const globalConfig = imperative ? IMPERATIVE_GLOBAL_CONFIG : DEFAULT_GLOBAL_CONFIG;
  const root = createRootHandler(core, {
    io: io.io,
    globalConfig,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor({ initialConfigData: globalConfig }),
  });
  return {
    core,
    stdout: io.stdout,
    run: (args: string[]) =>
      root.route(["node", "agentcore", "runtime", "exec", ...args, "--region", "us-west-2"]),
  };
}

describe("runtime exec", () => {
  test("executes against the Runtime ARN and emits the Harness-compatible result", async () => {
    const { run, core, stdout } = setup();
    await run(["--id", ID, "--command", "printf hello"]);
    expect(core.runtime.calls.map(({ method }) => method)).toEqual([
      "getRuntime",
      "invokeAgentRuntimeCommand",
    ]);
    expect(core.harness.calls).toEqual([]);
    expect(core.runtime.calls[1]!.args.slice(0, 2)).toEqual([
      {
        agentRuntimeArn: ARN,
        qualifier: "DEFAULT",
        runtimeSessionId: undefined,
        body: { command: "printf hello", timeout: undefined },
      },
      { region: "us-west-2" },
    ]);
    expect(JSON.parse(stdout())).toEqual({
      command: "printf hello",
      exitCode: 0,
      status: "success",
      output: "hello\nwarning\n",
    });
  });

  test("passes the qualifier, session, timeout, and region", async () => {
    const { run, core, stdout } = setup();
    await run([
      "--id",
      ID,
      "--command",
      "ls",
      "--qualifier",
      "prod",
      "--session-id",
      SESSION,
      "--timeout",
      "60",
      "--json",
    ]);
    expect(core.runtime.calls[1]!.args.slice(0, 2)).toEqual([
      {
        agentRuntimeArn: ARN,
        qualifier: "prod",
        runtimeSessionId: SESSION,
        body: { command: "ls", timeout: 60 },
      },
      { region: "us-west-2" },
    ]);
    expect(JSON.parse(stdout()).sessionId).toBe(SESSION);
  });

  test("returns a service-generated session ID", async () => {
    const { run, core, stdout } = setup();
    core.runtime.invokeAgentRuntimeCommand = async () => ({
      statusCode: 200,
      contentType: "application/json",
      runtimeSessionId: SESSION,
      stream: (async function* () {
        yield* EVENTS;
      })(),
    });
    await run(["--id", ID, "--command", "pwd"]);
    expect(JSON.parse(stdout()).sessionId).toBe(SESSION);
  });

  test.each([
    [
      "nonzero exit",
      [{ chunk: { contentStop: { status: "COMPLETED", exitCode: 2 } } }],
      { exitCode: 2 },
    ],
    [
      "timeout",
      [{ chunk: { contentStop: { status: "TIMED_OUT", exitCode: -1 } } }],
      { output: "command timed out\n" },
    ],
    [
      "service error",
      [
        {
          accessDeniedException: new AccessDeniedException({
            message: "not allowed",
            $metadata: {},
          }),
        },
      ],
      { output: "not allowed\n" },
    ],
    [
      "incomplete stream",
      [{ chunk: { contentDelta: { stdout: "partial" } } }],
      { output: "partial" },
    ],
    ["empty stream", [], { output: "" }],
  ] satisfies [string, InvokeAgentRuntimeCommandStreamOutput[], object][])(
    "reports %s",
    async (_name, events, expected) => {
      const { run, core, stdout } = setup();
      core.runtime.setExecEvents(...events);
      await run(["--id", ID, "--command", "ls"]);
      expect(JSON.parse(stdout())).toMatchObject({ status: "error", ...expected });
    },
  );

  test.each([
    ["missing ID", ["--command", "ls"]],
    ["ARN as ID", ["--id", ARN, "--command", "ls"]],
    ["empty command", ["--id", ID, "--command", "   "]],
    ["missing command in JSON mode", ["--id", ID, "--json"]],
    ["short session", ["--id", ID, "--command", "ls", "--session-id", "short"]],
    ["long session", ["--id", ID, "--command", "ls", "--session-id", "s".repeat(101)]],
    ["zero timeout", ["--id", ID, "--command", "ls", "--timeout", "0"]],
    ["large timeout", ["--id", ID, "--command", "ls", "--timeout", "3601"]],
    ["fractional timeout", ["--id", ID, "--command", "ls", "--timeout", "1.5"]],
    ["empty qualifier", ["--id", ID, "--command", "ls", "--qualifier", ""]],
  ])("rejects %s before calling Core", async (_name, args) => {
    const { run, core } = setup();
    await expect(run(args!)).rejects.toMatchObject({ exitCode: 2 });
    expect(core.runtime.calls).toEqual([]);
  });

  test("requires the imperative-command gate", async () => {
    const { run, core } = setup(false);
    await expect(run([])).rejects.toThrow("unknown command");
    expect(core.runtime.calls).toEqual([]);
  });

  test("rejects a Runtime without an ARN", async () => {
    const { run, core } = setup();
    core.runtime.setGetResponse({} as GetAgentRuntimeResponse);
    await expect(run(["--id", ID, "--command", "ls"])).rejects.toThrow("Runtime returned no ARN");
    expect(core.runtime.calls).toHaveLength(1);
  });

  test("preserves transport failures", async () => {
    const { run, core } = setup();
    core.runtime.queueExecStream(
      (async function* () {
        yield { chunk: { contentDelta: { stdout: "partial" } } };
        throw new Error("connection lost");
      })(),
    );
    await expect(run(["--id", ID, "--command", "ls"])).rejects.toThrow("connection lost");
  });

  test("opens the bare Runtime picker through the TUI middleware", async () => {
    const { run, core } = setup();
    await expect(run([])).rejects.toThrow("interactive mode requires a TTY");
    expect(core.runtime.calls).toEqual([]);
  });

  test("deep-links the TUI and retains the session and timeout through endpoint selection", async () => {
    const { run, core } = setup();
    const render = spyOn(tui, "renderTuiAt").mockResolvedValue(undefined);
    try {
      await run(["--id", "runtime/blue one", "--session-id", SESSION, "--timeout", "60"]);
      await run(["--id", ID, "--qualifier", "prod/green one"]);
      expect(render.mock.calls.map(([path]) => path)).toEqual([
        "/agentcore/runtime/exec/runtime%2Fblue%20one",
        `/agentcore/runtime/exec/${ID}/prod%2Fgreen%20one`,
      ]);
      expect(render.mock.calls[0]![1].value(RuntimeExecLaunchContextKey)).toEqual({
        runtimeId: "runtime/blue one",
        runtimeSessionId: SESSION,
        timeout: 60,
      });
      expect(core.runtime.calls).toEqual([]);
    } finally {
      render.mockRestore();
    }
  });
});
