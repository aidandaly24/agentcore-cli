import { test, expect, describe, afterEach } from "bun:test";
import {
  cleanupScreens,
  renderScreen,
  renderImperativeScreen,
  tick,
  waitForText,
} from "../testing";

afterEach(cleanupScreens);

// RouterScreen is the interactive command menu. These tests mount it through the
// real Root at a command path and drive it with key presses, asserting on the
// rendered frames — behavior a user would see, not internal state.

describe("menu rendering", () => {
  test("lists the current command's subcommands with their descriptions", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");

    const frame = r.lastFrame()!;
    expect(frame).toContain("project");
    expect(frame).toContain("eval");
    for (const family of ["harness", "identity", "runtime", "memory", "gateway", "payment"]) {
      expect(frame).not.toMatch(new RegExp(`\\b${family}\\b`));
    }
    expect(frame).toContain("config");
    expect(frame).toContain("read/write global config values");
    r.unmount();
  });

  test("shows the command description in the header", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "the platform for production AI agents");
    r.unmount();
  });

  test("renders the harness subcommands when mounted at the harness path", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    const frame = r.lastFrame()!;
    for (const sub of ["get", "list", "create", "update", "delete", "invoke", "exec"]) {
      expect(frame).toContain(sub);
    }
    r.unmount();
  });

  test("highlights the first option by default", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "type to choose a command");
    // The focus caret marks the highlighted row; the first option is project.
    expect(r.lastFrame()).toContain("❯ project");
    r.unmount();
  });
});

describe("filtering", () => {
  test("typing narrows the options to matches", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("cr"); // matches "create" only
    await waitForText(r.lastFrame, "❯ create");

    const frame = r.lastFrame()!;
    expect(frame).toContain("create");
    expect(frame).not.toContain("list");
    expect(frame).not.toContain("delete");
    r.unmount();
  });

  test("filtering is case-insensitive", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("LIST");
    await waitForText(r.lastFrame, "❯ list");
    r.unmount();
  });

  test("shows a no-matches message when nothing matches", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "list");

    await r.write("zzz");
    await waitForText(r.lastFrame, "No matches");
    r.unmount();
  });
});

describe("navigation", () => {
  test("down arrow moves the highlight to the next option", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ project");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ eval");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ feedback");
    r.unmount();
  });

  test("up arrow does not move past the first option", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ project");

    await r.press("up");
    await tick(20);
    // Still on the first option.
    expect(r.lastFrame()).toContain("❯ project");
    r.unmount();
  });

  test("enter navigates into the highlighted subcommand's screen", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ project");

    await r.press("down");
    await waitForText(r.lastFrame, "❯ eval");
    await r.press("return");
    await waitForText(r.lastFrame, "agentcore → eval");
    expect(r.lastFrame()).toContain("evaluator");
    r.unmount();
  });

  test("esc from a nested menu returns to the parent menu", async () => {
    const r = renderImperativeScreen("/agentcore/harness");
    await waitForText(r.lastFrame, "agentcore → harness");

    await r.press("escape");
    // Back at the root menu (breadcrumb no longer includes harness).
    await waitForText(r.lastFrame, "the platform for production AI agents");
    expect(r.lastFrame()).toContain("❯ project");
    r.unmount();
  });

  test("esc at the root menu is a no-op (no parent to go to)", async () => {
    const r = renderScreen("/agentcore");
    await waitForText(r.lastFrame, "❯ project");

    await r.press("escape");
    await tick(20);
    expect(r.lastFrame()).toContain("❯ project");
    r.unmount();
  });
});
