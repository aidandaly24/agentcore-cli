import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { DEFAULT_GLOBAL_CONFIG } from "../globalConfig";
import { compile, ValueContext } from "../router";
import {
  cleanupScreens,
  createSilentLogger,
  menuEntries,
  renderScreen,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
  waitForText,
} from "../testing";
import { createRootHandler } from "./index";

afterEach(() => {
  cleanupScreens();
  mock.restore();
});

const FAMILIES = ["harness", "identity", "runtime", "memory", "gateway", "payment"] as const;
const PUBLIC_COMMANDS = ["project", "eval", "feedback", "config", "update"];
const ALL_COMMANDS = ["project", ...FAMILIES, "eval", "feedback", "config", "update"];
const STATES = [undefined, false, true].flatMap((enabled) =>
  [false, true].map((mutations) => ({ enabled, mutations })),
);

function configFor(enabled: boolean | undefined, mutations: boolean) {
  return {
    ...DEFAULT_GLOBAL_CONFIG,
    "imperative-mutation-commands": mutations,
    ...(enabled === undefined ? {} : { "imperative-commands": enabled }),
  };
}

function setup(enabled: boolean | undefined, mutations: boolean) {
  const core = new TestCoreClient();
  const paymentCalls = [
    spyOn(core.payment, "getPaymentManager"),
    spyOn(core.payment, "listPaymentManagers"),
    spyOn(core.payment, "getPaymentConnector"),
    spyOn(core.payment, "listPaymentConnectors"),
    spyOn(core.payment, "getPaymentSession"),
    spyOn(core.payment, "listPaymentSessions"),
    spyOn(core.payment, "getPaymentInstrument"),
    spyOn(core.payment, "getPaymentInstrumentBalance"),
    spyOn(core.payment, "listPaymentInstruments"),
  ];
  const globalConfig = configFor(enabled, mutations);
  const root = createRootHandler(core, {
    io: testIO().io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor({ initialConfigData: globalConfig }),
    globalConfig,
  });
  const command = compile(root, ValueContext.EmptyContext());
  command.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  const expectNoCoreCalls = () => {
    for (const family of FAMILIES) {
      if (family !== "payment") expect(core[family].calls).toEqual([]);
    }
    for (const call of paymentCalls) expect(call).not.toHaveBeenCalled();
  };
  return { core, command, expectNoCoreCalls };
}

describe("imperative command families", () => {
  test.each(STATES)(
    "root flag $enabled and Gateway mutation flag $mutations select the command tree",
    ({ enabled, mutations }) => {
      const { command } = setup(enabled, mutations);
      expect(command.commands.map((child) => child.name())).toEqual(
        enabled ? ALL_COMMANDS : PUBLIC_COMMANDS,
      );
      for (const family of FAMILIES) {
        expect(new RegExp(`\\n\\s+${family}\\s`).test(command.helpInformation())).toBe(
          enabled === true,
        );
      }
      if (enabled) {
        const gateway = command.commands.find((child) => child.name() === "gateway")!;
        const groups = [
          gateway,
          ...gateway.commands.filter((child) =>
            ["target", "connector", "rule"].includes(child.name()),
          ),
        ];
        for (const group of groups) {
          for (const mutation of ["create", "update", "delete"]) {
            expect(group.commands.some((child) => child.name() === mutation)).toBe(mutations);
          }
        }
      }
      const project = command.commands.find((child) => child.name() === "project")!;
      expect(project.commands.map((child) => child.name())).toContain("invoke");
      expect(
        project.commands
          .find((child) => child.name() === "add")
          ?.commands.map((child) => child.name()),
      ).toEqual(expect.arrayContaining(["harness", "runtime", "memory", "gateway"]));
      const evaluation = command.commands.find((child) => child.name() === "eval")!;
      expect(evaluation.commands.map((child) => child.name())).toContain("evaluator");
    },
  );

  test.each([...FAMILIES])(
    "disabled %s rejects CLI requests without calling Core",
    async (family) => {
      for (const mutations of [false, true]) {
        for (const args of [[], ["list", "--json"], ["get", "--id", "disabled"]]) {
          const { command, expectNoCoreCalls } = setup(false, mutations);
          await expect(
            command.parseAsync(["node", "agentcore", family, ...args]),
          ).rejects.toThrow();
          expectNoCoreCalls();
        }
      }
    },
  );

  test("root registration uses the resolved snapshot without reading config", () => {
    const accessor = new TestGlobalConfigAccessor();
    let reads = 0;
    accessor.get = async () => {
      reads++;
      throw new Error("Must not read config during construction");
    };
    const root = createRootHandler(new TestCoreClient(), {
      io: testIO().io,
      logger: createSilentLogger(),
      globalConfigAccessor: accessor,
      globalConfig: configFor(false, true),
    });
    expect(root.children().map((child) => child.name())).toEqual(PUBLIC_COMMANDS);
    expect(reads).toBe(0);
  });
});

describe("imperative command menus", () => {
  test.each(STATES)(
    "root menu matches parent $enabled and Gateway mutation $mutations",
    async ({ enabled, mutations }) => {
      const { core, expectNoCoreCalls } = setup(enabled, mutations);
      const screen = renderScreen("/agentcore", {
        core,
        globalConfig: configFor(enabled, mutations),
      });
      await waitForText(screen.lastFrame, "type to choose a command");
      expect(menuEntries(screen.lastFrame()!)).toEqual({
        screens: enabled
          ? ["project", "harness", "identity", "runtime", "memory", "gateway", "eval"]
          : ["project", "eval"],
        cliOnly: enabled
          ? ["payment", "feedback", "config", "update"]
          : ["feedback", "config", "update"],
      });
      expectNoCoreCalls();
    },
  );

  test.each([
    ...FAMILIES.filter((family) => family !== "payment"),
    "runtime/endpoint",
    "harness/version",
    "gateway/target",
  ])("unavailable menu %s returns to a registered menu", async (path) => {
    const { core, expectNoCoreCalls } = setup(false, false);
    const screen = renderScreen(`/agentcore/${path}`, { core });
    await waitForText(screen.lastFrame, "the platform for production AI agents");
    expect(menuEntries(screen.lastFrame()!)).toEqual({
      screens: ["project", "eval"],
      cliOnly: ["feedback", "config", "update"],
    });
    expectNoCoreCalls();
  });

  test("an unavailable CLI-only family retains the unknown-route fallback", async () => {
    const { core, expectNoCoreCalls } = setup(false, false);
    const screen = renderScreen("/agentcore/payment", { core });
    await waitForText(() => screen.frames.join("\n"), "Usage:");
    expect(screen.frames.join("\n")).not.toContain("payment");
    expectNoCoreCalls();
  });
});
