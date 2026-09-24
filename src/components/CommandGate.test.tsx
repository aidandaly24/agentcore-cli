import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type {
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { DEFAULT_GLOBAL_CONFIG } from "../globalConfig";
import { CommandKey } from "../router";
import {
  cleanupScreens,
  compiledRootCommand,
  flatFrame,
  IMPERATIVE_GLOBAL_CONFIG,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../testing";

afterEach(cleanupScreens);

class GateTestCore extends TestCoreClient {
  readonly paymentCalls = [
    spyOn(this.payment, "getPaymentManager"),
    spyOn(this.payment, "listPaymentManagers"),
    spyOn(this.payment, "getPaymentConnector"),
    spyOn(this.payment, "listPaymentConnectors"),
    spyOn(this.payment, "getPaymentSession"),
    spyOn(this.payment, "listPaymentSessions"),
    spyOn(this.payment, "getPaymentInstrument"),
    spyOn(this.payment, "getPaymentInstrumentBalance"),
    spyOn(this.payment, "listPaymentInstruments"),
  ];
}

function expectNoCoreCalls(core: GateTestCore) {
  for (const client of [
    core.harness,
    core.runtime,
    core.memory,
    core.gateway,
    core.identity,
    core.policy,
    core.eval,
    core.observability,
  ]) {
    expect(client.calls).toEqual([]);
  }
  for (const call of core.paymentCalls) expect(call).not.toHaveBeenCalled();
  expect(core.projectCommands).toEqual([]);
}

const MUTATION_ROUTES = [
  "harness/create",
  "harness/update",
  "harness/update/update",
  "harness/delete",
  "harness/delete/delete",
  "harness/endpoint/create",
  "harness/endpoint/create/update",
  "harness/endpoint/update",
  "harness/endpoint/update/update",
  "harness/endpoint/update/update/delete",
  "harness/endpoint/delete",
  "harness/endpoint/delete/delete",
  "harness/endpoint/delete/delete/update",
  "harness/invoke",
  "harness/invoke/update",
  "harness/invoke/update/delete",
  "harness/exec",
  "harness/exec/update",
  "harness/exec/update/delete",
  "runtime/invoke",
  "runtime/invoke/update",
  "runtime/invoke/update/delete",
  "runtime/shell",
  "runtime/shell/update",
  "runtime/shell/update/delete",
  "gateway/invoke",
  "gateway/invoke/update",
  "gateway/policy",
  "gateway/policy/generate",
  "gateway/policy/generate/delete",
];

const LEGACY_MUTATION_CONFIG = {
  ...IMPERATIVE_GLOBAL_CONFIG,
  "imperative-mutation-commands": true,
};
const CLI_MUTATIONS = [
  ...["gateway", "gateway/target", "gateway/connector", "gateway/rule"].flatMap((group) =>
    ["create", "update", "delete"]
      .filter((verb) => group !== "gateway" || verb !== "create")
      .map((verb) => `${group}/${verb}`),
  ),
  ...["api-key-credential-provider", "oauth2-credential-provider"].flatMap((provider) =>
    ["create", "update", "delete"].map((verb) => `identity/${provider}/${verb}`),
  ),
];

describe("disabled imperative routes", () => {
  test.each(MUTATION_ROUTES)("%s redirects before mounting its screen", async (path) => {
    const core = new GateTestCore();
    const screen = renderScreen(`/agentcore/${path}`, {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
    });

    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expect(screen.lastFrame()).toContain("type to choose a command");
    expectNoCoreCalls(core);
  });

  test("the legacy mutation flag cannot override the disabled parent", async () => {
    const core = new GateTestCore();
    const screen = renderScreen("/agentcore/harness/create", {
      core,
      globalConfig: { ...LEGACY_MUTATION_CONFIG, "imperative-commands": false },
    });
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expectNoCoreCalls(core);
  });
});

describe("enabled imperative routes", () => {
  test.each([
    ["harness/create", "the name of your harness"],
    ["harness/update", "choose a harness to update"],
    ["harness/delete", "choose a harness to delete"],
    ["harness/endpoint/create", "choose a harness to create an endpoint for"],
    ["harness/endpoint/update", "choose the harness the endpoint belongs to"],
    ["harness/endpoint/delete", "choose the harness the endpoint belongs to"],
    ["harness/invoke", "choose a harness to chat with"],
    ["harness/exec", "choose a harness to exec into"],
    ["runtime/invoke", "choose a Runtime to invoke"],
    ["runtime/shell", "choose a Runtime to open a shell"],
    ["gateway/invoke", "choose a Gateway to invoke"],
    ["gateway/policy/generate", "choose a Gateway to generate a policy for"],
  ])("%s restores its screen", async (path, description) => {
    const screen = renderScreen(`/agentcore/${path}`, {
      globalConfig: IMPERATIVE_GLOBAL_CONFIG,
    });
    await waitForText(screen.lastFrame, description);
    expect(flatFrame(screen.lastFrame)).not.toContain("the platform for production AI agents");
  });
});

describe("CLI-only mutation routes", () => {
  test.each(CLI_MUTATIONS)("%s exposes no command help or Core calls when off", async (path) => {
    const core = new GateTestCore();
    const screen = renderScreen(`/agentcore/${path}`, {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
    });
    await waitForText(() => screen.frames.join("\n"), "Usage:");
    expect(screen.frames.join("\n")).not.toContain("this command runs from the command line");
    expect(screen.frames.join("\n")).not.toContain(`agentcore ${path.replaceAll("/", " ")} [`);
    expectNoCoreCalls(core);
  });

  test.each([...CLI_MUTATIONS, "gateway/create"])(
    "%s restores specific help when on",
    async (path) => {
      const core = new GateTestCore();
      const screen = renderScreen(`/agentcore/${path}`, {
        core,
        globalConfig: LEGACY_MUTATION_CONFIG,
      });
      await waitForText(screen.lastFrame, "this command runs from the command line");
      expect(flatFrame(screen.lastFrame)).toContain(
        `agentcore ${path.replaceAll("/", " ")} [options]`,
      );
      expectNoCoreCalls(core);
    },
  );

  test.each(["gateway", "runtime", "memory"])(
    "%s create keeps project guidance when its command is unavailable",
    async (family) => {
      const core = new GateTestCore();
      const screen = renderScreen(`/agentcore/${family}/create`, {
        core,
        globalConfig: DEFAULT_GLOBAL_CONFIG,
      });
      await waitForText(
        screen.lastFrame,
        "are created and managed as part of an AgentCore project",
      );
      expect(flatFrame(screen.lastFrame)).not.toContain("this command runs from the command line");
      expectNoCoreCalls(core);
    },
  );

  test.each(["payment/manager/create", "payment/connector/update", "payment/session/delete"])(
    "%s is unknown, not an implemented mutation",
    async (path) => {
      for (const globalConfig of [DEFAULT_GLOBAL_CONFIG, IMPERATIVE_GLOBAL_CONFIG]) {
        const core = new GateTestCore();
        const screen = renderScreen(`/agentcore/${path}`, { core, globalConfig });
        await waitForText(() => screen.frames.join("\n"), "Usage:");
        expect(screen.frames.join("\n")).not.toContain("this command runs from the command line");
        expectNoCoreCalls(core);
        screen.unmount();
      }
    },
  );
});

const READ_ROUTES = [
  ["harness/get/update", "harness", "getHarness"],
  ["harness/get/delete/json", "harness", "getHarness"],
  ["harness/list", "harness", "listHarnesses"],
  ["harness/endpoint/get/update/delete", "harness", "getHarnessEndpoint"],
  ["harness/endpoint/list/delete", "harness", "listHarnessEndpoints"],
  ["harness/version/get/delete/1", "harness", "getHarnessVersion"],
  ["harness/version/list/update", "harness", "listHarnessVersions"],
  ["runtime/get/update", "runtime", "getRuntime"],
  ["runtime/get/delete/json", "runtime", "getRuntime"],
  ["runtime/list", "runtime", "listRuntimes"],
  ["runtime/endpoint/get/update/delete", "runtime", "getRuntimeEndpoint"],
  ["runtime/endpoint/get/delete/update/json", "runtime", "getRuntimeEndpoint"],
  ["runtime/endpoint/list/delete", "runtime", "listRuntimeEndpoints"],
  ["runtime/version/get/update/1", "runtime", "getRuntimeVersion"],
  ["runtime/version/list/delete", "runtime", "listRuntimeVersions"],
  ["memory/get/delete", "memory", "getMemory"],
  ["memory/get/update/json", "memory", "getMemory"],
  ["memory/list", "memory", "listMemories"],
  ["memory/actor/list/delete", "memory", "listActors"],
  ["memory/session/list/update/delete", "memory", "listSessions"],
  ["memory/event/list/update/delete/update", "memory", "listEvents"],
  ["memory/event/get/update/delete/update/delete", "memory", "getEvent"],
  ["memory/record/list/update/namespace/delete", "memory", "listMemoryRecords"],
  ["memory/record/get/delete/update", "memory", "getMemoryRecord"],
  ["gateway/get/delete", "gateway", "getGateway"],
  ["gateway/get/update/json", "gateway", "getGateway"],
  ["gateway/list", "gateway", "listGateways"],
  ["gateway/target/list/delete", "gateway", "listGatewayTargets"],
  ["gateway/target/get/update/delete", "gateway", "getGatewayTarget"],
  ["gateway/connector/list/update", "gateway", "listGatewayConnectors"],
  ["gateway/connector/get/delete/update", "gateway", "getGatewayConnector"],
  ["gateway/rule/list/update", "gateway", "listGatewayRules"],
  ["gateway/rule/get/update/delete", "gateway", "getGatewayRule"],
  ["identity/api-key-credential-provider/list", "identity", "listApiKeyCredentialProviders"],
  ["identity/api-key-credential-provider/get/update", "identity", "getApiKeyCredentialProvider"],
  [
    "identity/api-key-credential-provider/get/delete/json",
    "identity",
    "getApiKeyCredentialProvider",
  ],
  ["identity/oauth2-credential-provider/list", "identity", "listOauth2CredentialProviders"],
  ["identity/oauth2-credential-provider/get/delete", "identity", "getOauth2CredentialProvider"],
  [
    "identity/oauth2-credential-provider/get/update/json",
    "identity",
    "getOauth2CredentialProvider",
  ],
] as const;

describe("read-only routes remain accessible with the parent off", () => {
  test.each(READ_ROUTES)("%s still reads its resource", async (path, family, method) => {
    const core = new TestCoreClient();
    const screen = renderScreen(`/agentcore/${path}`, {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
    });
    await waitFor(() => core[family].calls.some((call) => call.method === method));
    await waitFor(() => !flatFrame(screen.lastFrame).toLowerCase().includes("loading"));
    expect(flatFrame(screen.lastFrame)).not.toContain("the platform for production AI agents");
    expect(core[family].calls.every((call) => /^(get|list)/.test(call.method))).toBe(true);
  });
});

function projectLaunch(core: TestCoreClient, family: "harness" | "runtime") {
  const root = compiledRootCommand(core, DEFAULT_GLOBAL_CONFIG);
  const invoke = root.commands.find((command) => command.name() === "invoke")!;
  return invoke.commands.find((command) => command.name() === family)!;
}

describe("public project invoke exception", () => {
  test.each(
    [[], ["invoke"], ["status"], ["create"]].flatMap((segments) =>
      ["harness/invoke/update", "runtime/invoke/update/DEFAULT"].map(
        (path) => [segments, path] as const,
      ),
    ),
  )("launch path %j does not authorize %s", async (segments, path) => {
    const core = new GateTestCore();
    const root = compiledRootCommand(core, DEFAULT_GLOBAL_CONFIG);
    const launch = segments.reduce(
      (command, segment) => command.commands.find((child) => child.name() === segment)!,
      root,
    );
    const screen = renderScreen(`/agentcore/${path}`, {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
      withContext: (ctx) => ctx.withValue(CommandKey, launch),
    });
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expectNoCoreCalls(core);
  });

  test("public project creation still opens without imperative commands", async () => {
    const core = new GateTestCore();
    const screen = renderScreen("/agentcore/create", {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
    });
    await waitForText(screen.lastFrame, "name your project");
    expectNoCoreCalls(core);
  });

  test.each(["harness", "runtime"] as const)(
    "the actual project invoke %s command can mount and invoke its resource",
    async (family) => {
      const core = new TestCoreClient();
      core.harness.setGetResponse({
        harness: {
          harnessId: "update",
          arn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:harness/update",
        },
      } as GetHarnessResponse);
      core.runtime.setGetResponse({
        agentRuntimeId: "update",
        agentRuntimeArn: "arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/update",
        status: "READY",
        protocolConfiguration: { serverProtocol: "HTTP" },
      } as GetAgentRuntimeResponse);
      const screen = renderScreen(
        `/agentcore/${family}/invoke/update${family === "runtime" ? "/DEFAULT" : ""}`,
        {
          core,
          globalConfig: DEFAULT_GLOBAL_CONFIG,
          withContext: (ctx) => ctx.withValue(CommandKey, projectLaunch(core, family)),
        },
      );
      await waitForText(screen.lastFrame, family === "harness" ? "send a message" : "payload");
      await screen.write(family === "harness" ? "hello" : '{"prompt":"hello"}');
      await screen.press("return");
      await waitFor(() =>
        core[family].calls.some(
          (call) => call.method === (family === "harness" ? "invokeHarness" : "invokeRuntime"),
        ),
      );
    },
  );

  test.each([
    ["harness", "harness/invoke"],
    ["runtime", "runtime/invoke"],
    ["harness", "runtime/invoke/update/DEFAULT"],
    ["runtime", "harness/invoke/update"],
    ["harness", "harness/exec/update"],
    ["runtime", "runtime/shell/update/DEFAULT"],
    ["harness", "harness/update/update"],
    ["runtime", "gateway/invoke/update"],
  ] as const)("project invoke %s does not authorize %s", async (family, path) => {
    const core = new GateTestCore();
    const screen = renderScreen(`/agentcore/${path}`, {
      core,
      globalConfig: DEFAULT_GLOBAL_CONFIG,
      withContext: (ctx) => ctx.withValue(CommandKey, projectLaunch(core, family)),
    });
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expectNoCoreCalls(core);
  });
});
