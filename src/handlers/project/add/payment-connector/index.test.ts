import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createPaymentProjectTestHarness } from "../payment-test-support";

const { cleanup, inProject, projectSpec, run, writeProjectSpec } =
  createPaymentProjectTestHarness("payment-connector");

afterEach(cleanup);

async function addManager() {
  await run(["add", "payment-manager", "--name", "payments"]);
}

async function addCredential(name: string, provider: "CoinbaseCDP" | "StripePrivy") {
  await run(["add", "credentials", "payment", "--name", name, "--provider", provider]);
}

describe("project add payment-connector", () => {
  test.each([
    ["CoinbaseCDP", "coinbase"],
    ["StripePrivy", "stripe"],
  ] as const)("reuses an existing %s credential", async (provider, name) => {
    const projectRoot = await inProject();
    await addManager();
    await addCredential(`${name}-credential`, provider);

    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      name,
      "--credential",
      `${name}-credential`,
    ]);

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([
      {
        name,
        provider,
        credentialName: `${name}-credential`,
      },
    ]);
  });

  test.each([
    ["CoinbaseCDP", "coinbase"],
    ["StripePrivy", "stripe"],
  ] as const)("atomically creates a %s credential and connector", async (provider, name) => {
    const projectRoot = await inProject();
    await addManager();

    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      name,
      "--create-credential",
      `${name}-credential`,
      "--provider",
      provider,
    ]);

    const spec = await projectSpec(projectRoot);
    expect(spec.credentials).toEqual([
      {
        authorizerType: "PaymentCredentialProvider",
        name: `${name}-credential`,
        provider,
      },
    ]);
    expect(spec.payments[0].connectors).toEqual([
      {
        name,
        provider,
        credentialName: `${name}-credential`,
      },
    ]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    const prefix = `AGENTCORE_CREDENTIAL_${name.toUpperCase()}_CREDENTIAL`;
    const suffixes =
      provider === "CoinbaseCDP"
        ? ["API_KEY_ID", "API_KEY_SECRET", "WALLET_SECRET"]
        : ["APP_ID", "APP_SECRET", "AUTHORIZATION_PRIVATE_KEY", "AUTHORIZATION_ID"];
    for (const suffix of suffixes) {
      expect(env).toContain(`${prefix}_${suffix}=\n`);
    }
  });

  test("atomically stores supplied payment credential values with a connector", async () => {
    const projectRoot = await inProject();
    await addManager();
    const appSecretPath = join(projectRoot, "app-secret.txt");
    const privateKeyPath = join(projectRoot, "private-key.txt");
    await Bun.write(appSecretPath, "app-secret\n");
    await Bun.write(privateKeyPath, "private-key\n");

    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "stripe",
      "--create-credential",
      "stripe-credential",
      "--provider",
      "StripePrivy",
      "--app-id",
      "app-id",
      "--app-secret",
      `file://${appSecretPath}`,
      "--authorization-private-key",
      `file://${privateKeyPath}`,
      "--authorization-id",
      "authorization-id",
    ]);

    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).toContain("AGENTCORE_CREDENTIAL_STRIPE_CREDENTIAL_APP_ID='app-id'");
    expect(env).toContain("AGENTCORE_CREDENTIAL_STRIPE_CREDENTIAL_APP_SECRET='app-secret'");
    expect(env).toContain(
      "AGENTCORE_CREDENTIAL_STRIPE_CREDENTIAL_AUTHORIZATION_PRIVATE_KEY='private-key'",
    );
    expect(env).toContain(
      "AGENTCORE_CREDENTIAL_STRIPE_CREDENTIAL_AUTHORIZATION_ID='authorization-id'",
    );
  });

  test("adds Quick Create without a payment credential", async () => {
    const projectRoot = await inProject();
    await addManager();

    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "coinbase",
      "--quick-create",
    ]);

    const spec = await projectSpec(projectRoot);
    expect(spec.credentials).toEqual([]);
    expect(spec.payments[0].connectors).toEqual([
      {
        name: "coinbase",
        provider: "CoinbaseCDP",
        provisionMode: "QUICK_CREATE",
      },
    ]);
  });

  test("rejects Quick Create when the project has legacy generated CDK assets", async () => {
    const projectRoot = await inProject();
    await addManager();
    const packagePath = join(projectRoot, "agentcore", "cdk", "package.json");
    const packageJson = await Bun.file(packagePath).json();
    delete packageJson.agentcoreProject;
    await Bun.write(packagePath, JSON.stringify(packageJson, undefined, 2));

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "coinbase",
        "--quick-create",
      ]),
    ).rejects.toThrow("generated CDK assets");

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([]);
  });

  test.each([
    ["missing manager", ["--name", "connector", "--quick-create"], "required option '--manager"],
    ["missing name", ["--manager", "payments", "--quick-create"], "required option '--name"],
    ["no mode", ["--manager", "payments", "--name", "connector"], "specify exactly one"],
    [
      "multiple modes",
      [
        "--manager",
        "payments",
        "--name",
        "connector",
        "--credential",
        "existing",
        "--quick-create",
      ],
      "specify exactly one",
    ],
    [
      "create without provider",
      ["--manager", "payments", "--name", "connector", "--create-credential", "new-credential"],
      "--create-credential requires --provider",
    ],
    [
      "provider outside create mode",
      [
        "--manager",
        "payments",
        "--name",
        "connector",
        "--quick-create",
        "--provider",
        "CoinbaseCDP",
      ],
      "valid only with --create-credential",
    ],
    [
      "credential values outside create mode",
      [
        "--manager",
        "payments",
        "--name",
        "connector",
        "--quick-create",
        "--api-key-id",
        "api-key-id",
      ],
      "valid only with --create-credential",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    const projectRoot = await inProject();
    await addManager();

    await expect(run(["add", "payment-connector", ...flags])).rejects.toThrow(message);
    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([]);
  });

  test("rejects unknown managers and credentials", async () => {
    const projectRoot = await inProject();
    await addManager();

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "missing",
        "--name",
        "connector",
        "--quick-create",
      ]),
    ).rejects.toThrow("does not exist");
    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "connector",
        "--credential",
        "missing",
      ]),
    ).rejects.toThrow("does not exist in credentials[]");

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([]);
  });

  test("rejects non-payment credentials", async () => {
    const projectRoot = await inProject();
    await addManager();
    await run(["add", "credentials", "api-key", "--name", "api-key"]);

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "connector",
        "--credential",
        "api-key",
      ]),
    ).rejects.toThrow("not a PaymentCredentialProvider");

    expect((await projectSpec(projectRoot)).payments[0].connectors).toEqual([]);
  });

  test("rejects duplicate connector names without creating an orphan credential", async () => {
    const projectRoot = await inProject();
    await addManager();
    await run([
      "add",
      "payment-connector",
      "--manager",
      "payments",
      "--name",
      "connector",
      "--quick-create",
    ]);

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "connector",
        "--create-credential",
        "orphan",
        "--provider",
        "CoinbaseCDP",
      ]),
    ).rejects.toThrow("already exists");

    const spec = await projectSpec(projectRoot);
    expect(spec.credentials).toEqual([]);
    expect(spec.payments[0].connectors).toHaveLength(1);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_ORPHAN");
  });

  test("leaves no credential or connector after whole-project validation fails", async () => {
    const projectRoot = await inProject();
    await addManager();
    await run(["add", "credentials", "api-key", "--name", "service-key"]);

    await expect(
      run([
        "add",
        "payment-connector",
        "--manager",
        "payments",
        "--name",
        "connector",
        "--create-credential",
        "service_key",
        "--provider",
        "CoinbaseCDP",
      ]),
    ).rejects.toThrow("environment variable");

    const spec = await projectSpec(projectRoot);
    expect(spec.credentials).toEqual([
      {
        authorizerType: "ApiKeyCredentialProvider",
        name: "service-key",
      },
    ]);
    expect(spec.payments[0].connectors).toEqual([]);
    const env = await Bun.file(join(projectRoot, "agentcore", ".env.local")).text();
    expect(env).not.toContain("AGENTCORE_CREDENTIAL_SERVICE_KEY_API_KEY_ID");
  });

  test("rejects provider mismatches in complete project data", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.credentials = [
      {
        authorizerType: "PaymentCredentialProvider",
        name: "coinbase",
        provider: "CoinbaseCDP",
      },
    ];
    spec.payments = [
      {
        name: "payments",
        connectors: [
          {
            name: "stripe",
            provider: "StripePrivy",
            credentialName: "coinbase",
          },
        ],
      },
    ];
    await writeProjectSpec(projectRoot, spec);

    await expect(run(["add", "credentials", "api-key", "--name", "trigger"])).rejects.toThrow(
      "uses provider",
    );
  });
});
