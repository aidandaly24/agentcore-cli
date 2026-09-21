import z from "zod";
import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { runWithProgress } from "../../../tui/progress";
import { AwsCredentialProviderKey, JsonKey, RegionKey } from "../../keys";
import { invokeHarnessTurn } from "../../harness/invoke/operation";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import { selectProjectResource } from "../selection";

export const createProjectInvokeHarnessHandler = (
  core: Core,
  io: AppIO,
  renderInvokeTui: typeof renderTuiAt = renderTuiAt,
) =>
  createHandler({
    name: "harness",
    description: "invoke a harness from the current project",
    flags: [
      flag("name", "the logical project harness name", z.string().optional()),
      flag("target", "project deployment target", z.string().default("default")),
      flag("prompt", "the message to send to the harness", z.string().optional()),
      flag(
        "session-id",
        "the Runtime session ID to continue (33-100 characters)",
        z.string().min(33).max(100).optional(),
      ),
      flag(
        "qualifier",
        "the harness endpoint qualifier to invoke (default DEFAULT)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      const project = ctx.require(ProjectKey);
      const name = selectProjectResource(project, "harness", flags.name, "invoke");
      const deployed = await core.projectManager.resolveDeployedResource(project, {
        target: flags.target,
        resourceType: "harness",
        name,
      });
      const invokeCtx = ctx
        .withValue(RegionKey, deployed.target.region)
        .withValue(AwsCredentialProviderKey, deployed.credentialProvider);

      if (!flags.prompt) {
        if (invokeCtx.require(JsonKey)) {
          throw new InputValidationError("required option '--prompt <text>' not specified");
        }
        let path = `/agentcore/harness/invoke/${encodeURIComponent(deployed.id)}`;
        if (flags["session-id"]) path += `/${encodeURIComponent(flags["session-id"])}`;
        if (flags.qualifier) path += `?qualifier=${encodeURIComponent(flags.qualifier)}`;
        await renderInvokeTui(path, invokeCtx, core, io);
        return;
      }

      const prompt = flags.prompt;
      const invoke = () =>
        invokeHarnessTurn(
          core.harness,
          {
            harnessId: deployed.id,
            prompt,
            qualifier: flags.qualifier,
            sessionId: flags["session-id"],
          },
          coreOptsFromCtx(invokeCtx),
        );
      const result = await runWithProgress(invoke, {
        io,
        label: "Invoking harness...",
        interactive: !ctx.require(JsonKey),
      });
      invokeCtx.require(JsonRendererKey).renderJson(result);
    },
  });
