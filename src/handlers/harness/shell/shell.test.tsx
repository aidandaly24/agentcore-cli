import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { GetHarnessResponse } from "@aws-sdk/client-bedrock-agentcore-control";
import { CoreClient } from "../../../core";
import { createRootHandler } from "../../index";
import type { HarnessShellRequest } from "../types";
import type { RuntimeShellSession } from "../../runtime/types";
import {
  cleanupScreens,
  createSilentLogger,
  fixtureFactories,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  tick,
} from "../../../testing";

const ID = "MyPDXHarness-rhkXkAE1IS";
const ARN = `arn:aws:bedrock-agentcore:us-west-2:501930284170:harness/${ID}`;
const SESSION_ID = "session-012345678901234567890123456789";

afterEach(cleanupScreens);

function subject(isTTY = true) {
  let request: HarnessShellRequest | undefined;
  let closed = 0;
  const session: RuntimeShellSession = {
    runtimeSessionId: SESSION_ID,
    kicked: false,
    exitCode: 0,
    send: async () => {},
    resize: async () => {},
    close: async () => {
      closed += 1;
    },
    async *[Symbol.asyncIterator]() {
      yield { type: "stdout", data: new TextEncoder().encode("harness output") };
    },
  };
  const core = new CoreClient({
    ...fixtureFactories(join(import.meta.dir, "../__fixtures__")),
    logger: createSilentLogger(),
    openHarnessShell: async (input, options) => {
      request = input;
      expect(options.region).toBe("us-west-2");
      return session;
    },
  });
  const io = testIO({ isTTY });
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  return {
    core,
    io,
    request: () => request,
    closed: () => closed,
    run: (...args: string[]) =>
      root.route([
        "node",
        "agentcore",
        "harness",
        "exec",
        "--it",
        ...args,
        "--region",
        "us-west-2",
      ]),
  };
}

describe("harness exec --it", () => {
  test("--it opens the DEFAULT shell without an endpoint picker", async () => {
    const value = subject();

    await value.run("--id", ID);

    expect(value.request()).toMatchObject({ harnessArn: ARN, qualifier: "DEFAULT" });
    expect(value.closed()).toBe(1);
  });

  test("opens the harness ARN through the real CLI/Core path and closes the terminal session", async () => {
    const value = subject();
    await value.run("--id", ID, "--qualifier", "prod", "--session-id", SESSION_ID);
    expect(value.request()).toEqual({
      harnessArn: ARN,
      qualifier: "prod",
      runtimeSessionId: SESSION_ID,
      onReconnect: expect.any(Function),
    });
    expect(value.io.stdout()).toContain("harness output");
    expect(value.io.stderr()).toContain("exit 0");
    expect(value.closed()).toBe(1);
    await value.request()?.onReconnect?.(true);
    expect(value.io.stderr()).toContain("Reattached to existing shell.");
  });

  test.each([
    [true, ["--json"], "--json cannot be used with harness exec --it"],
    [false, [], "interactive mode requires a TTY"],
  ] as const)(
    "rejects incompatible output mode before opening a shell",
    async (isTTY, flags, message) => {
      const value = subject(isTTY);
      await expect(value.run("--id", ID, "--qualifier", "DEFAULT", ...flags)).rejects.toThrow(
        message,
      );
      expect(value.request()).toBeUndefined();
    },
  );

  test("validates readiness and bearer authentication against Harness configuration", async () => {
    const value = subject();
    value.core.harness.getHarness = async () =>
      ({
        harness: { arn: ARN, status: "UPDATING" },
      }) as GetHarnessResponse;
    await expect(value.run("--id", ID, "--qualifier", "DEFAULT")).rejects.toThrow(
      "Harness is not ready",
    );
    expect(value.request()).toBeUndefined();

    value.core.harness.getHarness = async () =>
      ({
        harness: {
          arn: ARN,
          status: "READY",
          authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: "https://idp.example" } },
        },
      }) as GetHarnessResponse;
    await expect(value.run("--id", ID, "--qualifier", "DEFAULT")).rejects.toThrow(
      "CUSTOM_JWT Harness requires --bearer-token",
    );
    await value.run("--id", ID, "--qualifier", "DEFAULT", "--bearer-token", "token");
    expect(value.request()?.bearerToken).toBe("token");
  });

  test("requires --id in headless mode", async () => {
    await expect(subject().run("--json")).rejects.toThrow("--id");
  });

  test.each([33, 100, 101, 256])(
    "passes a %i-character shell session ID unchanged",
    async (length) => {
      const value = subject();
      const sessionId = "s".repeat(length);

      await value.run("--id", ID, "--session-id", sessionId);

      expect(value.request()?.runtimeSessionId).toBe(sessionId);
    },
  );
});

describe("harness shell entry points", () => {
  test.each(["", `/${ID}`, `/${ID}/prod`])(
    "the retired TUI route does not open a shell or picker: %s",
    async (suffix) => {
      const core = new TestCoreClient();
      const screen = renderScreen(`/agentcore/harness/shell${suffix}`, { core });

      await tick();

      expect(screen.frames.join("\n")).toContain("Usage:");
      expect(core.harness.calls).toEqual([]);
      expect(core.runtime.calls).toEqual([]);
    },
  );

  test("keeps CLI authentication and session context and propagates a shell stream failure", async () => {
    const core = new TestCoreClient();
    const failure = new Error("shell failed");
    let closed = 0;
    core.harness.setShellSession({
      runtimeSessionId: SESSION_ID,
      kicked: false,
      exitCode: null,
      send: async () => {},
      resize: async () => {},
      close: async () => {
        closed += 1;
      },
      async *[Symbol.asyncIterator]() {
        yield { type: "stdout", data: new TextEncoder().encode("partial harness output") };
        throw failure;
      },
    });
    core.harness.setGetResponse({
      harness: {
        arn: ARN,
        status: "READY",
        authorizerConfiguration: { customJWTAuthorizer: { discoveryUrl: "https://idp.example" } },
      },
    } as GetHarnessResponse);
    const streams = testIO({ isTTY: true });
    const root = createRootHandler(core, {
      io: streams.io,
      logger: createSilentLogger(),
      globalConfigAccessor: new TestGlobalConfigAccessor(),
    });
    const running = root.route([
      "node",
      "agentcore",
      "harness",
      "exec",
      "--it",
      "--id",
      ID,
      "--qualifier",
      "prod",
      "--session-id",
      SESSION_ID,
      "--bearer-token",
      "token",
      "--region",
      "us-west-2",
    ]);

    await expect(running).rejects.toBe(failure);
    expect(
      core.harness.calls.find((call) => call.method === "openHarnessShell")?.args[0],
    ).toMatchObject({
      harnessArn: ARN,
      runtimeSessionId: SESSION_ID,
      bearerToken: "token",
      qualifier: "prod",
    });
    expect(core.runtime.calls).toEqual([]);
    expect(core.harness.calls.map((call) => call.method)).toEqual([
      "getHarness",
      "openHarnessShell",
    ]);
    expect(streams.stdout()).toContain("partial harness output");
    expect(closed).toBe(1);
  });
});
