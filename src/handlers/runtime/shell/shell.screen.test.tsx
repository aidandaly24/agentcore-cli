import { afterEach, describe, expect, test } from "bun:test";
import {
  cleanupScreens,
  renderScreen,
  TestCoreClient,
  tick,
  waitFor,
  waitForText,
} from "../../../testing";

afterEach(cleanupScreens);

const ID = "checkout-AbCdEf1234";

describe("Runtime shell entry points", () => {
  test.each(["", `/${ID}`, `/${ID}/prod`])(
    "the retired TUI route does not open a shell or picker: %s",
    async (suffix) => {
      const core = new TestCoreClient();
      const screen = renderScreen(`/agentcore/runtime/shell${suffix}`, { core });

      await tick();

      expect(screen.frames.join("\n")).toContain("Usage:");
      expect(core.runtime.calls).toEqual([]);
      expect(core.harness.calls).toEqual([]);
    },
  );

  test("the Runtime menu offers exec without a shell action", async () => {
    const core = new TestCoreClient();
    const screen = renderScreen("/agentcore/runtime", { core });

    await waitForText(screen.lastFrame, "open an interactive shell (-it)");

    expect(screen.lastFrame()).not.toMatch(/shell\s+open an interactive shell/);
    await screen.write("exec");
    await screen.press("return");
    await waitForText(screen.lastFrame, "choose a Runtime to exec into");
    await waitFor(() => core.runtime.calls.some((call) => call.method === "listRuntimes"));
    expect(core.runtime.calls.some((call) => call.method === "openRuntimeShell")).toBe(false);
  });
});
