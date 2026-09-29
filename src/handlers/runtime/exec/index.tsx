import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, PathKey } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { applyExecEvent, finishExec, newExecItem } from "../../exec";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { runtimeIdSchema } from "../invoke/request";
import { RuntimeExecLaunchContextKey } from "./launchContext";

export const createRuntimeExecHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "exec",
    description: "run a shell command in a Runtime",
    flags: [
      flag("id", "the ID of the Runtime", runtimeIdSchema),
      flag(
        "command",
        "the shell command to run",
        z
          .string()
          .refine((value) => value.trim().length > 0, "command must not be empty")
          .optional(),
      ),
      flag(
        "qualifier",
        "the Runtime endpoint qualifier (default DEFAULT)",
        z.string().min(1).optional(),
      ),
      flag(
        "session-id",
        "the Runtime session ID to run in (33-100 characters)",
        z.string().min(33).max(100).optional(),
      ),
      flag(
        "timeout",
        "seconds to wait for the command (1-3600)",
        z.number().int().min(1).max(3600).optional(),
      ),
    ],
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
      const response = await core.runtime.invokeAgentRuntimeCommand(
        {
          agentRuntimeArn: detail.agentRuntimeArn,
          qualifier: flags.qualifier ?? "DEFAULT",
          runtimeSessionId: flags["session-id"],
          body: { command: flags.command, timeout: flags.timeout },
        },
        opts,
      );
      const item = newExecItem(flags.command);
      for await (const event of response.stream ?? []) applyExecEvent(item, event);
      finishExec(item);
      ctx.require(JsonRendererKey).renderJson({
        sessionId: response.runtimeSessionId ?? flags["session-id"],
        command: item.command,
        exitCode: item.exitCode,
        status: item.status,
        output: item.output,
      });
    },
  });

export { RuntimeExecScreen } from "./screen";
