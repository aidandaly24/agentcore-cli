import { readFile } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { ProjectStateError } from "../../../../errors";
import type { ProjectRuntime } from "../../../../projectSchemas/runtime";

export const MINIMUM_COMPATIBLE_CDK_VERSION = "1.0.0-rc.3";

export function requireExplicitRoleCapability(
  cdkDirectory: string,
  runtimes: ProjectRuntime[],
): void {
  const explicit = runtimes.filter((runtime) => runtime.executionRoleConfig !== undefined);
  if (explicit.length === 0) return;
  try {
    const require = createRequire(join(cdkDirectory, "package.json"));
    const { AgentEnvSpecSchema } = require("@aws/agentcore-cdk") as {
      AgentEnvSpecSchema?: {
        safeParse(value: unknown): { success: boolean; data?: ProjectRuntime };
      };
    };
    for (const runtime of explicit) {
      const result = AgentEnvSpecSchema?.safeParse(runtime);
      if (
        !result?.success ||
        !isDeepStrictEqual(result.data?.executionRoleConfig, runtime.executionRoleConfig)
      ) {
        throw new Error("Installed public schema does not retain executionRoleConfig");
      }
    }
  } catch (cause) {
    throw new ProjectStateError(
      "This project uses explicit execution-role policies, but its installed @aws/agentcore-cdk does not support executionRoleConfig. Install a companion CDK release with that capability before building or deploying. Exported access restrictions must not be stripped.",
      { cause },
    );
  }
}

export async function cdkCompatibilityWarning(cdkDirectory: string): Promise<string | undefined> {
  const packagePath = join(cdkDirectory, "node_modules", "@aws", "agentcore-cdk", "package.json");

  let installedVersion: unknown;
  try {
    const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
      version?: unknown;
    };
    installedVersion = packageJson.version;
  } catch {
    return undefined;
  }

  if (
    typeof installedVersion !== "string" ||
    semver.valid(installedVersion) === null ||
    !semver.lt(installedVersion, MINIMUM_COMPATIBLE_CDK_VERSION)
  ) {
    return undefined;
  }

  return (
    `This project uses @aws/agentcore-cdk ${installedVersion}, but this CLI requires ` +
    `${MINIMUM_COMPATIBLE_CDK_VERSION} or newer for full compatibility. ` +
    `Update the CDK dependency, then rebuild or redeploy.`
  );
}
