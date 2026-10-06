import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  cdkCompatibilityWarning,
  MINIMUM_COMPATIBLE_CDK_VERSION,
  requireExplicitRoleCapability,
} from "./compatibility";
import { ProjectRuntimeSchema } from "../../../../projectSchemas/runtime";

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function cdkDirectoryWith(version: unknown): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-compatibility-"));
  tempDirectories.push(directory);
  const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
  await mkdir(packageDirectory, { recursive: true });
  await writeFile(join(packageDirectory, "package.json"), JSON.stringify({ version }));
  return directory;
}

describe("cdkCompatibilityWarning", () => {
  test.each(["missing", "stripped", "partial", "supported"])(
    "checks the installed public schema capability: %s",
    async (capability) => {
      const directory = await cdkDirectoryWith("999.0.0");
      const packageDirectory = join(directory, "node_modules", "@aws", "agentcore-cdk");
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({ version: "999.0.0", main: "index.cjs" }),
      );
      await writeFile(
        join(packageDirectory, "index.cjs"),
        capability === "missing"
          ? "module.exports = {};"
          : `module.exports.AgentEnvSpecSchema = { safeParse(value) { return { success: true, data: ${capability === "supported" ? "value" : capability === "partial" ? '{ executionRoleConfig: { policyMode: "explicit" } }' : "{}"} }; } };`,
      );
      const runtime = ProjectRuntimeSchema.parse({
        name: "exported",
        build: "CodeZip",
        entrypoint: "main.py",
        codeLocation: "app/exported",
        runtimeVersion: "PYTHON_3_14",
        executionRoleConfig: {
          policyMode: "explicit",
          tags: { team: "agents" },
          permissionsBoundaryArn: "arn:aws:iam::111122223333:policy/Boundary",
        },
      });
      if (capability === "supported")
        expect(() => requireExplicitRoleCapability(directory, [runtime])).not.toThrow();
      else
        expect(() => requireExplicitRoleCapability(directory, [runtime])).toThrow(
          /executionRoleConfig/,
        );
    },
  );

  test("normal projects keep the version-warning behavior without loading the CDK module", () => {
    expect(() => requireExplicitRoleCapability("/missing", [])).not.toThrow();
  });
  test.each(["0.0.0-0", "1.0.0-rc.1", "1.0.0-rc.2"])(
    "warns for incompatible version %s",
    async (version) => {
      const directory = await cdkDirectoryWith(version);

      const warning = await cdkCompatibilityWarning(directory);

      expect(warning).toContain(`@aws/agentcore-cdk ${version}`);
      expect(warning).toContain(`${MINIMUM_COMPATIBLE_CDK_VERSION} or newer`);
      expect(warning).toContain("Update the CDK dependency, then rebuild or redeploy");
    },
  );

  test.each([MINIMUM_COMPATIBLE_CDK_VERSION, "999.0.0"])(
    "does not warn for compatible version %s",
    async (version) => {
      const directory = await cdkDirectoryWith(version);
      expect(await cdkCompatibilityWarning(directory)).toBeUndefined();
    },
  );

  test.each([undefined, "not-semver"])(
    "does not replace dependency errors for an unreadable version %s",
    async (version) => {
      const directory = await cdkDirectoryWith(version);
      expect(await cdkCompatibilityWarning(directory)).toBeUndefined();
    },
  );

  test("does not replace dependency errors when the package is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agentcore-cdk-compatibility-"));
    tempDirectories.push(directory);
    expect(await cdkCompatibilityWarning(directory)).toBeUndefined();
  });
});
