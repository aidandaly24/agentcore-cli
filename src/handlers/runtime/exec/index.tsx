import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, PathKey } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { execFlags, executeCommand } from "../../exec";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { runtimeIdSchema } from "../invoke/request";
import { RuntimeExecLaunchContextKey } from "./launchContext";

export const createRuntimeExecHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "exec",
    description: "run a shell command in a Runtime",
    flags: [flag("id", "the ID of the Runtime", runtimeIdSchema), ...execFlags],
    handle: async (ctx, flags) => {
      if (flags.command === undefined) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--command <command>' not specified");
        }
        let path = `${ctx.require(PathKey)}/${encodeURIComponent(flags.id)}`;
        if (flags.qualifier) path += `/${encodeURIComponent(flags.qualifier)}`;
        await renderTuiAt(
          path,
          ctx.withValue(RuntimeExecLaunchContextKey, {
            runtimeId: flags.id,
            runtimeSessionId: flags["session-id"],
            timeout: flags.timeout,
          }),
          core,
          io,
        );
        return;
      }

      const opts = coreOptsFromCtx(ctx);
      const detail = await core.runtime.getRuntime(flags.id, opts);
      if (!detail.agentRuntimeArn) throw new InputValidationError("Runtime returned no ARN");
      const result = await executeCommand(
        (request) => core.runtime.invokeAgentRuntimeCommand(request, opts),
        detail.agentRuntimeArn,
        { ...flags, command: flags.command },
      );
      ctx.require(JsonRendererKey).renderJson({
        ...result,
        sessionId: result.sessionId ?? flags["session-id"],
      });
    },
  });

export { RuntimeExecScreen } from "./screen";
