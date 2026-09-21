import { describe, expect, test } from "bun:test";
import { compile, ValueContext } from "../../router";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";
import { createRootHandler } from "../index";

const GROUPS = [[], ["target"], ["connector"], ["rule"]];
const MUTATIONS = ["create", "update", "delete"];

function setup(imperativeMutationCommands?: boolean) {
  const core = new TestCoreClient();
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    imperativeMutationCommands,
  });
  const command = compile(root, ValueContext.EmptyContext());
  command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  return { core, command };
}

describe("Gateway imperative mutation availability", () => {
  test.each([undefined, false, true])("builds help and commands for flag %s", (enabled) => {
    const { command } = setup(enabled);
    const gateway = command.commands.find((child) => child.name() === "gateway")!;
    for (const path of GROUPS) {
      const group = path.length
        ? gateway.commands.find((child) => child.name() === path[0])!
        : gateway;
      const names = group.commands.map((child) => child.name());
      for (const mutation of MUTATIONS) {
        expect(names.includes(mutation)).toBe(enabled === true);
        expect(new RegExp(`\\n\\s+${mutation}\\s`).test(group.helpInformation())).toBe(
          enabled === true,
        );
      }
      expect(names).toContain("get");
      expect(names).toContain("list");
    }
    expect(gateway.commands.map((child) => child.name())).toContain("invoke");
    expect(gateway.commands.find((child) => child.name() === "policy")?.commands[0]?.name()).toBe(
      "generate",
    );
    const project = command.commands.find((child) => child.name() === "project")!;
    const add = project.commands.find((child) => child.name() === "add")!;
    expect(add.commands.map((child) => child.name())).toContain("gateway");
    const harness = command.commands.find((child) => child.name() === "harness")!;
    expect(harness.commands.map((child) => child.name())).toContain("create");
  });

  test.each(
    GROUPS.flatMap((group) =>
      MUTATIONS.map((mutation) => ["gateway", ...group, mutation].join(" ")),
    ),
  )("rejects disabled %s without calling Core", async (path) => {
    for (const enabled of [undefined, false]) {
      for (const args of [[], ["--json"], ["--name", "disabled"]]) {
        const { core, command } = setup(enabled);
        await expect(
          command.parseAsync(["node", "agentcore", ...path.split(" "), ...args]),
        ).rejects.toThrow();
        expect(core.gateway.calls).toEqual([]);
        expect(core.policy.calls).toEqual([]);
      }
    }
  });
});
