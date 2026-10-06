import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import z from "zod";
import { parse, stringify } from "yaml";
import { FsProjectManager } from "./manager";
import { FsReadWriteJson, type ReadWriteJson } from "../../io";
import { createSilentLogger, TestIdentityClient } from "../../testing";
import { resolveRuntimeTemplateShortcut } from "../../handlers/project/shortcuts";
import type { ExportHarnessInput, Project, ProjectEvent } from "../../handlers/project/types";
import { HarnessSpecSchema } from "../../projectSchemas/harness";

const originalCwd = process.cwd();
const tempDirectories: string[] = [];

async function inTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentcore-export-manager-"));
  tempDirectories.push(directory);
  process.chdir(directory);
  return process.cwd();
}

afterEach(async () => {
  process.chdir(originalCwd);
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function manager(options: { json?: ReadWriteJson } = {}) {
  const commands: { command: string[]; cwd: string }[] = [];
  return {
    manager: new FsProjectManager({
      logger: createSilentLogger(),
      identity: new TestIdentityClient(),
      enableTransactionSearch: async () => {},
      json: options.json,
      runner: async (command, { cwd }) => {
        commands.push({ command, cwd });
      },
      checkTool: async () => {},
    }),
    commands,
  };
}

async function drain<T>(generator: AsyncGenerator<ProjectEvent, T>): Promise<T> {
  let next = await generator.next();
  while (!next.done) next = await generator.next();
  return next.value;
}

/** Creates a project with a harness built from `harness` overrides; returns the refreshed project. */
async function projectWithHarness(
  subject: FsProjectManager,
  harness: Record<string, unknown> = {},
): Promise<Project> {
  await inTempDirectory();
  let project = await drain(
    subject.create({
      name: "orders",
      skipInstall: true,
      skipGit: true,
      scaffoldRuntimeInput: resolveRuntimeTemplateShortcut("agent-python-minimal"),
    }),
  );
  project = await drain(
    subject.addResource(project, {
      resourceType: "harness",
      resourceConfig: {
        name: "assistant",
        model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
        systemPrompt: "You are a terse assistant.",
        memory: { mode: "disabled" },
        ...harness,
      } as z.input<typeof HarnessSpecSchema>,
    }),
  );
  return project;
}

function exportInput(overrides: Partial<ExportHarnessInput> = {}): ExportHarnessInput {
  return { harnessName: "assistant", targetAgentName: "assistantAgent", ...overrides };
}

describe("FsProjectManager.exportHarness rendered tree", () => {
  test.each(["awsIam", "none"] as const)(
    "renders preserved memory, %s gateway and captured policies through existing writers",
    async (auth) => {
      const { manager: subject } = manager();
      const project = await projectWithHarness(subject);
      const document = {
        Version: "2012-10-17",
        Statement: [{ Effect: "Deny", Action: "s3:*", Resource: "*" }],
      };
      const spec = HarnessSpecSchema.parse({
        name: "remote",
        model: {
          provider: "open_ai",
          modelId: "gpt-5",
          apiKeyArn:
            "arn:aws:bedrock-agentcore:us-west-2:111122223333:token-vault/default/apikeycredentialprovider/Original",
        },
        memory: {
          mode: "existing",
          arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/Original",
        },
        tools: [
          {
            name: "gateway",
            type: "agentcore_gateway",
            config: {
              agentCoreGateway: {
                gatewayArn: "arn:aws:bedrock-agentcore:eu-west-1:111122223333:gateway/Original",
                outboundAuth: { [auth]: {} },
              },
            },
          },
        ],
      });
      const result = await drain(
        subject.exportHarness(
          project,
          exportInput({
            prefetched: {
              spec,
              sourceArn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:harness/source",
              modelApiBase: "https://models.example/v1",
              memoryRetrievalConfig: {
                "/actual/{actorId}/{sessionId}/": { topK: 9, relevanceScore: 0.2 },
              },
              executionRoleSource: {
                roleArn: "arn:aws:iam::111122223333:role/Source",
                inlinePolicies: [{ name: "Limits", document }],
                managedPolicyArns: [],
                tags: {},
              },
            },
          }),
        ),
      );
      expect(await Bun.file(join(result.agentPath, "source-role-Limits.json")).json()).toEqual(
        document,
      );
      const generated = await Bun.file(
        join(project.rootPath, "agentcore", "agentcore.json"),
      ).json();
      expect(
        generated.runtimes.find((runtime: { name: string }) => runtime.name === result.agentName)
          .executionRoleConfig,
      ).toEqual({ policyMode: "explicit", tags: {} });
      expect(generated.credentials).toEqual([]);
      const main = await Bun.file(join(result.agentPath, "main.py")).text();
      expect(main).toContain("context.request_headers");
      expect(main).toContain("context.request.headers");
      expect(main).toContain('headers.get("x-amzn-bedrock-agentcore-runtime-user-id")');
      expect(main).not.toContain("default-user");
      expect(main).not.toContain("getattr(context, 'user_id'");
      const session = await Bun.file(join(result.agentPath, "memory", "session.py")).text();
      expect(session).toContain(
        '"/actual/{actorId}/{sessionId}/": RetrievalConfig(top_k=9, relevance_score=0.2)',
      );
      expect(session).not.toContain("/users/");
      expect(session).toContain('REGION = "us-west-2"');
      const mcp = await Bun.file(join(result.agentPath, "mcp_client", "client.py")).text();
      if (auth === "awsIam") {
        expect(mcp).toContain(
          'aws_iam_streamablehttp_client(endpoint=url, aws_service="bedrock-agentcore", aws_region="eu-west-1")',
        );
      } else {
        expect(mcp).toContain("streamablehttp_client(url)");
        expect(mcp).not.toContain("aws_iam_streamablehttp_client");
      }
      expect(mcp).toContain("AGENTCORE_GATEWAY_GATEWAY_ORIGINAL_URL");
      expect(
        (await Bun.file(join(result.agentPath, "pyproject.toml")).text()).includes(
          "mcp-proxy-for-aws",
        ),
      ).toBe(auth === "awsIam");
      expect(await Bun.file(join(result.agentPath, "model", "load.py")).text()).toContain(
        '"base_url": "https://models.example/v1"',
      );
    },
  );
  test("an exported harness permits the framework version selected by the SDK integration", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput()));

    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"strands-agents >= 1.54.0, < 2.0.0"');
  });

  test("loads only the MCP tools allowedTools selects", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      allowedTools: ["@exa/web_*"],
      tools: [
        {
          type: "remote_mcp",
          name: "exa",
          config: { remoteMcp: { url: "https://mcp.exa.ai/mcp" } },
        },
      ],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const client = await Bun.file(join(result.agentPath, "mcp_client", "client.py")).text();
    expect(client).toContain('tool_filters=_allowed_tools("exa", "web_*")');
  });

  test("merges service model parameters under the explicit settings", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);
    const spec = HarnessSpecSchema.parse({
      name: "remote",
      model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", temperature: 0.2 },
    });

    const result = await drain(
      subject.exportHarness(project, {
        prefetched: { spec, modelAdditionalParams: { top_k: 5 } },
        targetAgentName: "remoteAgent",
      }),
    );

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain("additional_args=json.loads(");
    expect(loadModel).toContain("top_k");
  });

  test("renders invocation-scoped native Strands limits without a custom hook", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      maxIterations: 3,
      maxTokens: 128,
      timeoutSeconds: 5,
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "hooks"))).toBe(false);
    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain('"turns": 3');
    expect(main).toContain('"output_tokens": 128');
    expect(main).toContain("cancel_signal = threading.Event()");
    expect(main).toContain("limits=limits");
    expect(main).not.toContain("ExecutionLimitsHook");
    expect(main).not.toContain("agent.cancel()");
  });

  test("leaves hooks/ and memory/ out of a plain export", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "hooks"))).toBe(false);
    expect(existsSync(join(result.agentPath, "memory"))).toBe(false);
    expect(existsSync(join(result.agentPath, "Dockerfile"))).toBe(false);
  });

  test("wires an in-project memory through memory/session.py", async () => {
    const { manager: subject } = manager();
    let project = await projectWithHarness(subject, {
      memory: { mode: "existing", name: "chat_history" },
    });
    project = await drain(
      subject.addResource(project, {
        resourceType: "memory",
        resourceConfig: {
          name: "chat_history",
          eventExpiryDuration: 30,
          strategies: [{ type: "SEMANTIC" }],
        },
      }),
    );

    const result = await drain(subject.exportHarness(project, exportInput()));

    const session = await Bun.file(join(result.agentPath, "memory", "session.py")).text();
    expect(session).toContain('MEMORY_ID = os.getenv("AGENTCORE_MEMORY_CHAT_HISTORY_ID")');
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain(
      "from memory.session import get_memory_session_manager",
    );
    expect(result.notes).toMatchObject([{ category: "Deployed IAM not captured" }]);
  });

  test.each([undefined, "configured-actor"])(
    "resolves memory actors through rendered Python with SDK-filtered headers: %p",
    async (actorId) => {
      const { manager: subject } = manager();
      const project = await projectWithHarness(subject, {
        memory: {
          mode: "existing",
          arn: "arn:aws:bedrock-agentcore:us-west-2:111122223333:memory/Original",
          actorId,
        },
      });
      const result = await drain(subject.exportHarness(project, exportInput()));
      const script = `
from __future__ import annotations

import ast
import asyncio
import json
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

bindings = []

def memory_session(session_id, actor_id):
    bindings.append([session_id, actor_id])
    return SimpleNamespace(session_id=session_id, actor_id=actor_id)

class Agent:
    def __init__(self, **kwargs):
        self.session_manager = kwargs["session_manager"]

    async def stream_async(self, prompt, **kwargs):
        yield {"event": {"contentBlockDelta": {"delta": {"text": prompt}}}}

namespace = {
    "Any": Any,
    "Agent": Agent,
    "asyncio": asyncio,
    "log": SimpleNamespace(info=lambda *args: None),
    "get_memory_session_manager": memory_session,
    "load_model": lambda: None,
    "_make_conversation_manager": lambda: None,
    "DEFAULT_SYSTEM_PROMPT": "",
    "tools": [],
}
tree = ast.parse(Path(sys.argv[1]).read_text())
functions = [
    node for node in tree.body
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    and node.name in {"agent_factory", "invoke", "_extract_prompt", "strip_trailing_tool_use"}
]
for function in functions:
    function.decorator_list = []
exec(compile(ast.Module(body=functions, type_ignores=[]), sys.argv[1], "exec"), namespace)
namespace["get_or_create_agent"] = namespace["agent_factory"]()

def context(session_id, actor_id):
    headers = {"X-Amzn-Bedrock-AgentCore-Runtime-Custom-Trace": "trace"}
    if actor_id is not None:
        headers["X-Amzn-Bedrock-AgentCore-Runtime-User-Id"] = actor_id
    # SDK 1.24.0 excludes reserved x-amzn-* headers, retaining Runtime-Custom-*.
    forwarded = {
        key: value for key, value in headers.items()
        if not key.lower().startswith("x-amzn-")
        or key.lower().startswith("x-amzn-bedrock-agentcore-runtime-custom-")
    }
    assert "X-Amzn-Bedrock-AgentCore-Runtime-User-Id" not in forwarded
    return SimpleNamespace(
        session_id=session_id, request_headers=forwarded,
        request=SimpleNamespace(headers=headers),
    )

async def invoke(request_context):
    events = [event async for event in namespace["invoke"]({"prompt": "hello"}, request_context)]
    assert events == [{"event": {"contentBlockDelta": {"delta": {"text": "hello"}}}}]

async def check():
    await invoke(context("session-a", "actor-a"))
    await invoke(context("session-a", "actor-b"))
    await invoke(context("session-b", "actor-a"))
    await invoke(context("session-a", "actor-a"))
    await invoke(SimpleNamespace(
        session_id="legacy",
        request=None,
        request_headers={"X-Amzn-Bedrock-AgentCore-Runtime-User-Id": "legacy-actor"},
    ))
    for missing, message in [
        (context(None, "actor-a"), "Memory requires a Runtime session ID"),
        (context("missing-user", None), "Memory requires a configured actorId or Runtime user-id header"),
    ]:
        if missing.session_id and sys.argv[2] != "null":
            await invoke(missing)
            continue
        before = len(bindings)
        try:
            await invoke(missing)
        except ValueError as error:
            assert str(error) == message
        else:
            raise AssertionError("missing memory identity was accepted")
        assert len(bindings) == before

asyncio.run(check())
print(json.dumps(bindings))
`;
      const executed = spawnSync(
        process.platform === "win32" ? "python" : "python3",
        ["-c", script, join(result.agentPath, "main.py"), JSON.stringify(actorId ?? null)],
        { encoding: "utf8" },
      );

      expect(executed.error).toBeUndefined();
      expect({ status: executed.status, stderr: executed.stderr }).toEqual({
        status: 0,
        stderr: "",
      });
      expect(JSON.parse(executed.stdout)).toEqual(
        actorId
          ? [
              ["session-a", actorId],
              ["session-b", actorId],
              ["legacy", actorId],
              ["missing-user", actorId],
            ]
          : [
              ["session-a", "actor-a"],
              ["session-a", "actor-b"],
              ["session-b", "actor-a"],
              ["legacy", "legacy-actor"],
            ],
      );
    },
  );

  test("renders memory retrieval tuning and notes messagesCount", async () => {
    const { manager: subject } = manager();
    let project = await projectWithHarness(subject, {
      memory: {
        mode: "existing",
        name: "chat_history",
        messagesCount: 12,
        retrievalConfig: { topK: 8, relevanceScore: 0.7 },
      },
    });
    project = await drain(
      subject.addResource(project, {
        resourceType: "memory",
        resourceConfig: {
          name: "chat_history",
          eventExpiryDuration: 30,
          strategies: [{ type: "SEMANTIC" }],
        },
      }),
    );

    const result = await drain(subject.exportHarness(project, exportInput()));

    const session = await Bun.file(join(result.agentPath, "memory", "session.py")).text();
    expect(session).toContain("RetrievalConfig(top_k=8, relevance_score=0.7)");
    expect(result.notes.map((note) => note.category)).toContain(
      "Memory messagesCount is not directly portable to Strands",
    );
  });

  test("renders OpenAI Responses settings with compatible Strands extras", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: {
        provider: "open_ai",
        modelId: "gpt-4.1",
        apiKeyArn:
          "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/OpenAiKey",
        apiFormat: "responses",
        maxTokens: 512,
        temperature: 0.2,
        topP: 0.8,
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain("from strands.models.openai_responses import OpenAIResponsesModel");
    expect(loadModel).toContain('IDENTITY_PROVIDER_NAME = "OpenAiKey"');
    expect(loadModel).toContain('params["max_output_tokens"] = 512');
    expect(loadModel).toContain('params["temperature"] = 0.2');
    expect(loadModel).toContain('params["top_p"] = 0.8');
    const pyproject = await Bun.file(join(result.agentPath, "pyproject.toml")).text();
    expect(pyproject).toContain('"strands-agents[openai] >= 1.54.0, < 2.0.0"');
    expect(pyproject).not.toContain('"openai ~= 1.0.0"');
  });

  test("renders Gemini sampling settings with the Gemini extra", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: {
        provider: "gemini",
        modelId: "gemini-2.5-flash",
        apiKeyArn:
          "arn:aws:bedrock-agentcore:us-east-1:111122223333:token-vault/default/apikeycredentialprovider/GeminiKey",
        maxTokens: 400,
        temperature: 0.3,
        topP: 0.9,
        topK: 20,
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain('params["max_output_tokens"] = 400');
    expect(loadModel).toContain('params["temperature"] = 0.3');
    expect(loadModel).toContain('params["top_p"] = 0.9');
    expect(loadModel).toContain('params["top_k"] = 20');
    expect(await Bun.file(join(result.agentPath, "pyproject.toml")).text()).toContain(
      '"strands-agents[gemini] >= 1.54.0, < 2.0.0"',
    );
  });

  test("renders LiteLLM settings with the LiteLLM extra", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: {
        provider: "lite_llm",
        modelId: "bedrock/us.amazon.nova-lite-v1:0",
        maxTokens: 300,
        temperature: 0.1,
        topP: 0.7,
        additionalParams: { max_retries: 2 },
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const loadModel = await Bun.file(join(result.agentPath, "model", "load.py")).text();
    expect(loadModel).toContain('params["max_tokens"] = 300');
    expect(loadModel).toContain('params["temperature"] = 0.1');
    expect(loadModel).toContain('params["top_p"] = 0.7');
    expect(loadModel).toContain('json.loads("{\\"max_retries\\":2}")');
    expect(await Bun.file(join(result.agentPath, "pyproject.toml")).text()).toContain(
      '"strands-agents[litellm] >= 1.54.0, < 2.0.0"',
    );
  });

  test("renders released skills and sliding-window APIs", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      skills: [{ s3Uri: "s3://skills-bucket/team/" }],
      truncation: {
        strategy: "sliding_window",
        config: { slidingWindow: { messagesCount: 12 } },
      },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const main = await Bun.file(join(result.agentPath, "main.py")).text();
    expect(main).toContain("from strands import AgentSkills");
    expect(main).toContain('SlidingWindowConversationManager(**{"window_size":12}, per_turn=True)');
    expect(await Bun.file(join(result.agentPath, "pyproject.toml")).text()).toContain(
      '"strands-agents >= 1.54.0, < 2.0.0"',
    );
  });

  test("emits a CodeZip runtime with no container files", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "Dockerfile"))).toBe(false);
    expect(existsSync(join(result.agentPath, ".dockerignore"))).toBe(false);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.build).toBe("CodeZip");
    expect(runtime.runtimeVersion).toBe("PYTHON_3_14");
    expect(runtime.dockerfile).toBeUndefined();
  });

  test("exports a containerUri harness as CodeZip and reports the dropped image", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      containerUri: "111122223333.dkr.ecr.us-east-1.amazonaws.com/base-image:latest",
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(existsSync(join(result.agentPath, "Dockerfile"))).toBe(false);
    expect(result.notes.map((note) => note.category)).toEqual([
      "Container image not carried over",
      "Deployed IAM not captured",
    ]);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.build).toBe("CodeZip");
  });

  test("writes generated IAM policy files next to the code", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      skills: [{ s3Uri: "s3://skills-bucket/team" }],
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    const policy = await Bun.file(join(result.agentPath, "s3-skills-policy.json")).json();
    expect(policy.Statement[0].Resource).toEqual(["arn:aws:s3:::skills-bucket/team/*"]);
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const runtime = spec.runtimes.find((r: { name: string }) => r.name === "assistantAgent");
    expect(runtime.additionalPolicies).toEqual(["s3-skills-policy.json"]);
  });
});

describe("FsProjectManager.exportHarness side effects", () => {
  test.each(["inline", "file"] as const)(
    "exports the %s prompt and inline summary without rewriting YAML",
    async (source) => {
      const { manager: subject } = manager();
      const project = await projectWithHarness(subject);
      const dir = join(project.rootPath, "app", "assistant");
      const configPath = join(dir, "harness.yaml");
      const config = parse(await Bun.file(configPath).text());
      const prompt = "  Explicit prompt.\nKeep its whitespace.\n";
      await Bun.write(
        join(dir, "system-prompt.md"),
        source === "file" ? prompt : "Conventional prompt loses.",
      );
      if (source === "file") delete config.systemPrompt;
      else config.systemPrompt = [{ text: prompt }];
      config.truncation = {
        strategy: "summarization",
        config: { summarization: { summarizationSystemPrompt: "  Keep the decisions.\n" } },
      };
      const yaml = "# Keep this customer comment.\n" + stringify(config);
      await Bun.write(configPath, yaml);
      const result = await drain(subject.exportHarness(project, exportInput()));
      const main = await Bun.file(join(result.agentPath, "main.py")).text();
      expect(main).toContain(prompt);
      expect(main).toContain("Keep the decisions.");
      expect(main).not.toContain("Conventional prompt loses.");
      expect(await Bun.file(configPath).text()).toBe(yaml);
    },
  );

  test("reports schema errors with the YAML path before creating export output", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);
    const configPath = join(project.rootPath, "app", "assistant", "harness.yaml");
    await Bun.write(
      configPath,
      "name: assistant\nmodel: {bedrockModelConfig: {modelId: example}}\nmaxIterations: 0\n",
    );
    await expect(drain(subject.exportHarness(project, exportInput()))).rejects.toThrow(
      /Invalid harness.yaml.*maxIterations/s,
    );
    expect(existsSync(join(project.rootPath, "app", "assistantAgent"))).toBe(false);
  });

  test("writes MCP header secrets to .env.local and registers their credentials", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "remote_mcp",
          name: "internal",
          config: {
            remoteMcp: { url: "https://mcp.internal.example", headers: { "X-Api-Key": "s3cret" } },
          },
        },
      ],
    });

    await drain(subject.exportHarness(project, exportInput()));

    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    const credential = spec.credentials[0];
    expect(credential.authorizerType).toBe("ApiKeyCredentialProvider");
    expect(credential.name).toMatch(/^ordersMcpinternalX-Api-Key-[a-f0-9]{10}$/);
    const envLocal = await Bun.file(join(project.rootPath, "agentcore", ".env.local")).text();
    expect(envLocal).toContain(
      `AGENTCORE_CREDENTIAL_${credential.name.replace(/-/g, "_").toUpperCase()}='s3cret'`,
    );
    const mcpClient = await Bun.file(
      join(project.rootPath, "app", "assistantAgent", "mcp_client", "client.py"),
    ).text();
    expect(mcpClient).toMatch(
      /def transport\(\):[\s\S]*headers = \{ "X-Api-Key": _get_[a-z0-9_]+_key\(\) \}[\s\S]*return streamablehttp_client/,
    );
  });

  test("exports a prefetched (service) harness without touching harness files", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject);

    const result = await drain(
      subject.exportHarness(project, {
        prefetched: {
          spec: HarnessSpecSchema.parse({
            name: "remote_harness",
            model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0" },
          }),
          systemPrompt: "Fetched prompt.",
        },
        targetAgentName: "exported_arn",
      }),
    );

    expect(result.harnessName).toBe("remote_harness");
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain("Fetched prompt.");
  });

  test("cleans up the agent dir and .env.local when the spec write fails", async () => {
    const failing = failingWriteJson();
    const { manager: subject } = manager({ json: failing.json });
    const project = await projectWithHarness(subject, {
      tools: [
        {
          type: "remote_mcp",
          name: "internal",
          config: {
            remoteMcp: { url: "https://mcp.internal.example", headers: { "X-Api-Key": "s3cret" } },
          },
        },
      ],
    });

    failing.failNextWrite();
    await expect(drain(subject.exportHarness(project, exportInput()))).rejects.toThrow("disk full");

    expect(existsSync(join(project.rootPath, "app", "assistantAgent"))).toBe(false);
    // The scaffolded .env.local survives, but the staged secret is rolled back.
    expect(await Bun.file(join(project.rootPath, "agentcore", ".env.local")).text()).not.toContain(
      "AGENTCORE_CREDENTIAL_ORDERSMCPINTERNALXAPIKEY",
    );
    const spec = await Bun.file(join(project.rootPath, "agentcore", "agentcore.json")).json();
    expect(spec.runtimes.map((r: { name: string }) => r.name)).not.toContain("assistantAgent");
  });

  test("reads the harness from its registry path", async () => {
    const { manager: subject } = manager();
    const project = await projectWithHarness(subject, {
      model: { provider: "bedrock", modelId: "us.amazon.nova-lite-v1:0", maxTokens: 128 },
    });

    const result = await drain(subject.exportHarness(project, exportInput()));

    expect(await Bun.file(join(result.agentPath, "model", "load.py")).text()).toContain(
      "max_tokens=128",
    );
    // The system prompt comes from system-prompt.md, the file add-harness wrote.
    expect(await Bun.file(join(result.agentPath, "main.py")).text()).toContain(
      'DEFAULT_SYSTEM_PROMPT = """You are a terse assistant."""',
    );
  });
});

/** A ReadWriteJson that can be told to fail its next write, delegating otherwise. */
function failingWriteJson() {
  const real = new FsReadWriteJson({ logger: createSilentLogger() });
  let shouldFail = false;
  const json: ReadWriteJson = {
    read: (path, schema) => real.read(path, schema),
    write: (path, data) => {
      if (shouldFail) {
        shouldFail = false;
        throw new Error("disk full");
      }
      return real.write(path, data);
    },
  };
  return { json, failNextWrite: () => (shouldFail = true) };
}
