import z from "zod";
import { InputValidationError, ResourceNotFoundError } from "../../../errors";
import type { AppIO } from "../../../io";
import { withUserCancellation } from "../../../runnable";
import { argument, createHandler, flag, ProjectKey, type Context } from "../../../router";
import { JsonRendererKey, renderTuiAt } from "../../../tui";
import { RuntimeInvokeLaunchContextKey } from "../../runtime/invoke/launchContext";
import { invokeRuntimeTarget } from "../../runtime/invoke/operation";
import {
  resolveRuntimeInvokeSources,
  resolveRuntimeInvokeTuiBearerToken,
} from "../../runtime/invoke/request";
import { renderPromptResponseBody } from "../../runtime/invoke/promptResponse";
import { writeRuntimeInvokeResponse } from "../../runtime/invoke/response";
import { invokeHarnessTurn } from "../../harness/invoke/operation";
import { JsonKey, RegionKey } from "../../keys";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { Project, ProjectInvokableResource } from "../types";

type SelectedResource = {
  resourceType: ProjectInvokableResource;
  name: string;
};

function availableNames(project: Project, resourceType: ProjectInvokableResource): string[] {
  return (resourceType === "runtime" ? project.spec.runtimes : project.spec.harnesses).map(
    ({ name }) => name,
  );
}

function selectResource(
  project: Project,
  runtimeName: string | undefined,
  harnessName: string | undefined,
): SelectedResource {
  if (runtimeName !== undefined && harnessName !== undefined) {
    throw new InputValidationError("--runtime and --harness are mutually exclusive");
  }
  if (runtimeName !== undefined) {
    const names = availableNames(project, "runtime");
    if (!names.includes(runtimeName)) {
      throw new ResourceNotFoundError(
        `Runtime '${runtimeName}' was not found. Available Runtimes: ${names.join(", ") || "none"}.`,
      );
    }
    return { resourceType: "runtime", name: runtimeName };
  }
  if (harnessName !== undefined) {
    const names = availableNames(project, "harness");
    if (!names.includes(harnessName)) {
      throw new ResourceNotFoundError(
        `Harness '${harnessName}' was not found. Available Harnesses: ${names.join(", ") || "none"}.`,
      );
    }
    return { resourceType: "harness", name: harnessName };
  }

  const runtimes = availableNames(project, "runtime");
  const harnesses = availableNames(project, "harness");
  if (runtimes.length + harnesses.length === 1) {
    return runtimes.length === 1
      ? { resourceType: "runtime", name: runtimes[0]! }
      : { resourceType: "harness", name: harnesses[0]! };
  }
  if (runtimes.length === 0 && harnesses.length === 0) {
    throw new InputValidationError("This project has no Runtimes or Harnesses to invoke.");
  }
  throw new InputValidationError(
    `Project has multiple invokable resources. Specify one:\n` +
      `  --runtime: ${runtimes.join(", ") || "none"}\n` +
      `  --harness: ${harnesses.join(", ") || "none"}`,
  );
}

function targetContext(ctx: Context, region: string): Context {
  return ctx.withValue(RegionKey, region);
}

export const createProjectInvokeHandler = (
  core: Core,
  io: AppIO,
  renderInvokeTui: typeof renderTuiAt = renderTuiAt,
) =>
  createHandler({
    name: "invoke",
    description: "invoke a Runtime or Harness in the current project",
    arguments: [argument("content", "content to send", z.string().optional())],
    flags: [
      flag("runtime", "project Runtime to invoke", z.string().optional()),
      flag("harness", "project Harness to invoke", z.string().optional()),
      flag("target", "project deployment target", z.string().default("default")),
      flag("session-id", "session ID to continue", z.string().optional()),
      flag("qualifier", "endpoint qualifier", z.string().optional()),
      flag("bearer-token", "the CUSTOM_JWT bearer token", z.string().optional(), {
        sensitive: true,
      }),
    ],
    handle: async (ctx, flags, args) => {
      const project = ctx.require(ProjectKey);
      const selected = selectResource(project, flags.runtime, flags.harness);
      const jsonOutput = ctx.require(JsonKey);
      if (selected.resourceType === "harness" && flags["bearer-token"] !== undefined) {
        throw new InputValidationError("--bearer-token is only valid with --runtime");
      }
      if (
        selected.resourceType === "harness" &&
        flags["session-id"] !== undefined &&
        (flags["session-id"].length < 33 || flags["session-id"].length > 100)
      ) {
        throw new InputValidationError("Harness session ID must be between 33 and 100 characters");
      }
      if (args.content === undefined && jsonOutput) {
        throw new InputValidationError("content is required with --json");
      }

      const deployed = await core.projectManager.resolveDeployedResource(project, {
        target: flags.target,
        ...selected,
      });
      const invokeCtx = targetContext(ctx, deployed.target.region);
      const options = coreOptsFromCtx(invokeCtx);

      if (args.content === undefined) {
        if (selected.resourceType === "runtime") {
          let path = `/agentcore/runtime/invoke/${encodeURIComponent(deployed.id)}`;
          if (flags.qualifier !== undefined) path += `/${encodeURIComponent(flags.qualifier)}`;
          const bearerToken = await resolveRuntimeInvokeTuiBearerToken(
            flags["bearer-token"],
            io.stdin,
          );
          await renderInvokeTui(
            path,
            invokeCtx.withValue(RuntimeInvokeLaunchContextKey, {
              runtimeId: deployed.id,
              runtimeSessionId: flags["session-id"],
              bearerToken,
              inputMode: "prompt",
            }),
            core,
            io,
          );
          return;
        }

        let path = `/agentcore/harness/invoke/${encodeURIComponent(deployed.id)}`;
        if (flags["session-id"]) path += `/${encodeURIComponent(flags["session-id"])}`;
        if (flags.qualifier) path += `?qualifier=${encodeURIComponent(flags.qualifier)}`;
        await renderInvokeTui(path, invokeCtx, core, io);
        return;
      }

      if (selected.resourceType === "harness") {
        const result = await invokeHarnessTurn(
          core.harness,
          {
            harnessId: deployed.id,
            prompt: args.content,
            qualifier: flags.qualifier,
            sessionId: flags["session-id"],
          },
          options,
        );
        invokeCtx.require(JsonRendererKey).renderJson(result);
        return;
      }

      await withUserCancellation(async (signal) => {
        const sources = await resolveRuntimeInvokeSources(
          {
            payload: JSON.stringify({ prompt: args.content }),
            bearerToken: flags["bearer-token"],
          },
          io.stdin,
          signal,
        );
        const response = await invokeRuntimeTarget(
          core.runtime,
          {
            runtimeId: deployed.id,
            qualifier: flags.qualifier,
            payload: sources.payload,
            contentType: "application/json",
            runtimeSessionId: flags["session-id"],
            bearerToken: sources.bearerToken,
          },
          options,
          signal,
        );
        await writeRuntimeInvokeResponse(
          jsonOutput
            ? response
            : {
                ...response,
                body: renderPromptResponseBody(response.contentType, response.body),
              },
          {
            stdout: io.stdout,
            stderr: io.stderr,
            json: jsonOutput,
            signal,
          },
          {
            binaryTtyError: "Binary or unknown response content requires --json",
          },
        );
      });
    },
  });
