import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRootHandler } from "../../index";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../../testing";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function run(args: string[], stdin?: string) {
  const io = testIO();
  if (stdin !== undefined) io.io.stdin.end(stdin);
  const root = createRootHandler(new TestCoreClient(), {
    io: io.io,
    globalConfigAccessor: new TestGlobalConfigAccessor(),
    logger: createSilentLogger(),
  });
  await root.route(["node", "agentcore", "project", ...args]);
  return io;
}

async function inProject(name = "TestProject"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-gateway-add-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  await run(["create", "--name", name, "--skip-install", "--skip-git"]);
  const projectRoot = join(directory, name);
  process.chdir(projectRoot);
  return projectRoot;
}

async function projectSpec(projectRoot: string) {
  return Bun.file(join(projectRoot, "agentcore", "agentcore.json")).json();
}

async function writeProjectSpec(projectRoot: string, spec: unknown): Promise<void> {
  await Bun.write(
    join(projectRoot, "agentcore", "agentcore.json"),
    JSON.stringify(spec, undefined, 2),
  );
}

async function addGateway(name = "tools"): Promise<void> {
  await run(["add", "gateway", "--name", name]);
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("project add gateway", () => {
  test("adds the default unrestricted Gateway", async () => {
    const projectRoot = await inProject();
    const io = await run(["add", "gateway", "--name", "tools"]);

    expect((await projectSpec(projectRoot)).agentCoreGateways).toEqual([
      {
        name: "tools",
        protocolType: "None",
        targets: [],
        authorizerType: "NONE",
        enableSemanticSearch: false,
        exceptionLevel: "NONE",
      },
    ]);
    expect(io.stderr()).toContain("added Gateway 'tools'");
  });

  test("maps scalar flags directly to Gateway project fields", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.policyEngines = [{ name: "Guardrails", policies: [] }];
    await writeProjectSpec(projectRoot, spec);

    await run([
      "add",
      "gateway",
      "--name",
      "tools",
      "--protocol",
      "mcp",
      "--enable-semantic-search",
      "--role-arn",
      "arn:aws:iam::123456789012:role/GatewayRole",
      "--description",
      "Project tools",
      "--policy-engine-name",
      "Guardrails",
      "--policy-engine-mode",
      "enforce",
      "--exception-level",
      "debug",
      "--tags",
      '{"team":"agents"}',
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0]).toMatchObject({
      name: "tools",
      protocolType: "MCP",
      description: "Project tools",
      authorizerType: "NONE",
      enableSemanticSearch: true,
      exceptionLevel: "DEBUG",
      executionRoleArn: "arn:aws:iam::123456789012:role/GatewayRole",
      policyEngineConfiguration: { policyEngineName: "Guardrails", mode: "ENFORCE" },
      tags: { team: "agents" },
    });
  });

  test("reads project authorizerConfiguration from stdin without translation", async () => {
    const projectRoot = await inProject();
    await run(
      [
        "add",
        "gateway",
        "--name",
        "secure",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        "-",
      ],
      JSON.stringify({
        customJwtAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedAudience: ["agentcore"],
        },
      }),
    );

    expect((await projectSpec(projectRoot)).agentCoreGateways[0]).toMatchObject({
      authorizerType: "CUSTOM_JWT",
      authorizerConfiguration: {
        customJwtAuthorizer: {
          discoveryUrl: "https://idp.example.com/.well-known/openid-configuration",
          allowedAudience: ["agentcore"],
        },
      },
    });
  });

  test("rejects the SDK authorizer shape", async () => {
    const projectRoot = await inProject();
    await expect(
      run([
        "add",
        "gateway",
        "--name",
        "secure",
        "--authorizer-type",
        "CUSTOM_JWT",
        "--authorizer-configuration",
        '{"customJWTAuthorizer":{"discoveryUrl":"https://idp.example.com/.well-known/openid-configuration"}}',
      ]),
    ).rejects.toThrow("customJWTAuthorizer");

    expect((await projectSpec(projectRoot)).agentCoreGateways ?? []).toEqual([]);
  });

  test("semantic search requires an MCP Gateway", async () => {
    await inProject();
    await expect(
      run(["add", "gateway", "--name", "tools", "--enable-semantic-search"]),
    ).rejects.toThrow("--protocol mcp");
  });

  test("reads tags from file, stdin, and repeated key=value flags", async () => {
    const projectRoot = await inProject();
    const tagsPath = join(projectRoot, "tags.json");
    await writeFile(tagsPath, '{"source":"file"}');

    await run(["add", "gateway", "--name", "from-file", "--tags", `file://${tagsPath}`]);
    await run(["add", "gateway", "--name", "from-stdin", "--tags", "-"], '{"source":"stdin"}');
    await run(["add", "gateway", "--name", "from-pairs", "--tags", "source=pairs", "team=agents"]);

    const gateways = (await projectSpec(projectRoot)).agentCoreGateways;
    expect(gateways[0].tags).toEqual({ source: "file" });
    expect(gateways[1].tags).toEqual({ source: "stdin" });
    expect(gateways[2].tags).toEqual({ source: "pairs", team: "agents" });
  });

  test("maps log-only policy mode", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.policyEngines = [{ name: "Guardrails", policies: [] }];
    await writeProjectSpec(projectRoot, spec);

    await run([
      "add",
      "gateway",
      "--name",
      "tools",
      "--policy-engine-name",
      "Guardrails",
      "--policy-engine-mode",
      "log-only",
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].policyEngineConfiguration).toEqual(
      {
        policyEngineName: "Guardrails",
        mode: "LOG_ONLY",
      },
    );
  });

  test.each([
    ["missing --name", ["add", "gateway"], "required option '--name"],
    [
      "service resource name exceeds 48 characters",
      ["add", "gateway", "--name", "gateway-name-that-is-far-too-long-for-the-service"],
      "exceeds the service limit",
    ],
    [
      "policy engine name without mode",
      ["add", "gateway", "--name", "tools", "--policy-engine-name", "Guardrails"],
      "must be supplied together",
    ],
    [
      "policy engine mode without name",
      ["add", "gateway", "--name", "tools", "--policy-engine-mode", "enforce"],
      "must be supplied together",
    ],
    [
      "unknown policy engine",
      [
        "add",
        "gateway",
        "--name",
        "tools",
        "--policy-engine-name",
        "Missing",
        "--policy-engine-mode",
        "enforce",
      ],
      "does not exist in policyEngines[]",
    ],
    [
      "CUSTOM_JWT without configuration",
      ["add", "gateway", "--name", "tools", "--authorizer-type", "CUSTOM_JWT"],
      "CUSTOM_JWT requires --authorizer-configuration",
    ],
    [
      "configuration without CUSTOM_JWT",
      [
        "add",
        "gateway",
        "--name",
        "tools",
        "--authorizer-configuration",
        '{"customJwtAuthorizer":{"discoveryUrl":"https://idp.example.com"}}',
      ],
      "valid only with CUSTOM_JWT",
    ],
  ])("rejects %s", async (_label, args, message) => {
    await inProject();
    await expect(run(args)).rejects.toThrow(message);
  });
});

describe("project add gateway-target", () => {
  test("adds endpoint and project Runtime shortcuts", async () => {
    const projectRoot = await inProject();
    await addGateway();
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "external",
      "--endpoint",
      "https://mcp.example.com",
      "--outbound-auth",
      "none",
    ]);
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "runtime",
      "--runtime",
      "hello_world",
      "--runtime-endpoint",
      "DEFAULT",
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets).toEqual([
      {
        name: "external",
        targetType: "mcpServer",
        endpoint: "https://mcp.example.com",
        outboundAuth: { type: "NONE" },
      },
      {
        name: "runtime",
        targetType: "httpRuntime",
        httpRuntime: { runtime: "hello_world", runtimeEndpoint: "DEFAULT" },
      },
    ]);
  });

  test("persists a complete project Target object without translation or asset creation", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const target = {
      name: "search",
      targetType: "lambdaFunctionArn",
      lambdaFunctionArn: {
        lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
        toolSchemaFile: "schemas/tool-schema.json",
      },
    };

    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--target-configuration",
      JSON.stringify(target),
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual(target);
    expect(await Bun.file(join(projectRoot, "agentcore", "assets")).exists()).toBe(false);
  });

  test("accepts a project-owned compute Target represented by the project schema", async () => {
    const projectRoot = await inProject();
    await addGateway();
    const target = {
      name: "local-tool",
      targetType: "lambda",
      toolDefinitions: [
        {
          name: "search",
          description: "Search documents",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      compute: {
        host: "Lambda",
        implementation: {
          language: "Python",
          path: "app/search-tool",
          handler: "handler.py:handler",
        },
        pythonVersion: "PYTHON_3_12",
      },
    };

    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--target-configuration",
      JSON.stringify(target),
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual(target);
  });

  test.each(["file", "stdin"] as const)(
    "reads a complete project Target from %s",
    async (sourceKind) => {
      const projectRoot = await inProject();
      await addGateway();
      const target = {
        name: "source",
        targetType: "mcpServer",
        endpoint: "https://source.example.com",
      };
      const configuration = JSON.stringify(target);
      const path = join(projectRoot, "target.json");
      await writeFile(path, configuration);
      const source = sourceKind === "file" ? `file://${path}` : "-";

      await run(
        ["add", "gateway-target", "--gateway", "tools", "--target-configuration", source],
        sourceKind === "stdin" ? configuration : undefined,
      );

      expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual(target);
    },
  );

  test("rejects separate name and auth flags with complete Target JSON", async () => {
    await inProject();
    await addGateway();
    const target = JSON.stringify({
      name: "source",
      targetType: "mcpServer",
      endpoint: "https://source.example.com",
    });

    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--name",
        "duplicate",
        "--target-configuration",
        target,
      ]),
    ).rejects.toThrow("--name is part of --target-configuration");
    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--target-configuration",
        target,
        "--outbound-auth",
        "none",
      ]),
    ).rejects.toThrow("outboundAuth is part of --target-configuration");
  });

  test("validates direct project credential references", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.credentials = [
      { authorizerType: "OAuthCredentialProvider", name: "search-oauth" },
      { authorizerType: "ApiKeyCredentialProvider", name: "search-api-key" },
    ];
    await writeProjectSpec(projectRoot, spec);
    await addGateway();
    const target = {
      name: "oauth",
      targetType: "mcpServer",
      endpoint: "https://oauth.example.com",
      outboundAuth: {
        type: "OAUTH",
        credentialName: "search-oauth",
        scopes: ["read", "write"],
      },
    };

    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--target-configuration",
      JSON.stringify(target),
    ]);
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--target-configuration",
      JSON.stringify({
        name: "api-key",
        targetType: "openApiSchema",
        schemaSource: { inline: { path: "openapi.json" } },
        outboundAuth: { type: "API_KEY", credentialName: "search-api-key" },
      }),
    ]);

    const targets = (await projectSpec(projectRoot)).agentCoreGateways[0].targets;
    expect(targets[0]).toEqual(target);
    expect(targets[1].outboundAuth).toEqual({
      type: "API_KEY",
      credentialName: "search-api-key",
    });
  });

  test("adds an OAuth-authenticated endpoint shortcut", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.credentials = [{ authorizerType: "OAuthCredentialProvider", name: "oauth" }];
    await writeProjectSpec(projectRoot, spec);
    await addGateway();

    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "oauth-target",
      "--endpoint",
      "https://oauth.example.com",
      "--outbound-auth",
      "oauth",
      "--credential-name",
      "oauth",
      "--scope",
      "read",
      "write",
    ]);

    const targets = (await projectSpec(projectRoot)).agentCoreGateways[0].targets;
    expect(targets[0].outboundAuth).toEqual({
      type: "OAUTH",
      credentialName: "oauth",
      scopes: ["read", "write"],
    });
  });

  test.each([
    [
      "missing parent Gateway",
      ["--name", "target", "--endpoint", "https://mcp.example.com"],
      "required option '--gateway",
    ],
    ["no Target mode", ["--gateway", "tools", "--name", "target"], "specify exactly one"],
    [
      "multiple Target modes",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--runtime",
        "hello_world",
      ],
      "specify exactly one",
    ],
    [
      "runtime endpoint without Runtime mode",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--runtime-endpoint",
        "DEFAULT",
      ],
      "--runtime-endpoint requires --runtime",
    ],
    [
      "shortcut without name",
      ["--gateway", "tools", "--endpoint", "https://mcp.example.com"],
      "required option '--name",
    ],
    [
      "non-HTTPS endpoint",
      ["--gateway", "tools", "--name", "target", "--endpoint", "http://mcp.example.com"],
      "must use HTTPS",
    ],
    [
      "invalid endpoint",
      ["--gateway", "tools", "--name", "target", "--endpoint", "not-a-url"],
      "must be a valid HTTPS URL",
    ],
    [
      "credential without auth type",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--credential-name",
        "oauth",
      ],
      "--credential-name requires --outbound-auth",
    ],
    [
      "scope without auth type",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--scope",
        "read",
      ],
      "--scope requires --outbound-auth oauth",
    ],
    [
      "none auth with credential",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--outbound-auth",
        "none",
        "--credential-name",
        "oauth",
      ],
      "cannot be combined",
    ],
    [
      "OAuth without credential",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--outbound-auth",
        "oauth",
      ],
      "requires --credential-name",
    ],
    [
      "API key with OAuth scope",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--outbound-auth",
        "api-key",
        "--credential-name",
        "api-key",
        "--scope",
        "read",
      ],
      "--scope is valid only with --outbound-auth oauth",
    ],
    [
      "API-key endpoint shortcut unsupported by the project schema",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--outbound-auth",
        "api-key",
        "--credential-name",
        "api-key",
      ],
      "mcpServer targets do not support API_KEY outbound auth",
    ],
    [
      "unknown credential",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--outbound-auth",
        "oauth",
        "--credential-name",
        "missing",
      ],
      "does not exist in credentials[]",
    ],
    [
      "credential with wrong type",
      [
        "--gateway",
        "tools",
        "--name",
        "target",
        "--endpoint",
        "https://mcp.example.com",
        "--outbound-auth",
        "oauth",
        "--credential-name",
        "api-key",
      ],
      "not a OAuthCredentialProvider",
    ],
    [
      "unknown Gateway",
      ["--gateway", "missing", "--name", "target", "--endpoint", "https://mcp.example.com"],
      "does not exist in agentCoreGateways[]",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.credentials = [
      { authorizerType: "OAuthCredentialProvider", name: "oauth" },
      { authorizerType: "ApiKeyCredentialProvider", name: "api-key" },
    ];
    await writeProjectSpec(projectRoot, spec);
    await addGateway();

    await expect(run(["add", "gateway-target", ...flags])).rejects.toThrow(message);
  });

  test("rejects a direct API-key credential with the wrong project credential type", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.credentials = [{ authorizerType: "OAuthCredentialProvider", name: "oauth" }];
    await writeProjectSpec(projectRoot, spec);
    await addGateway();

    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--target-configuration",
        JSON.stringify({
          name: "target",
          targetType: "openApiSchema",
          schemaSource: { inline: { path: "openapi.json" } },
          outboundAuth: { type: "API_KEY", credentialName: "oauth" },
        }),
      ]),
    ).rejects.toThrow("not a ApiKeyCredentialProvider");
  });

  test("rejects duplicate Target names across every Gateway in the project", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    await addGateway("payments");
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "search",
      "--endpoint",
      "https://tools.example.com",
    ]);

    for (const gateway of ["tools", "payments"]) {
      await expect(
        run([
          "add",
          "gateway-target",
          "--gateway",
          gateway,
          "--name",
          "search",
          "--endpoint",
          `https://${gateway}.example.com`,
        ]),
      ).rejects.toThrow("already exists in gateway 'tools'");
    }

    const gateways = (await projectSpec(projectRoot)).agentCoreGateways;
    expect(gateways[0].targets).toHaveLength(1);
    expect(gateways[1].targets).toHaveLength(0);
  });

  test("rejects a Target name already present in unassignedTargets", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.unassignedTargets = [
      {
        name: "search",
        targetType: "mcpServer",
        endpoint: "https://unassigned.example.com",
      },
    ];
    await writeProjectSpec(projectRoot, spec);
    await addGateway("tools");

    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--name",
        "search",
        "--endpoint",
        "https://tools.example.com",
      ]),
    ).rejects.toThrow("unassigned gateway target");
  });
});

describe("project add gateway-connector", () => {
  test("adds curated web search and external Knowledge Base connectors", async () => {
    const projectRoot = await inProject();
    await addGateway();
    await run([
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--name",
      "web",
      "--connector",
      "web-search",
    ]);
    await run([
      "add",
      "gateway-connector",
      "--gateway",
      "tools",
      "--name",
      "knowledge",
      "--connector",
      "bedrock-knowledge-bases",
      "--knowledge-base",
      "ABCDEFGHIJ",
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets).toEqual([
      {
        name: "web",
        targetType: "connector",
        connectorId: "web-search",
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 10 } }],
      },
      {
        name: "knowledge",
        targetType: "connector",
        connectorId: "bedrock-knowledge-bases",
        configurations: [{ name: "Retrieve", parameterValues: { knowledgeBaseId: "ABCDEFGHIJ" } }],
      },
    ]);
  });

  test.each(["inline", "file", "stdin"] as const)(
    "reads a complete connector project Target from %s JSON",
    async (sourceKind) => {
      const projectRoot = await inProject();
      await addGateway();
      const target = {
        name: "configured",
        targetType: "connector",
        connectorId: "web-search",
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 3 } }],
      };
      const configuration = JSON.stringify(target);
      const path = join(projectRoot, "connector.json");
      await writeFile(path, configuration);
      const source =
        sourceKind === "inline" ? configuration : sourceKind === "file" ? `file://${path}` : "-";

      await run(
        ["add", "gateway-connector", "--gateway", "tools", "--connector-configuration", source],
        sourceKind === "stdin" ? configuration : undefined,
      );

      expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual(target);
    },
  );

  test("rejects a non-connector project Target", async () => {
    await inProject();
    await addGateway();
    await expect(
      run([
        "add",
        "gateway-connector",
        "--gateway",
        "tools",
        "--connector-configuration",
        '{"name":"server","targetType":"mcpServer","endpoint":"https://mcp.example.com"}',
      ]),
    ).rejects.toThrow('targetType: "connector"');
  });

  test.each([
    [
      "missing parent Gateway",
      ["--name", "web", "--connector", "web-search"],
      "required option '--gateway",
    ],
    ["no connector mode", ["--gateway", "tools", "--name", "web"], "specify exactly one"],
    [
      "both connector modes",
      [
        "--gateway",
        "tools",
        "--name",
        "web",
        "--connector",
        "web-search",
        "--connector-configuration",
        '{"name":"configured","targetType":"connector","connectorId":"web-search"}',
      ],
      "specify exactly one",
    ],
    [
      "name with complete connector JSON",
      [
        "--gateway",
        "tools",
        "--name",
        "web",
        "--connector-configuration",
        '{"name":"configured","targetType":"connector","connectorId":"web-search"}',
      ],
      "--name is part of --connector-configuration",
    ],
    [
      "knowledge base with complete connector JSON",
      [
        "--gateway",
        "tools",
        "--connector-configuration",
        '{"name":"configured","targetType":"connector","connectorId":"web-search"}',
        "--knowledge-base",
        "ABCDEFGHIJ",
      ],
      "--knowledge-base cannot be combined",
    ],
    [
      "shortcut without name",
      ["--gateway", "tools", "--connector", "web-search"],
      "required option '--name",
    ],
    [
      "knowledge base with Web Search",
      [
        "--gateway",
        "tools",
        "--name",
        "web",
        "--connector",
        "web-search",
        "--knowledge-base",
        "ABCDEFGHIJ",
      ],
      "--knowledge-base requires --connector bedrock-knowledge-bases",
    ],
    [
      "Knowledge Base connector without Knowledge Base",
      ["--gateway", "tools", "--name", "knowledge", "--connector", "bedrock-knowledge-bases"],
      "requires --knowledge-base",
    ],
  ])("rejects %s", async (_label, flags, message) => {
    await inProject();
    await addGateway();
    await expect(run(["add", "gateway-connector", ...flags])).rejects.toThrow(message);
  });
});
