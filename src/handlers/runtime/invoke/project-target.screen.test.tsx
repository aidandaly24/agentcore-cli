import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { DEFAULT_GLOBAL_CONFIG } from "../../../globalConfig";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { CommandKey, ProjectKey } from "../../../router";
import {
  cleanupScreens,
  compiledRootCommand,
  flatFrame,
  renderScreen,
  TestCoreClient,
  waitFor,
  waitForText,
} from "../../../testing";
import type { Project } from "../../project/types";
import type { RuntimeInvokeRequest } from "../types";

afterEach(cleanupScreens);

const PROJECT_RUNTIME = "project-runtime";
const OTHER_RUNTIME = "standalone-other";
const TARGET = { name: "default", account: "123456789012", region: "us-east-1" } as const;
const TARGET_CREDENTIALS = async () => ({
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
});
const PROJECT: Project = {
  name: "orders",
  rootPath: "/tmp/orders",
  spec: ProjectSpecSchema.parse({
    name: "orders",
    version: 2,
    runtimes: [
      {
        name: "checkout",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/checkout",
        runtimeVersion: "PYTHON_3_14",
      },
    ],
  }),
};

type Launch = "CLI context" | "project picker";

class ProjectTargetCore extends TestCoreClient {
  constructor() {
    super();
    this.projectManager.listTargets = async () => [TARGET];
    this.projectManager.resolveDeployedResources = async () => ({
      target: TARGET,
      resources: [
        {
          resourceType: "runtime",
          name: "checkout",
          id: PROJECT_RUNTIME,
          target: TARGET,
          credentialProvider: TARGET_CREDENTIALS,
        },
      ],
    });
    this.runtime.setListResponse({
      agentRuntimes: [
        {
          agentRuntimeId: OTHER_RUNTIME,
          agentRuntimeArn: `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${OTHER_RUNTIME}`,
          agentRuntimeVersion: "1",
          agentRuntimeName: "standalone",
          description: "Runtime outside the project",
          lastUpdatedAt: new Date(0),
          status: "READY",
        },
      ],
    });
    this.selectRuntime(PROJECT_RUNTIME);
  }

  selectRuntime(id: string) {
    const arn = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${id}`;
    this.runtime.setGetResponse({
      agentRuntimeId: id,
      agentRuntimeArn: arn,
      status: "READY",
      protocolConfiguration: { serverProtocol: "HTTP" },
    } as GetAgentRuntimeResponse);
    this.runtime.setListEndpointsResponse({
      runtimeEndpoints: ["DEFAULT", "canary"].map((name): AgentRuntimeEndpoint => ({
        id: name,
        name,
        agentRuntimeArn: arn,
        agentRuntimeEndpointArn: `${arn}/runtime-endpoint/${name}`,
        liveVersion: "1",
        targetVersion: "1",
        status: "READY",
        createdAt: new Date(0),
        lastUpdatedAt: new Date(0),
      })),
    });
  }

  requests(): RuntimeInvokeRequest[] {
    return this.runtime.calls
      .filter((call) => call.method === "invokeRuntime")
      .map((call) => call.args[0] as RuntimeInvokeRequest);
  }

  renderCli(enabled: boolean, qualifier?: string) {
    const globalConfig = { ...DEFAULT_GLOBAL_CONFIG, "imperative-commands": enabled };
    const launch = compiledRootCommand(this, globalConfig)
      .commands.find((command) => command.name() === "invoke")!
      .commands.find((command) => command.name() === "runtime")!;
    return renderScreen(
      `/agentcore/runtime/invoke/${PROJECT_RUNTIME}${qualifier ? `/${qualifier}` : ""}`,
      {
        core: this,
        globalConfig,
        withContext: (ctx) => ctx.withValue(CommandKey, launch).withValue(ProjectKey, PROJECT),
      },
    );
  }

  async openConsole(launch: Launch, enabled: boolean) {
    if (launch === "CLI context") {
      const screen = this.renderCli(enabled, "DEFAULT");
      await waitForText(screen.lastFrame, "Enter JSON payload");
      return screen;
    }
    const screen = renderScreen("/agentcore/invoke", {
      core: this,
      globalConfig: { ...DEFAULT_GLOBAL_CONFIG, "imperative-commands": enabled },
      withContext: (ctx) => ctx.withValue(ProjectKey, PROJECT),
    });
    await waitForText(screen.lastFrame, "checkout");
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Enter JSON payload");
    return screen;
  }
}

describe("project Runtime target selection", () => {
  test.each(["CLI context", "project picker"] as const)(
    "%s with imperative commands off keeps target selection scoped to the project Runtime",
    async (launch) => {
      const core = new ProjectTargetCore();
      const screen = await core.openConsole(launch, false);

      await screen.write("\x14");
      await waitForText(screen.lastFrame, "choose another endpoint");
      expect(flatFrame(screen.lastFrame)).toContain(PROJECT_RUNTIME);
      expect(screen.lastFrame()).not.toContain("choose another Runtime");
      expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);

      await screen.press("escape");
      await waitForText(screen.lastFrame, "Enter JSON payload");
      await screen.write('{"turn":1}');
      await screen.press("return");
      await waitFor(() => core.requests().length === 1);
      await waitForText(screen.lastFrame, "complete");
      expect(core.requests()[0]).toMatchObject({
        runtimeId: PROJECT_RUNTIME,
        qualifier: "DEFAULT",
      });

      await screen.write("\x14");
      await waitForText(screen.lastFrame, "canary");
      await screen.press("down");
      await screen.press("return");
      await waitForText(screen.lastFrame, "Enter JSON payload");
      await screen.write('{"turn":2}');
      await screen.press("return");
      await waitFor(() => core.requests().length === 2);
      expect(core.requests()[1]).toMatchObject({
        runtimeId: PROJECT_RUNTIME,
        qualifier: "canary",
      });
      expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(false);
      expect(
        core.runtime.calls
          .filter((call) => call.method === "listRuntimeEndpoints")
          .every((call) => call.args[0] === PROJECT_RUNTIME),
      ).toBe(true);
    },
  );

  test.each(["CLI context", "project picker"] as const)(
    "%s with imperative commands on can select and invoke another Runtime",
    async (launch) => {
      const core = new ProjectTargetCore();
      const screen = await core.openConsole(launch, true);

      await screen.write("\x14");
      await waitForText(screen.lastFrame, "choose another Runtime");
      await waitForText(screen.lastFrame, OTHER_RUNTIME);
      expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(true);
      core.selectRuntime(OTHER_RUNTIME);
      await screen.press("return");
      await waitForText(screen.lastFrame, "choose another endpoint");
      await waitForText(screen.lastFrame, "DEFAULT");
      await screen.press("escape");
      await waitForText(screen.lastFrame, "choose another Runtime");
      await waitForText(screen.lastFrame, OTHER_RUNTIME);
      await screen.press("return");
      await waitForText(screen.lastFrame, "choose another endpoint");
      await waitForText(screen.lastFrame, "DEFAULT");
      await screen.press("return");
      await waitForText(screen.lastFrame, "Enter JSON payload");
      await screen.write('{"turn":1}');
      await screen.press("return");
      await waitFor(() => core.requests().length === 1);
      expect(core.requests()[0]).toMatchObject({
        runtimeId: OTHER_RUNTIME,
        qualifier: "DEFAULT",
      });
    },
  );

  test.each([false, true])(
    "initial CLI endpoint picker Escape respects imperative-commands=%s",
    async (enabled) => {
      const core = new ProjectTargetCore();
      const screen = core.renderCli(enabled);
      await waitForText(screen.lastFrame, "choose an endpoint to invoke");
      await waitForText(screen.lastFrame, "DEFAULT");

      await screen.press("escape");
      await waitForText(
        screen.lastFrame,
        enabled ? "choose a Runtime to invoke" : "the platform for production AI agents",
      );
      if (enabled) await waitForText(screen.lastFrame, OTHER_RUNTIME);
      expect(core.runtime.calls.some((call) => call.method === "listRuntimes")).toBe(enabled);
      expect(core.requests()).toEqual([]);
    },
  );
});
