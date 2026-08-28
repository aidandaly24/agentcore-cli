import { afterEach, describe, expect, test } from "bun:test";
import type {
  AgentRuntimeEndpoint,
  GetAgentRuntimeResponse,
  GetHarnessResponse,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { ProjectSpecSchema } from "../../../projectSchemas/project";
import { ProjectKey } from "../../../router";
import { cleanupScreens, renderScreen, TestCoreClient, waitForText } from "../../../testing";
import type { Project } from "../types";

afterEach(cleanupScreens);

const project: Project = {
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
};

function endpoint(name: string): AgentRuntimeEndpoint {
  return {
    id: name,
    name,
    agentRuntimeEndpointArn: `arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime-endpoint/${name}`,
    agentRuntimeArn: "arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/runtime-123",
    createdAt: new Date(0),
    liveVersion: "1",
    targetVersion: "1",
    status: "READY",
    lastUpdatedAt: new Date(0),
  };
}

function core(): TestCoreClient {
  const value = new TestCoreClient();
  value.projectManager.resolveDeployedResource = async (_project, input) => ({
    id: input.resourceType === "runtime" ? "runtime-123" : "harness-123",
    target: { name: "default", account: "111122223333", region: "eu-west-1" },
  });
  value.runtime
    .setListEndpointsResponse({ runtimeEndpoints: [endpoint("DEFAULT")] })
    .setGetResponse({
      agentRuntimeArn: "arn:aws:bedrock-agentcore:eu-west-1:111122223333:runtime/runtime-123",
    } as GetAgentRuntimeResponse);
  value.harness.setGetResponse({
    harness: {
      harnessId: "harness-123",
      harnessName: "support",
      arn: "arn:aws:bedrock-agentcore:eu-west-1:111122223333:harness/harness-123",
    },
  } as GetHarnessResponse);
  return value;
}

describe("project invoke picker", () => {
  test("lists project Runtime and Harness resources", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    expect(screen.lastFrame()).toContain("Runtime");
    expect(screen.lastFrame()).toContain("HTTP");
    expect(screen.lastFrame()).toContain("app/checkout");
    expect(screen.lastFrame()).toContain("support");
    expect(screen.lastFrame()).toContain("Harness");
    expect(screen.lastFrame()).toContain("app/support");
  });

  test("opens the selected Harness chat in the same TUI", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      core: core(),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("down");
    await screen.press("return");
    await waitForText(screen.lastFrame, "send a message…");
    expect(screen.lastFrame()).toContain("harness-123");
  });

  test("uses the existing Runtime endpoint picker before its JSON console", async () => {
    const screen = renderScreen("/agentcore/project/invoke", {
      core: core(),
      withContext: (ctx) => ctx.withValue(ProjectKey, project),
    });

    await waitForText(screen.lastFrame, "checkout");
    await screen.press("return");
    await waitForText(screen.lastFrame, "DEFAULT");
    await screen.press("return");
    await waitForText(screen.lastFrame, "Enter JSON payload");
    expect(screen.lastFrame()).not.toContain("Enter prompt");
  });
});
