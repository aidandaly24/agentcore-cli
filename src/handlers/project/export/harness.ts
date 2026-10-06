import { dirname, relative } from "node:path";
import z from "zod";
import {
  InputValidationError,
  MalformedServiceResponseError,
  ResourceNotFoundError,
} from "../../../errors";
import { createHandler, flag, ProjectKey } from "../../../router";
import { JsonRendererKey } from "../../../tui";
import { JsonKey } from "../../keys";
import { AgentNameSchema } from "../../../projectSchemas/runtime";
import { ProjectNameSchema } from "../../../projectSchemas/project";
import { DEFAULT_TARGET_NAME } from "../../../projectSchemas/aws-targets";
import { defaultExportProjectName } from "../../../core/project/fsUtils";
import { formatExportNotes } from "../../../core/project/templates/export";
import { assertMutuallyExclusiveFlags, coreOptsFromCtx } from "../../utils";
import type { ExportHarnessInput } from "../types";
import type { ExportProjectResourceConfig } from "./types";
import { harnessIdFromArn, mapServiceHarnessToSpec, regionFromHarnessArn } from "./serviceHarness";

export const createExportHarnessHandler = (config: ExportProjectResourceConfig) =>
  createHandler({
    name: "harness",
    description:
      "convert a harness into an editable Strands Runtime agent, creating a project if needed",
    flags: [
      flag(
        "project-name",
        "name of the project to create when exporting outside a project",
        ProjectNameSchema.optional(),
      ),
      flag("name", "the name of an in-project harness to export", z.string().optional()),
      flag(
        "arn",
        "the ARN of a deployed harness to fetch from the service and export",
        z.string().optional(),
      ),
      flag(
        "target-agent-name",
        "the name of the generated Runtime agent (default <harnessName>Agent)",
        z.string().optional(),
      ),
    ],
    handle: async (ctx, flags) => {
      assertMutuallyExclusiveFlags(flags, ["name", "arn"], { exactlyOne: true });

      const project = ctx.value(ProjectKey);
      const jsonOutput = ctx.require(JsonKey);
      if (project && flags["project-name"]) {
        throw new InputValidationError(
          "--project-name is only available outside an existing project",
        );
      }

      let input: ExportHarnessInput;
      if (flags.arn) {
        config.io.stderr.write(`Fetching harness from the service\n`);
        const harnessId = harnessIdFromArn(flags.arn);
        // The ARN names the region the harness lives in and takes precedence over
        // the CLI's resolved region, so service fetches never drift to ambient config.
        const coreOpts = coreOptsFromCtx(ctx);
        const region = regionFromHarnessArn(flags.arn);
        const response = await config.core.harness.getHarness(harnessId, { ...coreOpts, region });
        if (!response.harness) {
          throw new ResourceNotFoundError(`no harness exists for '${flags.arn}'`);
        }
        const mapped = mapServiceHarnessToSpec(response.harness);
        const { spec } = mapped;
        if (!response.harness.executionRoleArn) {
          throw new MalformedServiceResponseError(
            "GetHarness returned no executionRoleArn; source IAM capture is required for ARN export.",
          );
        }
        if (response.harness.arn && response.harness.arn !== flags.arn) {
          throw new MalformedServiceResponseError("GetHarness returned a different source ARN.");
        }
        const executionRoleSource = await config.core.executionRoleSource.read(
          response.harness.executionRoleArn,
          { ...coreOpts, region },
        );
        const projectName = project
          ? undefined
          : (flags["project-name"] ?? defaultExportProjectName(spec.name));
        input = {
          projectName,
          prefetched: { ...mapped, executionRoleSource, sourceArn: flags.arn },
          targetAgentName: resolveTargetAgentName(
            flags["target-agent-name"],
            spec.name,
            projectName,
          ),
        };
      } else {
        input = {
          harnessName: flags.name!,
          targetAgentName: resolveTargetAgentName(flags["target-agent-name"], flags.name!),
        };
      }

      // Progress goes to stderr, keeping stdout for machine output. Driven by
      // hand because the result is the generator's return value.
      const exportRun = config.projectManager.exportHarness(project, input);
      let next = await exportRun.next();
      while (!next.done) {
        if (next.value.type === "step") config.io.stderr.write(`${next.value.message}\n`);
        next = await exportRun.next();
      }
      const result = next.value;

      config.io.stderr.write(
        `Exported harness '${result.harnessName}' to runtime agent '${result.agentName}' (${result.agentPath})\n`,
      );
      for (const line of formatExportNotes(result.notes, result.notesPath)) {
        config.io.stderr.write(`${line.text}\n`);
      }
      const changeDirectory = project
        ? ""
        : `cd ${relative(process.cwd(), dirname(dirname(result.agentPath)))}, then `;
      config.io.stderr.write(
        `Next steps: ${changeDirectory}review the generated code, then ` +
          "`agentcore build` and `agentcore deploy`\n",
      );

      if (jsonOutput) {
        ctx.require(JsonRendererKey).renderJson({
          harnessName: result.harnessName,
          agentName: result.agentName,
          agentPath: result.agentPath,
          notesPath: result.notesPath,
          notes: result.notes,
        });
      }
    },
  });

/** Default the target agent name to `<harnessName>Agent` and validate it. */
function resolveTargetAgentName(
  flagValue: string | undefined,
  harnessName: string,
  projectName?: string,
): string {
  // New projects deploy under <project>_default_<agent>, whose physical name is capped at 48.
  const budget = projectName ? 48 - projectName.length - DEFAULT_TARGET_NAME.length - 2 : 48;
  const targetAgentName = flagValue ?? `${harnessName.slice(0, budget - "Agent".length)}Agent`;
  const parsed = AgentNameSchema.safeParse(targetAgentName);
  if (!parsed.success) {
    throw new InputValidationError(
      `invalid --target-agent-name "${targetAgentName}": ${parsed.error.issues[0]?.message ?? "invalid name"}`,
    );
  }
  if (targetAgentName.length > budget) {
    throw new InputValidationError(
      `--target-agent-name "${targetAgentName}" must fit within ${budget} characters for project "${projectName}"`,
    );
  }
  return parsed.data;
}
