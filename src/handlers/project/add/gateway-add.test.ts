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

  test("maps MCP, policy, role, exception, description, and tags", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.policyEngines = [{ name: "Guardrails", policies: [] }];
    await writeProjectSpec(projectRoot, spec);
    const protocolFile = join(projectRoot, "protocol.json");
    await writeFile(protocolFile, '{"mcp":{"searchType":"SEMANTIC"}}');

    await run([
      "add",
      "gateway",
      "--name",
      "tools",
      "--protocol",
      "mcp",
      "--protocol-configuration",
      `file://${protocolFile}`,
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

  test("reads CUSTOM_JWT configuration from stdin", async () => {
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
        customJWTAuthorizer: {
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

  test("rejects unsupported protocol fields without writing a Gateway", async () => {
    const projectRoot = await inProject();
    await expect(
      run([
        "add",
        "gateway",
        "--name",
        "tools",
        "--protocol",
        "mcp",
        "--protocol-configuration",
        '{"mcp":{"instructions":"not persistable"}}',
      ]),
    ).rejects.toThrow("mcp.instructions");

    expect((await projectSpec(projectRoot)).agentCoreGateways ?? []).toEqual([]);
  });
});

describe("project add gateway-target", () => {
  test("adds endpoint and project Runtime modes", async () => {
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

  test("materializes an inline Lambda tool schema", async () => {
    const projectRoot = await inProject();
    await addGateway();
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "search",
      "--target-configuration",
      JSON.stringify({
        mcp: {
          lambda: {
            lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
            toolSchema: {
              inlinePayload: [
                {
                  name: "search",
                  description: "Search",
                  inputSchema: { type: "object", properties: {} },
                },
              ],
            },
          },
        },
      }),
    ]);

    const managedPath = "agentcore/assets/gateways/tools/targets/search/tool-schema.json";
    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toEqual({
      name: "search",
      targetType: "lambdaFunctionArn",
      lambdaFunctionArn: {
        lambdaArn: "arn:aws:lambda:us-east-1:123456789012:function:search",
        toolSchemaFile: managedPath,
      },
    });
    expect(await Bun.file(join(projectRoot, managedPath)).json()).toEqual([
      {
        name: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
  });

  test("rejects an external MCP endpoint that does not use HTTPS", async () => {
    const projectRoot = await inProject();
    await addGateway();
    await expect(
      run([
        "add",
        "gateway-target",
        "--gateway",
        "tools",
        "--name",
        "insecure",
        "--endpoint",
        "http://mcp.example.com",
      ]),
    ).rejects.toThrow("must use HTTPS");

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets).toEqual([]);
  });

  test.each(["file", "stdin"] as const)(
    "reads Target configuration from %s",
    async (sourceKind) => {
      const projectRoot = await inProject();
      await addGateway();
      const configuration = JSON.stringify({
        mcp: { mcpServer: { endpoint: "https://source.example.com" } },
      });
      const path = join(projectRoot, "target.json");
      await writeFile(path, configuration);
      const source = sourceKind === "file" ? `file://${path}` : "-";

      await run(
        [
          "add",
          "gateway-target",
          "--gateway",
          "tools",
          "--name",
          "source",
          "--target-configuration",
          source,
        ],
        sourceKind === "stdin" ? configuration : undefined,
      );

      expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toMatchObject({
        name: "source",
        targetType: "mcpServer",
        endpoint: "https://source.example.com",
      });
    },
  );

  test("resolves compatible project credentials", async () => {
    const projectRoot = await inProject();
    const spec = await projectSpec(projectRoot);
    spec.credentials = [
      { authorizerType: "OAuthCredentialProvider", name: "search-oauth" },
      { authorizerType: "ApiKeyCredentialProvider", name: "search-key" },
    ];
    await writeProjectSpec(projectRoot, spec);
    await addGateway();
    await run([
      "add",
      "gateway-target",
      "--gateway",
      "tools",
      "--name",
      "oauth",
      "--endpoint",
      "https://oauth.example.com",
      "--outbound-auth",
      "oauth",
      "--credential-name",
      "search-oauth",
      "--scope",
      "read",
      "write",
    ]);

    expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0].outboundAuth).toEqual({
      type: "OAUTH",
      credentialName: "search-oauth",
      scopes: ["read", "write"],
    });
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
    expect(gateways.map((gateway: { targets: unknown[] }) => gateway.targets)).toHaveLength(2);
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
    "reads Connector configuration from %s JSON",
    async (sourceKind) => {
      const projectRoot = await inProject();
      await addGateway();
      const configuration = JSON.stringify({
        mcp: {
          connector: {
            source: { connectorId: "web-search" },
            configurations: [{ name: "WebSearch", parameterValues: { maxResults: 3 } }],
          },
        },
      });
      const path = join(projectRoot, "connector.json");
      await writeFile(path, configuration);
      const source =
        sourceKind === "inline" ? configuration : sourceKind === "file" ? `file://${path}` : "-";

      await run(
        [
          "add",
          "gateway-connector",
          "--gateway",
          "tools",
          "--name",
          "configured",
          "--connector-configuration",
          source,
        ],
        sourceKind === "stdin" ? configuration : undefined,
      );

      expect((await projectSpec(projectRoot)).agentCoreGateways[0].targets[0]).toMatchObject({
        name: "configured",
        targetType: "connector",
        connectorId: "web-search",
        configurations: [{ name: "WebSearch", parameterValues: { maxResults: 3 } }],
      });
    },
  );
});
