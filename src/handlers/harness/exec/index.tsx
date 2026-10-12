import z from "zod";
import { createHandler, flag, PathKey } from "../../../router";
import type { AppIO } from "../../../io";
import type { Core } from "../../types.tsx";
import { coreOptsFromCtx } from "../../utils.tsx";
import { JsonKey } from "../../keys.tsx";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { InputValidationError } from "../../../errors";
import { applyExecEvent, finishExec, newExecItem } from "../invoke/transcript.tsx";
import { runHarnessShell } from "../shell/operation";
import { resolveRuntimeShellBearerToken } from "../../runtime/shell/request";

export const createExecHarnessHandler = (core: Core, io: AppIO) =>
  createHandler({
    name: "exec",
    description: "run a command or open an interactive shell (--it) in a harness",
    flags: [
      flag("id", "the ID of the harness", z.string().min(1).max(48)),
      flag("it", "open an interactive PTY shell session", z.boolean()),
      flag("command", "the shell command to run", z.string().optional()),
      flag(
        "session-id",
        "the Runtime session ID (33-100 characters; up to 256 with --it)",
        z.string().min(33).max(256).optional(),
      ),
      flag("bearer-token", "the CUSTOM_JWT bearer token for --it", z.string().optional(), {
        sensitive: true,
      }),
      flag(
        "qualifier",
        "the harness endpoint qualifier to run in (default DEFAULT)",
        z.string().optional(),
      ),
      flag(
        "timeout",
        "seconds to wait for the command (1-3600)",
        z.number().min(1).max(3600).optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      if (flags.it) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("--json cannot be used with harness exec --it");
        }
        for (const option of ["command", "timeout"] as const) {
          if (flags[option] !== undefined) {
            throw new InputValidationError(`--${option} cannot be used with harness exec --it`);
          }
        }
        if (flags.qualifier === "") {
          throw new InputValidationError("--qualifier must not be empty");
        }
        await runHarnessShell({
          ctx,
          core,
          io,
          harnessId: flags.id,
          qualifier: flags.qualifier ?? "DEFAULT",
          launchContext: {
            harnessId: flags.id,
            runtimeSessionId: flags["session-id"],
            bearerToken: await resolveRuntimeShellBearerToken(flags["bearer-token"], io.stdin),
          },
        });
        return;
      }
      if (flags["bearer-token"] !== undefined) {
        throw new InputValidationError("--bearer-token requires harness exec --it");
      }
      if (flags["session-id"] !== undefined && flags["session-id"].length > 100) {
        throw new InputValidationError("--session-id must be at most 100 characters without --it");
      }
      // Without a command, open the interactive exec screen at this harness —
      // resuming the given session and targeting the given qualifier when
      // passed. The one-shot CLI run below needs --command (and is the only
      // shape JSON mode supports).
      if (!flags["command"]) {
        if (ctx.require(JsonKey)) {
          throw new InputValidationError("required option '--command <command>' not specified");
        }
        let path = `${ctx.require(PathKey)}/${flags["id"]}`;
        if (flags["session-id"]) path += `/${flags["session-id"]}`;
        if (flags["qualifier"]) path += `?qualifier=${encodeURIComponent(flags["qualifier"])}`;
        await renderTuiAt(path, ctx, core, io);
        return;
      }

      const opts = coreOptsFromCtx(ctx);
      const detail = await core.harness.getHarness(flags["id"], opts);

      const response = await core.harness.invokeAgentRuntimeCommand(
        {
          // A harness-managed runtime cannot be addressed by its own runtime
          // ARN; the service expects the harness ARN here.
          agentRuntimeArn: detail.harness?.arn,
          qualifier: flags["qualifier"] ?? "DEFAULT",
          runtimeSessionId: flags["session-id"],
          body: { command: flags["command"], timeout: flags["timeout"] },
        },
        opts,
      );

      const item = newExecItem(flags["command"]);
      for await (const event of response.stream ?? []) {
        applyExecEvent(item, event);
      }
      finishExec(item);

      ctx.require(JsonRendererKey).renderJson({
        sessionId: flags["session-id"] ?? response.runtimeSessionId,
        command: item.command,
        exitCode: item.exitCode,
        status: item.status,
        output: item.output,
      });
    },
  });

export { HarnessExecScreen } from "./screen.tsx";
