import { afterEach, describe, expect, test } from "bun:test";
import { createPaymentProjectTestHarness } from "../../payment-test-support";

const { cleanup, inProject, projectSpec, run } =
  createPaymentProjectTestHarness("payment-credential");

afterEach(cleanup);

describe("project add credentials payment", () => {
  test.each(["CoinbaseCDP", "StripePrivy"] as const)(
    "adds a reusable %s payment credential",
    async (provider) => {
      const projectRoot = await inProject();

      const io = await run([
        "add",
        "credentials",
        "payment",
        "--name",
        `${provider.toLowerCase()}-credential`,
        "--provider",
        provider,
      ]);

      expect((await projectSpec(projectRoot)).credentials).toEqual([
        {
          authorizerType: "PaymentCredentialProvider",
          name: `${provider.toLowerCase()}-credential`,
          provider,
        },
      ]);
      expect(io.stderr()).toContain(`added credential '${provider.toLowerCase()}-credential'`);
    },
  );

  test.each([
    ["missing name", ["--provider", "CoinbaseCDP"], "required option '--name"],
    ["missing provider", ["--name", "payment-credential"], "required option '--provider"],
    [
      "unsupported provider",
      ["--name", "payment-credential", "--provider", "Unsupported"],
      "Invalid value for option '--provider'",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    const projectRoot = await inProject();

    await expect(run(["add", "credentials", "payment", ...flags])).rejects.toThrow(message);
    expect((await projectSpec(projectRoot)).credentials ?? []).toEqual([]);
  });

  test("rejects duplicate names across credential types", async () => {
    const projectRoot = await inProject();
    await run(["add", "credentials", "api-key", "--name", "shared"]);

    await expect(
      run(["add", "credentials", "payment", "--name", "shared", "--provider", "CoinbaseCDP"]),
    ).rejects.toThrow("already exists");

    expect((await projectSpec(projectRoot)).credentials).toHaveLength(1);
  });

  test("rejects names that collide after environment normalization", async () => {
    const projectRoot = await inProject();
    await run(["add", "credentials", "api-key", "--name", "service-key"]);

    await expect(
      run(["add", "credentials", "payment", "--name", "service_key", "--provider", "CoinbaseCDP"]),
    ).rejects.toThrow("environment variable");

    expect((await projectSpec(projectRoot)).credentials).toHaveLength(1);
  });
});
