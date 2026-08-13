import { describe, expect, test } from "bun:test";
import { createRootHandler } from "../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";

async function run(
  args: string[],
  core = new TestCoreClient(),
): Promise<{ core: TestCoreClient; stderr: string }> {
  const io = testIO();
  const root = createRootHandler(core, {
    io: io.io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
  return { core, stderr: io.stderr() };
}

describe("Harness execution-role policy UX", () => {
  test("identifies an explicit create role as customer-managed", async () => {
    const roleArn = "arn:aws:iam::123456789012:role/CustomerHarnessRole";
    const { stderr } = await run([
      "harness",
      "create",
      "--name",
      "orders",
      "--execution-role-arn",
      roleArn,
    ]);

    expect(stderr).toContain(
      `Using customer-managed execution role ${roleArn}; IAM policies will not be modified.`,
    );
  });

  test("warns before updating a Harness with an unknown role", async () => {
    const core = new TestCoreClient();
    const roleArn = "arn:aws:iam::123456789012:role/CdkHarnessRole";
    core.harness.getHarnessRolePolicyWarning = async () => ({
      reason: "unknown-role",
      roleArn,
    });

    const { stderr } = await run(
      ["harness", "update", "--id", "orders-abc123", "--max-iterations", "10"],
      core,
    );

    expect(stderr).toContain(`Execution role ${roleArn} is not recognized`);
  });

  test("skip-role-policy-update bypasses warning preflight and reaches Core", async () => {
    const core = new TestCoreClient();
    core.harness.getHarnessRolePolicyWarning = async () => {
      throw new Error("warning preflight must be skipped");
    };

    const { stderr } = await run(
      [
        "harness",
        "update",
        "--id",
        "orders-abc123",
        "--max-iterations",
        "10",
        "--skip-role-policy-update",
      ],
      core,
    );

    expect(stderr).not.toContain("Execution role");
    expect(
      core.harness.calls.find((call) => call.method === "updateHarness")?.args[0],
    ).toMatchObject({
      harnessId: "orders-abc123",
      maxIterations: 10,
      skipRolePolicyUpdate: true,
    });
  });
});
