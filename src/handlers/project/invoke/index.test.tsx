import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { InvokeHarnessRequest } from "@aws-sdk/client-bedrock-agentcore";
import type {
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { createRootHandler } from "../../index";
import { createProjectInvokeHandler } from ".";
import type { ProjectBackend, ResolveDeployedResourceBackendInput } from "../../../core/project";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { JsonKey, RegionKey } from "../../keys";
import { ProjectKey, ValueContext, type Context } from "../../../router";
import { RuntimeInvokeLaunchContextKey } from "../../runtime/invoke/launchContext";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";
import type { Project } from "../types";
import type { RuntimeInvokeRequest } from "../../runtime/types";

const originalCwd = process.cwd();
const temporaryDirectories: string[] = [];

const TARGET = {
  name: "default",
  account: "111122223333",
  region: "eu-west-1",
} as const;

const RUNTIME_ID = "checkout-AbCdEf1234";
const RUNTIME_ARN = `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}:runtime/${RUNTIME_ID}`;
const HARNESS_ID = "support-AbCdEf1234";
const HARNESS_ARN = `arn:aws:bedrock-agentcore:${TARGET.region}:${TARGET.account}:harness/${HARNESS_ID}`;

const RUNTIME = {
  name: "checkout",
  build: "CodeZip",
  entrypoint: "main.py",
  codeLocation: "app/checkout",
  runtimeVersion: "PYTHON_3_14",
} as const;

const HARNESS = { name: "support", path: "app/support" } as const;

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

async function inProject(resources: {
  runtimes?: unknown[];
  harnesses?: unknown[];
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "agentcore-project-invoke-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "agentcore"), { recursive: true });
  const spec = ProjectSpecSchema.parse({
    name: "orders",
    version: 1,
    runtimes: resources.runtimes ?? [],
    harnesses: resources.harnesses ?? [],
  });
  await writeFile(join(root, "agentcore", "agentcore.json"), JSON.stringify(spec));
  await writeFile(join(root, "agentcore", "aws-targets.json"), JSON.stringify([TARGET]));
  process.chdir(root);
}

function testBackend() {
  const calls: { project: Project; input: ResolveDeployedResourceBackendInput }[] = [];
  const backend: ProjectBackend = {
    async *build() {},
    async *deploy() {
      yield* [];
      return { outputs: {} };
    },
    async resolveDeployedResource(project, input) {
      calls.push({ project, input });
      return input.resourceType === "runtime" ? RUNTIME_ID : HARNESS_ID;
    },
  };
  return { backend, calls };
}

async function run(
  args: string[],
  resources: { runtimes?: unknown[]; harnesses?: unknown[] },
  configure?: (core: TestCoreClient) => void,
) {
  await inProject(resources);
  const resolved = testBackend();
  const core = new TestCoreClient({ backends: { CDK: resolved.backend } });
  core.runtime
    .setGetResponse({ agentRuntimeArn: RUNTIME_ARN } as GetAgentRuntimeResponse)
    .setInvokeResponse({
      statusCode: 200,
      contentType: "text/plain",
      body: body(Buffer.from("runtime response")),
    });
  core.harness
    .setGetResponse({
      harness: { harnessId: HARNESS_ID, harnessName: "support", arn: HARNESS_ARN },
    } as GetHarnessResponse)
    .setInvokeEvents(
      { messageStart: { role: "assistant" } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { text: "harness response" } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { messageStop: { stopReason: "end_turn" } },
    );
  configure?.(core);
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", "invoke", ...args, "--region", "us-east-2"]);
  return { core, io, resolved };
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project invoke", () => {
  test("auto-selects one Runtime and sends the project prompt payload in the target region", async () => {
    const content = 'say "hello"\nthen continue';
    const { core, io, resolved } = await run([content], { runtimes: [RUNTIME] });

    expect(io.stdout()).toBe("runtime response");
    expect(resolved.calls[0]?.input).toEqual({
      target: TARGET,
      resourceType: "runtime",
      name: "checkout",
    });
    expect(core.runtime.calls.map(({ method }) => method)).toEqual(["getRuntime", "invokeRuntime"]);
    const request = core.runtime.calls[1]!.args[0] as RuntimeInvokeRequest;
    expect(new TextDecoder().decode(request.payload)).toBe(JSON.stringify({ prompt: content }));
    expect(request.contentType).toBe("application/json");
    expect(core.runtime.calls[0]!.args[1]).toEqual({ region: TARGET.region });
    expect(core.runtime.calls[1]!.args[1]).toEqual({ region: TARGET.region });
  });

  test("auto-selects one Harness and sends one user message", async () => {
    const { core, io } = await run(["hello"], { harnesses: [HARNESS] });

    const request = core.harness.calls.find(({ method }) => method === "invokeHarness")!
      .args[0] as InvokeHarnessRequest;
    expect(request).toMatchObject({
      harnessArn: HARNESS_ARN,
      qualifier: "DEFAULT",
      messages: [{ role: "user", content: [{ text: "hello" }] }],
    });
    expect(
      core.harness.calls.find(({ method }) => method === "getHarness")!.args[1] as object,
    ).toEqual({ region: TARGET.region });
    expect(JSON.parse(io.stdout()).transcript).toEqual([
      { kind: "user", text: "hello" },
      { kind: "text", text: "harness response", streaming: false },
    ]);
  });

  test("uses an explicit selector when the project contains both resource types", async () => {
    const { core } = await run(["hello", "--runtime", "checkout"], {
      runtimes: [RUNTIME],
      harnesses: [HARNESS],
    });

    expect(core.runtime.calls.some(({ method }) => method === "invokeRuntime")).toBe(true);
    expect(core.harness.calls).toEqual([]);
  });

  test("requires a selector when multiple invokable resources exist", async () => {
    await expect(run(["hello"], { runtimes: [RUNTIME], harnesses: [HARNESS] })).rejects.toThrow(
      /multiple invokable resources.*--runtime.*checkout.*--harness.*support/s,
    );
  });

  test("rejects mutually exclusive selectors", async () => {
    await expect(
      run(["hello", "--runtime", "checkout", "--harness", "support"], {
        runtimes: [RUNTIME],
        harnesses: [HARNESS],
      }),
    ).rejects.toThrow(/--runtime and --harness are mutually exclusive/);
  });

  test("rejects a logical resource that is not in the project", async () => {
    await expect(run(["hello", "--runtime", "missing"], { runtimes: [RUNTIME] })).rejects.toThrow(
      /Runtime 'missing' was not found.*checkout/s,
    );
  });

  test("rejects a project with no invokable resources", async () => {
    await expect(run(["hello"], {})).rejects.toThrow(/no Runtimes or Harnesses/);
  });

  test("requires content when JSON output is requested", async () => {
    await expect(run(["--json"], { runtimes: [RUNTIME] })).rejects.toThrow(
      /content is required with --json/,
    );
  });

  test("passes a Runtime bearer token through the existing auth normalizer", async () => {
    const { core } = await run(
      ["hello", "--bearer-token", "token"],
      { runtimes: [RUNTIME] },
      (configured) =>
        configured.runtime.setGetResponse({
          agentRuntimeArn: RUNTIME_ARN,
          authorizerConfiguration: { customJWTAuthorizer: {} },
        } as GetAgentRuntimeResponse),
    );

    const request = core.runtime.calls.find(({ method }) => method === "invokeRuntime")!
      .args[0] as RuntimeInvokeRequest;
    expect(request.bearerToken).toBe("token");
  });

  test("rejects Runtime-only authentication on a Harness", async () => {
    await expect(
      run(["hello", "--bearer-token", "token"], { harnesses: [HARNESS] }),
    ).rejects.toThrow(/--bearer-token is only valid with --runtime/);
  });

  test("preserves Harness session ID validation", async () => {
    await expect(
      run(["hello", "--session-id", "too-short"], { harnesses: [HARNESS] }),
    ).rejects.toThrow(/Harness session ID must be between 33 and 100 characters/);
  });

  test("launches the Runtime TUI in prompt mode with the deployment target region", async () => {
    await inProject({ runtimes: [RUNTIME] });
    const resolved = testBackend();
    const core = new TestCoreClient({ backends: { CDK: resolved.backend } });
    const project = await core.projectManager.resolve({ filePath: process.cwd() });
    const io = testIO();
    const launches: { path: string; context: Context }[] = [];
    const handler = createProjectInvokeHandler(core, io.io, async (path, context) => {
      launches.push({ path, context });
    });
    const context = ValueContext.EmptyContext()
      .withValue(ProjectKey, project!)
      .withValue(JsonKey, false)
      .withValue(RegionKey, "us-east-2");

    await handler.handle(
      context,
      {
        runtime: undefined,
        harness: undefined,
        target: "default",
        "session-id": "project-session",
        qualifier: "prod",
        "bearer-token": undefined,
      },
      { content: undefined },
    );

    expect(launches).toHaveLength(1);
    expect(launches[0]!.path).toBe(`/agentcore/runtime/invoke/${RUNTIME_ID}/prod`);
    expect(launches[0]!.context.require(RegionKey)).toBe(TARGET.region);
    expect(launches[0]!.context.require(RuntimeInvokeLaunchContextKey)).toEqual({
      runtimeId: RUNTIME_ID,
      runtimeSessionId: "project-session",
      bearerToken: undefined,
      inputMode: "prompt",
    });
  });
});
