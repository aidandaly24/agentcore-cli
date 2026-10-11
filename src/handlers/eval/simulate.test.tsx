import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceResolutionError } from "../../errors";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tokenFile(contents: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "eval-simulate-token-"));
  tempDirectories.push(directory);
  const path = join(directory, "token");
  await writeFile(path, contents);
  return `file://${path}`;
}

function subject(group: string, stdin?: string) {
  const core = new TestCoreClient();
  core.eval.setInvokeDatasetResponse({
    sessions: [{ exampleId: "example-1", sessionId: "session-1" }],
    invoked: 1,
    failed: 0,
    failures: [],
  });
  const io = testIO({ stdin });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    run: (...flags: string[]) =>
      root.route([
        "node",
        "agentcore",
        "eval",
        group,
        "simulate",
        "--runtime-id",
        "runtime-1",
        "--payload-template",
        '{"prompt":"{input}"}',
        "--dataset",
        "/tmp/dataset.jsonl",
        "--evaluators",
        "Builtin.Helpfulness",
        ...(group === "batch-evaluation" ? ["--name", "simulation-1"] : []),
        ...flags,
        "--region",
        "us-west-2",
      ]),
  };
}

describe.each(["batch-evaluation", "ondemand"])("%s simulate bearer tokens", (group) => {
  test("rejects inline tokens before Core calls without exposing them", async () => {
    const value = subject(group);
    const secret = "inline-token-must-not-leak";
    const error = await value.run("--bearer-token", secret).catch((error) => error);

    expect(error).toBeInstanceOf(SourceResolutionError);
    expect(error.message).toContain("--bearer-token must come from stdin");
    expect(error.message).not.toContain(secret);
    expect(value.core.eval.calls).toEqual([]);
  });

  test.each(["file", "stdin"])(
    "resolves tokens from %s before invoking the dataset",
    async (source) => {
      const value = subject(group, "secret-token\r\n");
      const tokenSource = source === "file" ? await tokenFile("secret-token\n") : "-";

      await value.run("--bearer-token", tokenSource);

      expect(
        value.core.eval.calls.find((call) => call.method === "invokeDataset")?.args[0],
      ).toMatchObject({ bearerToken: "secret-token", runtimeId: "runtime-1" });
    },
  );

  test("preserves invocation without bearer authentication", async () => {
    const value = subject(group);

    await value.run();

    expect(
      value.core.eval.calls.find((call) => call.method === "invokeDataset")?.args[0],
    ).toMatchObject({ bearerToken: undefined });
  });
});

test("batch simulation rejects a second stdin consumer before Core calls", async () => {
  const value = subject("batch-evaluation", "secret-token");

  await expect(value.run("--bearer-token", "-", "--output-config", "-")).rejects.toThrow(
    /only one option may read from stdin.*'--output-config'.*'--bearer-token'/,
  );
  expect(value.core.eval.calls).toEqual([]);
});
