import z from "zod";
import { createHandler, flag, PathKey } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx } from "../../utils.tsx";
import { JsonKey } from "../../keys.tsx";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { InputValidationError } from "../../../errors";
import { execFlags, executeCommand } from "../../exec";

export const createExecHarnessHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "exec",
    description: "run a shell command in a harness",
    flags: [flag("id", "the ID of the harness", z.string().min(1).max(48)), ...execFlags],
    handle: async (ctx, flags) => {
      if (!flags["command"]) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--command <command>' not specified");
        }
        let path = `${ctx.require(PathKey)}/${flags["id"]}`;
        if (flags["session-id"]) path += `/${flags["session-id"]}`;
        const search = new URLSearchParams();
        if (flags["qualifier"]) search.set("qualifier", flags["qualifier"]);
        if (flags.timeout !== undefined) search.set("timeout", String(flags.timeout));
        if (search.size) path += `?${search}`;
        await renderTuiAt(path, ctx, core, io);
        return;
      }

      const opts = coreOptsFromCtx(ctx);
      const detail = await core.harness.getHarness(flags["id"], opts);

      const result = await executeCommand(
        (request) => core.harness.invokeAgentRuntimeCommand(request, opts),
        // Harness-managed runtimes must be addressed by their Harness ARN.
        detail.harness?.arn,
        { ...flags, command: flags.command },
      );
      ctx.require(JsonRendererKey).renderJson({
        ...result,
        sessionId: flags["session-id"] ?? result.sessionId,
      });
    },
  });

export { HarnessExecScreen } from "./screen.tsx";
