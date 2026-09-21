import { describe, expect, test } from "bun:test";
import type { InvokeHarnessStreamOutput } from "@aws-sdk/client-bedrock-agentcore";
import type {
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { UserCancellationError } from "../../../errors";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import {
  createSilentLogger,
  StreamController,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  tick,
  waitFor,
} from "../../../testing";
import { createRootHandler } from "../../index";

const TARGET = { name: "default", account: "111122223333", region: "us-east-1" } as const;
const RUNTIME_ID = "checkout-AbCdEf1234";
const HARNESS_ID = "support-AbCdEf1234";
const COMMANDS = [
  { kind: "runtime", args: ["project", "invoke", "runtime", "--payload", "{}"] },
  { kind: "runtime", args: ["runtime", "invoke", "--id", RUNTIME_ID, "--payload", "{}"] },
  { kind: "harness", args: ["project", "invoke", "harness", "--prompt", "hello"] },
  { kind: "harness", args: ["harness", "invoke", "--id", HARNESS_ID, "--prompt", "hello"] },
] as const;

function invocation(
  command: (typeof COMMANDS)[number],
  { isTTY = true, json = false }: { isTTY?: boolean; json?: boolean } = {},
) {
  const core = new TestCoreClient();
  core.projectManager.resolve = async () => ({
    name: "orders",
    rootPath: "/tmp/orders",
    spec: ProjectSpecSchema.parse({
      name: "orders",
      version: 1,
      runtimes: [
        {
          name: "checkout",
          build: "CodeZip",
          entrypoint: "main.py",
          codeLocation: "app/checkout",
          runtimeVersion: "PYTHON_3_14",
        },
      ],
      harnesses: [{ name: "support", path: "app/support" }],
    }),
  });
  core.projectManager.resolveDeployedResource = async () => ({
    resourceType: command.kind,
    name: command.kind === "runtime" ? "checkout" : "support",
    id: command.kind === "runtime" ? RUNTIME_ID : HARNESS_ID,
    target: TARGET,
    credentialProvider: async () => ({ accessKeyId: "test-key", secretAccessKey: "test-secret" }),
  });
  core.runtime.setGetResponse({
    agentRuntimeArn: `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}:runtime/${RUNTIME_ID}`,
  } as GetAgentRuntimeResponse);
  core.harness.setGetResponse({
    harness: {
      harnessId: HARNESS_ID,
      arn: `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}:harness/${HARNESS_ID}`,
    },
  } as GetHarnessResponse);
  const headers = Promise.withResolvers<void>();
  const runtimeBody = new StreamController<Uint8Array>();
  const harnessBody = new StreamController<InvokeHarnessStreamOutput>();
  const called = Promise.withResolvers<AbortSignal | undefined>();
  core.runtime.invokeRuntime = async (_input, _options, signal) => {
    called.resolve(signal);
    await headers.promise;
    return { statusCode: 200, contentType: "text/plain", body: runtimeBody };
  };
  core.harness.invokeHarness = async (_input, _options, signal) => {
    called.resolve(signal);
    await headers.promise;
    return { stream: harnessBody };
  };
  const io = testIO({ isTTY });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  const finish = () => {
    headers.resolve();
    runtimeBody.emit(Buffer.from("done"));
    runtimeBody.end();
    harnessBody.emit({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: "done" } } });
    harnessBody.end();
  };
  return {
    core,
    io,
    headers,
    runtimeBody,
    harnessBody,
    called,
    finish,
    run: () => root.route(["node", "agentcore", ...command.args, ...(json ? ["--json"] : [])]),
  };
}

describe.each([...COMMANDS])("$args progress", (command) => {
  test("shows activity before headers and body, then stops before output", async () => {
    const subject = invocation(command);
    const pending = subject.run();
    let stderrAtOutput: string | undefined;
    subject.io.io.stdout.on("data", () => {
      stderrAtOutput = subject.io.stderr();
    });
    try {
      await subject.called.promise;
      await waitFor(() => subject.io.stderr().includes(`Invoking ${command.kind}...`));
      subject.headers.resolve();
      const beforeBody = subject.io.stderr();
      await waitFor(() => subject.io.stderr() !== beforeBody);
      expect(subject.io.stdout()).toBe("");
    } finally {
      subject.finish();
      await pending;
    }
    expect(stderrAtOutput).toContain("\u001b[?25h");
    const completed = subject.io.stderr();
    await tick(120);
    expect(subject.io.stderr()).toBe(completed);
    if (command.kind === "runtime") expect(subject.io.stdout()).toBe("done");
    else
      expect(JSON.parse(subject.io.stdout()).transcript).toContainEqual({
        kind: "text",
        text: "done",
        streaming: false,
      });
  });

  test.each([
    { isTTY: false, json: false },
    { isTTY: true, json: true },
  ])("emits no progress with %j", async (options) => {
    const subject = invocation(command, options);
    const pending = subject.run();
    try {
      await subject.called.promise;
      await tick(120);
      expect(subject.io.stdout()).toBe("");
      expect(subject.io.stderr()).toBe("");
    } finally {
      subject.finish();
      await pending;
    }
    expect(subject.io.stderr()).not.toContain("Invoking");
    expect(subject.io.stderr()).not.toContain("\u001b");
    if (options.json) expect(() => JSON.parse(subject.io.stdout())).not.toThrow();
  });

  test("cleans up after a failed invocation", async () => {
    const subject = invocation(command);
    const failure = new Error("invocation failed");
    const failing = async () => {
      subject.called.resolve(undefined);
      await subject.headers.promise;
      throw failure;
    };
    subject.core.runtime.invokeRuntime = failing;
    subject.core.harness.invokeHarness = failing;
    const pending = subject.run();
    try {
      await subject.called.promise;
      await waitFor(() => subject.io.stderr().includes("Invoking"));
      subject.headers.resolve();
      await expect(pending).rejects.toBe(failure);
      expect(subject.io.stderr()).toContain("\u001b[?25h");
      const completed = subject.io.stderr();
      await tick(120);
      expect(subject.io.stderr()).toBe(completed);
    } finally {
      subject.headers.resolve();
      await pending.catch(() => undefined);
    }
  });

  test.each(["lookup", "invoke"] as const)("Ctrl+C aborts %s and stops progress", async (phase) => {
    const subject = invocation(command);
    const hanging = async (
      _input: unknown,
      _options: unknown,
      signal?: AbortSignal,
    ): Promise<never> => {
      subject.called.resolve(signal);
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    };
    if (phase === "lookup") {
      subject.core.runtime.getRuntime = hanging;
      subject.core.harness.getHarness = hanging;
    } else {
      subject.core.runtime.invokeRuntime = hanging;
      subject.core.harness.invokeHarness = hanging;
    }
    const pending = subject.run();
    const signal = await subject.called.promise;
    try {
      await waitFor(() => subject.io.stderr().includes("Invoking"));
      process.emit("SIGINT", "SIGINT");
      await expect(pending).rejects.toBeInstanceOf(UserCancellationError);
      expect(signal?.aborted).toBe(true);
      expect(subject.io.stderr()).toContain("\u001b[?25h");
    } finally {
      if (!signal?.aborted) process.emit("SIGINT", "SIGINT");
      await pending.catch(() => undefined);
    }
  });
});

test("screen-reader mode does not emit animation or leave a spinner beside the response", async () => {
  const previous = process.env.INK_SCREEN_READER;
  process.env.INK_SCREEN_READER = "true";
  const subject = invocation(COMMANDS[0]);
  const pending = subject.run();
  try {
    await subject.called.promise;
    await tick(120);
    expect(subject.io.stderr()).toBe("");
  } finally {
    subject.finish();
    try {
      await pending;
    } finally {
      if (previous === undefined) delete process.env.INK_SCREEN_READER;
      else process.env.INK_SCREEN_READER = previous;
    }
  }
  expect(subject.io.stdout()).toBe("done");
  expect(subject.io.stderr()).not.toContain("Invoking");
  expect(subject.io.stderr()).not.toContain("\u001b");
});

test("raw streaming stops progress at the first nonempty chunk, not at headers or EOF", async () => {
  const subject = invocation(COMMANDS[0]);
  const pending = subject.run();
  try {
    await subject.called.promise;
    await waitFor(() => subject.io.stderr().includes("Invoking"));
    subject.headers.resolve();
    subject.runtimeBody.emit(new Uint8Array());
    const waiting = subject.io.stderr();
    await waitFor(() => subject.io.stderr() !== waiting);
    subject.runtimeBody.emit(Buffer.from("partial"));
    await waitFor(() => subject.io.stdout() === "partial");
    const streaming = subject.io.stderr();
    expect(streaming).toContain("\u001b[?25h");
    await tick(120);
    expect(subject.io.stderr()).toBe(streaming);
  } finally {
    subject.finish();
    await pending;
  }
  expect(subject.io.stdout()).toBe("partialdone");
});
