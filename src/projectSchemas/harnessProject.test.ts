import { expect, test } from "bun:test";
import { HarnessSpecSchema } from "./harness";
import { parseHarnessProjectSpec, toApiShapedHarnessSpec } from "./harnessProject";

test("maps an API-shaped default without adding absent settings", () => {
  const spec = HarnessSpecSchema.parse({
    name: "assistant",
    model: { provider: "bedrock", modelId: "global.anthropic.claude-sonnet-4-6" },
    memory: { mode: "managed" },
    tools: [],
    skills: [],
    allowedTools: ["*"],
    truncation: { strategy: "sliding_window" },
    environmentVariables: {},
    tags: {},
  });
  const api = toApiShapedHarnessSpec(spec);
  expect(api.model).toEqual({
    bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-4-6" },
  });
  expect(api.memory).toEqual({ managedMemoryConfiguration: {} });
  expect(api.environment).toBeUndefined();
  expect(parseHarnessProjectSpec(api)).toEqual({
    ...spec,
    networkMode: "PUBLIC",
    authorizerType: "AWS_IAM",
  });
});

test("maps supplied provider, prompt, VPC, mounts, IAM, tools and skills without loss", () => {
  const spec = HarnessSpecSchema.parse({
    name: "assistant",
    model: {
      provider: "lite_llm",
      modelId: "model",
      apiBase: "https://example.com",
      temperature: 0,
      maxTokens: 27,
      additionalParams: { message: "a: b\nc", count: 0 },
    },
    systemPrompt: "Exact prompt.\n",
    memory: {
      mode: "existing",
      name: "ConversationMemory",
      retrievalConfig: { relevanceScore: 0 },
    },
    tools: [
      {
        name: "research",
        type: "remote_mcp",
        config: { remoteMcp: { url: "https://example.com/mcp" } },
      },
    ],
    allowedTools: ["@research/search"],
    skills: [
      { s3Uri: "s3://bucket/skills/" },
      { gitUrl: "https://github.com/example/skills.git" },
      { awsSkills: { paths: ["core-skills/aws-serverless"] } },
    ],
    truncation: { strategy: "none" },
    networkMode: "VPC",
    networkConfig: {
      vpcId: "vpc-0123456789abcdef0",
      subnets: ["subnet-0123456789abcdef0"],
      securityGroups: ["sg-0123456789abcdef0"],
    },
    dockerfile: "Dockerfile",
    lifecycleConfig: { idleRuntimeSessionTimeout: 900, maxLifetime: 3600 },
    sessionStoragePath: "/mnt/session",
    efsAccessPoints: [
      {
        accessPointArn:
          "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
        mountPath: "/mnt/data",
      },
    ],
    authorizerType: "CUSTOM_JWT",
    authorizerConfiguration: {
      customJwtAuthorizer: {
        discoveryUrl: "https://id.example.com/.well-known/openid-configuration",
        allowedAudience: ["assistant"],
      },
    },
    executionRoleArn: "arn:aws:iam::123456789012:role/MyHarnessRole",
    environmentVariables: { DEBUG: "false" },
    tags: { team: "support" },
  });
  const api = toApiShapedHarnessSpec(spec);
  expect(api.model).toEqual({
    liteLlmModelConfig: {
      modelId: "model",
      apiBase: "https://example.com",
      temperature: 0,
      maxTokens: 27,
      additionalParams: { message: "a: b\nc", count: 0 },
    },
  });
  expect(api.environment?.agentCoreRuntimeEnvironment.networkConfiguration).toEqual({
    networkMode: "VPC",
    networkModeConfig: {
      subnets: ["subnet-0123456789abcdef0"],
      securityGroups: ["sg-0123456789abcdef0"],
    },
  });
  expect(api.networkConfig).toEqual({ vpcId: "vpc-0123456789abcdef0" });
  expect(parseHarnessProjectSpec(api)).toEqual(spec);
});

test.each(["bedrock", "open_ai", "gemini", "lite_llm"] as const)(
  "round-trips a %s model",
  (provider) => {
    const spec = HarnessSpecSchema.parse({
      name: "assistant",
      model: {
        provider,
        modelId: "example",
        ...(["open_ai", "gemini"].includes(provider) ? { apiKeyArn: "arn:example" } : {}),
        ...(provider === "gemini" ? { topK: 0 } : {}),
      },
      memory: { mode: "disabled" },
    });
    expect(parseHarnessProjectSpec(toApiShapedHarnessSpec(spec))).toEqual({
      ...spec,
      networkMode: "PUBLIC",
      authorizerType: "AWS_IAM",
    });
  },
);

test("continues reading legacy flat configs", () => {
  const legacy = { name: "assistant", model: { provider: "bedrock", modelId: "example" } };
  expect(parseHarnessProjectSpec(legacy)).toEqual(HarnessSpecSchema.parse(legacy));
});

test.each([
  { model: { bedrockModelConfig: { modelID: "wrong" } } },
  {
    model: { bedrockModelConfig: { modelId: "example" }, geminiModelConfig: { modelId: "other" } },
  },
  { model: { provider: "bedrock", bedrockModelConfig: { modelId: "example" } } },
  { model: { bedrockModelConfig: { modelId: "example" } }, unknownField: true },
  {
    model: { bedrockModelConfig: { modelId: "example" } },
    systemPrompt: [{ text: "One" }, { text: "Two" }],
  },
  {
    model: { bedrockModelConfig: { modelId: "example" } },
    environment: {
      agentCoreRuntimeEnvironment: {
        networkConfiguration: {
          networkMode: "PUBLIC",
          networkModeConfig: {
            subnets: ["subnet-0123456789abcdef0"],
            securityGroups: ["sg-0123456789abcdef0"],
          },
        },
      },
    },
  },
])("rejects invalid API-shaped fields without dropping them: %j", (input) => {
  expect(() => parseHarnessProjectSpec({ name: "assistant", ...input })).toThrow();
});
