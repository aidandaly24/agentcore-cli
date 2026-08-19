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
    spec.credentials = [{ authorizerType: "OAuthCredentialProvider", name: "search-oauth" }];
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

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual(target);
  });

  test("allows equal Target names in different Gateways but not the same Gateway", async () => {
    const projectRoot = await inProject();
    await addGateway("tools");
    await addGateway("payments");
    for (const gateway of ["tools", "payments"]) {
      await run([
        "add",
        "gateway-target",
        "--gateway",
        gateway,
        "--name",
        "search",
        "--endpoint",
        `https://${gateway}.example.com`,
      ]);
    }
    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--name",
        "search",
        "--endpoint",
        "https://duplicate.example.com",
      ]),
    ).rejects.toThrow("already exists");

    const gateways = (await projectSpec(projectRoot)).agentCoreGateways;
    expect(gateways[0].targets).toHaveLength(1);
    expect(gateways[1].targets).toHaveLength(1);
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
});
