import { renderTui } from "../tui";
import type { AppIO } from "../io";
import type { Core } from "../handlers/types";
import { type Middleware } from "../router";
import { CommandKey } from "../router/router";
import { attributeName } from "../router/flags";
import { JsonKey } from "../handlers/keys";

export function withTuiOnEmptyFlagsAndArgs(core: Core, io: AppIO): Middleware {
  const boundRenderTui = renderTui(core, io);

  return (h) => ({
    name: () => h.name(),
    description: () => h.description(),
    flags: () => h.flags(),
    arguments: () => h.arguments(),
    doesSupportTui: () => h.doesSupportTui(),
    children: () => h.children(),
    handle: async (ctx, flags, args) => {
      const command = ctx.require(CommandKey);
      const noFlagsPassed = h
        .flags()
        .every((f) => command.getOptionValueSource(attributeName(f.name)) !== "cli");

      if (h.doesSupportTui() && !ctx.value(JsonKey) && noFlagsPassed && command.args.length === 0) {
        await boundRenderTui(ctx, flags, args);
        return;
      }
      await h.handle(ctx, flags, args);
    },
  });
}

// withTuiWhenInteractive is withTuiOnEmptyFlagsAndArgs behind a TTY gate: a bare
// invocation opens the TUI only in an interactive session. The gate sits here
// rather than inside renderTui so that a piped or CI run stays headless and
// reports a missing required flag as the usage error it is, instead of
// renderTui's "interactive mode requires a TTY".
export function withTuiWhenInteractive(core: Core, io: AppIO): Middleware {
  const withTui = withTuiOnEmptyFlagsAndArgs(core, io);
  const isInteractive = () => io.stdin.isTTY === true && io.stdout.isTTY === true;

  return (h) => {
    const interactive = withTui(h);
    return {
      name: () => h.name(),
      description: () => h.description(),
      flags: () => h.flags(),
      arguments: () => h.arguments(),
      doesSupportTui: () => h.doesSupportTui(),
      children: () => h.children(),
      handle: (ctx, flags, args) =>
        isInteractive() ? interactive.handle(ctx, flags, args) : h.handle(ctx, flags, args),
    };
  };
}
