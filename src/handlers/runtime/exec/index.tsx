import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, PathKey } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { applyExecEvent, finishExec, newExecItem } from "../../harness/invoke/transcript";
import { JsonKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { runtimeIdSchema } from "../invoke/request";
import { runRuntimeShell } from "../shell/operation";
import { resolveRuntimeShellBearerToken } from "../shell/request";

export const createRuntimeExecHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "exec",
    description: "run a command or open an interactive shell (-it) in a Runtime",
    flags: [
      flag("id", "the ID of the Runtime", runtimeIdSchema),
      flag("interactive", "open an interactive shell (requires --tty)", z.boolean(), {
        short: "i",
      }),
      flag("tty", "attach the terminal (requires --interactive)", z.boolean(), { short: "t" }),
      flag(
        "command",
        "the command to run",
        z
          .string()
          .refine((s) => s.trim().length > 0, "command must not be empty")
          .optional(),
      ),
      flag("qualifier", "the endpoint qualifier (default DEFAULT)", z.string().min(1).optional()),
      flag(
        "session-id",
        "the Runtime session ID (33-100 characters; up to 256 with -it)",
        z.string().min(33).max(256).optional(),
      ),
      flag("bearer-token", "the CUSTOM_JWT bearer token for -it", z.string().optional(), {
        sensitive: true,
      }),
      flag(
        "timeout",
        "command timeout in seconds (1-3600)",
        z.number().int().min(1).max(3600).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (flags.interactive !== flags.tty) {
        throw new InputValidationError("--interactive and --tty must be used together (-it)");
      }
      if (flags.interactive) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("--json cannot be used with runtime exec -it");
        }
        for (const option of ["command", "timeout"] as const) {
          if (flags[option] !== undefined) {
            throw new InputValidationError(`--${option} cannot be used with runtime exec -it`);
          }
        }
        await runRuntimeShell({
          ctx,
          core,
          io,
          runtimeId: flags.id,
          qualifier: flags.qualifier ?? "DEFAULT",
          launchContext: {
            runtimeId: flags.id,
            runtimeSessionId: flags["session-id"],
            bearerToken: await resolveRuntimeShellBearerToken(flags["bearer-token"], io.stdin),
          },
        });
        return;
      }
      if (flags["bearer-token"] !== undefined) {
        throw new InputValidationError("--bearer-token requires runtime exec -it");
      }
      if (flags["session-id"] !== undefined && flags["session-id"].length > 100) {
        throw new InputValidationError("--session-id must be at most 100 characters without -it");
      }
      if (flags.command === undefined) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--command <command>' not specified");
        }
        let path = `${ctx.require(PathKey)}/${encodeURIComponent(flags.id)}`;
        if (flags.qualifier) path += `/${encodeURIComponent(flags.qualifier)}`;
        const search = new URLSearchParams();
        if (flags["session-id"]) search.set("session-id", flags["session-id"]);
        if (flags.timeout !== undefined) search.set("timeout", String(flags.timeout));
        await renderTuiAt(search.size ? `${path}?${search}` : path, ctx, core, io);
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
