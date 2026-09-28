import { describe, expect, it } from "bun:test";
import {
  HarnessMemoryRefSchema,
  HarnessModelSchema,
  HarnessNameSchema,
  HarnessSkillSchema,
  HarnessSpecSchema,
  HarnessToolSchema,
  HarnessTruncationConfigSchema,
  validateApiFormat,
} from "./harness";

const base = { name: "assistant", model: { bedrockModelConfig: { modelId: "model" } } };
const networkConfiguration = {
  networkMode: "VPC",
  networkModeConfig: {
    subnets: ["subnet-0123456789abcdef0"],
    securityGroups: ["sg-0123456789abcdef0"],
  },
};
const efs = {
  efsAccessPoint: {
    accessPointArn:
      "arn:aws:elasticfilesystem:us-east-1:123456789012:access-point/fsap-0123456789abcdef0",
    mountPath: "/mnt/data",
  },
};
const image = {
  containerConfiguration: { containerUri: "public.ecr.aws/example/harness:latest" },
};
const environment = (runtime: Record<string, unknown>) => ({
  environment: { agentCoreRuntimeEnvironment: runtime },
});

describe("HarnessSpecSchema", () => {
  it("preserves the API shape without inventing optional settings", () => {
    expect(HarnessSpecSchema.parse(base)).toEqual({ ...base, tools: [], skills: [] });
  });

  it.each([
    { model: { provider: "bedrock", modelId: "model" } },
    { memory: { mode: "managed" } },
    { memory: { name: "Memory" } },
    { systemPrompt: "An old string prompt" },
    { networkMode: "PUBLIC" },
    { networkConfig: networkConfiguration.networkModeConfig },
    { containerUri: "public.ecr.aws/example/harness:latest" },
    { lifecycleConfig: { maxLifetime: 900 } },
    { sessionStoragePath: "/mnt/session" },
    { efsAccessPoints: [efs.efsAccessPoint] },
    { s3AccessPoints: [] },
    { authorizerType: "AWS_IAM" },
    { authorizerConfiguration: { customJwtAuthorizer: {} } },
    { unknownSetting: true },
  ])("rejects unsupported flat or unknown fields: %j", (fields) => {
    expect(HarnessSpecSchema.safeParse({ ...base, ...fields }).success).toBe(false);
  });

  it("rejects a flat model combined with the new VPC environment", () => {
    expect(
      HarnessSpecSchema.safeParse({
        ...base,
        model: { provider: "bedrock", modelId: "model" },
        ...environment({ networkConfiguration }),
      }).success,
    ).toBe(false);
  });

  it("preserves every literal prompt block", () => {
    const systemPrompt = [{ text: "  Follow instructions.\n" }, { text: "README.md" }];
    expect(HarnessSpecSchema.parse({ ...base, systemPrompt }).systemPrompt).toEqual(systemPrompt);
  });

  it.each(
    [[], [{ text: "" }], [{ text: " \r\n\t" }], [{ unknown: "text" }]].map((systemPrompt) => ({
      systemPrompt,
    })),
  )("rejects empty or invalid prompt blocks: %j", ({ systemPrompt }) => {
    expect(HarnessSpecSchema.safeParse({ ...base, systemPrompt }).success).toBe(false);
  });

  it("enforces name bounds", () => {
    expect(HarnessNameSchema.safeParse("A".repeat(40)).success).toBe(true);
    for (const name of ["", "A".repeat(41), "1assistant", "has-dash"]) {
      expect(HarnessNameSchema.safeParse(name).success).toBe(false);
    }
  });

  it("rejects duplicate tools", () => {
    expect(
      HarnessSpecSchema.safeParse({
        ...base,
        tools: [
          { type: "agentcore_browser", name: "same" },
          { type: "agentcore_code_interpreter", name: "same" },
        ],
      }).success,
    ).toBe(false);
  });

  it.each([
    { "": "value" },
    { ["A".repeat(101)]: "value" },
    { A: "x".repeat(5001) },
    Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`KEY_${i}`, "value"])),
  ])("enforces environment variable limits: %j", (environmentVariables) => {
    expect(HarnessSpecSchema.safeParse({ ...base, environmentVariables }).success).toBe(false);
  });

  it.each(["maxIterations", "maxTokens", "timeoutSeconds"])("validates %s", (key) => {
    expect(HarnessSpecSchema.safeParse({ ...base, [key]: 1 }).success).toBe(true);
    for (const value of [0, -1, 1.5]) {
      expect(HarnessSpecSchema.safeParse({ ...base, [key]: value }).success).toBe(false);
    }
  });
});

describe("HarnessModelSchema", () => {
  it.each([
    {
      bedrockModelConfig: {
        modelId: "model",
        apiFormat: "converse_stream",
        temperature: 0,
        topP: 0,
        maxTokens: 1,
      },
    },
    { openAiModelConfig: { modelId: "gpt", apiKeyArn: "arn:key", apiFormat: "responses" } },
    { geminiModelConfig: { modelId: "gemini", apiKeyArn: "arn:key", topK: 0 } },
    {
      liteLlmModelConfig: {
        modelId: "model",
        apiBase: "https://proxy.example.com",
        additionalParams: { seed: 0 },
      },
    },
  ])("accepts a provider-specific configuration without transforming it: %j", (model) => {
    expect(HarnessModelSchema.parse(model)).toEqual(model);
  });

  it.each([
    {},
    { bedrockModelConfig: { modelId: "model" }, liteLlmModelConfig: { modelId: "model" } },
    { bedrockModelConfig: { modelId: "model" }, provider: "bedrock" },
    { bedrockModelConfig: { modelId: "" } },
    { bedrockModelConfig: { modelId: "model", topK: 40 } },
    { bedrockModelConfig: { modelId: "model", apiBase: "https://proxy.example.com" } },
    { bedrockModelConfig: { modelId: "model", temperature: 3 } },
    { bedrockModelConfig: { modelId: "model", topP: 2 } },
    { bedrockModelConfig: { modelId: "model", maxTokens: 0 } },
    { openAiModelConfig: { modelId: "gpt" } },
    { openAiModelConfig: { modelId: "gpt", apiKeyArn: "arn:key", apiFormat: "converse_stream" } },
    { geminiModelConfig: { modelId: "gemini" } },
    { geminiModelConfig: { modelId: "gemini", apiKeyArn: "arn:key", topK: 501 } },
    { geminiModelConfig: { modelId: "gemini", apiKeyArn: "arn:key", topK: 1.5 } },
    { geminiModelConfig: { modelId: "gemini", apiKeyArn: "arn:key", apiFormat: "responses" } },
    { openAiModelConfig: { modelId: "gpt", apiKeyArn: "arn:key", additionalParams: {} } },
  ])("rejects invalid or mixed model settings: %j", (model) => {
    expect(HarnessModelSchema.safeParse(model).success).toBe(false);
  });

  it("validates provider-specific CLI API-format choices", () => {
    expect(validateApiFormat("responses", "open_ai")).toEqual({ valid: true });
    expect(validateApiFormat("converse_stream", "bedrock")).toEqual({ valid: true });
    expect(validateApiFormat("converse_stream", "open_ai").valid).toBe(false);
    expect(validateApiFormat("responses", "gemini").valid).toBe(false);
    expect(validateApiFormat("unknown", "bedrock").valid).toBe(false);
  });
});

describe("HarnessMemoryRefSchema", () => {
  it.each([
    { managedMemoryConfiguration: {} },
    {
      managedMemoryConfiguration: { strategies: ["SEMANTIC", "EPISODIC"], eventExpiryDuration: 30 },
    },
    {
      agentCoreMemoryConfiguration: {
        name: "Memory",
        retrievalConfig: { topK: 5, relevanceScore: 0 },
      },
    },
    { agentCoreMemoryConfiguration: { arn: "arn:memory", actorId: "user", messagesCount: 2 } },
    { disabled: {} },
  ])("preserves one memory variant: %j", (memory) => {
    expect<unknown>(HarnessMemoryRefSchema.parse(memory)).toEqual(memory);
  });

  it.each([
    { managedMemoryConfiguration: {}, disabled: {} },
    { managedMemoryConfiguration: { strategies: ["CUSTOM"] } },
    { managedMemoryConfiguration: { strategies: [] } },
    { managedMemoryConfiguration: { eventExpiryDuration: 2 } },
    { managedMemoryConfiguration: { eventExpiryDuration: 366 } },
    { managedMemoryConfiguration: { unknown: true } },
    { agentCoreMemoryConfiguration: {} },
    { agentCoreMemoryConfiguration: { name: "Memory", retrievalConfig: {} } },
    { agentCoreMemoryConfiguration: { name: "Memory", retrievalConfig: { TopK: 5 } } },
    { agentCoreMemoryConfiguration: { name: "Memory", messageCount: 1 } },
    { agentCoreMemoryConfiguration: { arn: "arn:memory", retrievalConfig: { topK: 5 } } },
    {
      agentCoreMemoryConfiguration: {
        name: "Memory",
        arn: "arn:memory",
        retrievalConfig: { topK: 5 },
      },
    },
    { disabled: { name: "Memory" } },
  ])("rejects invalid memory configuration: %j", (memory) => {
    expect(HarnessMemoryRefSchema.safeParse(memory).success).toBe(false);
  });
});

describe("HarnessSkillSchema", () => {
  it.each([
    { path: "/opt/skills" },
    { s3: { uri: "s3://bucket/skills" } },
    { git: { url: "https://github.com/example/skills", path: "skills" } },
    { git: { url: "https://github.com/example/skills", auth: { credentialName: "GitToken" } } },
    {
      git: {
        url: "https://github.com/example/skills",
        auth: { credentialArn: "arn:credential", username: "user" },
      },
    },
    { awsSkills: {} },
    { awsSkills: { paths: ["core-skills/*"] } },
  ])("preserves an API-shaped skill: %j", (skill) => {
    expect<unknown>(HarnessSkillSchema.parse(skill)).toEqual(skill);
  });

  it.each([
    "/opt/skills",
    { s3Uri: "s3://bucket/skills" },
    { gitUrl: "https://github.com/example/skills" },
    { s3: { uri: "https://bucket/skills" } },
    { git: { url: "http://github.com/example/skills" } },
    { git: { url: "https://github.com/example/skills", auth: {} } },
    {
      git: {
        url: "https://github.com/example/skills",
        auth: { credentialName: "token", credentialArn: "arn:token" },
      },
    },
    { awsSkills: { paths: [""] } },
    { path: "/opt/skills", s3: { uri: "s3://bucket/skills" } },
  ])("rejects invalid or flat skill sources: %j", (skill) => {
    expect(HarnessSkillSchema.safeParse(skill).success).toBe(false);
  });
});

describe("Harness tool and truncation variants", () => {
  it("binds the tool type to its configuration", () => {
    expect(
      HarnessToolSchema.safeParse({
        type: "remote_mcp",
        name: "research",
        config: { remoteMcp: { url: "https://example.com/mcp" } },
      }).success,
    ).toBe(true);
    for (const config of [
      undefined,
      { agentCoreBrowser: {} },
      { remoteMcp: { url: "https://example.com" }, agentCoreBrowser: {} },
    ]) {
      expect(
        HarnessToolSchema.safeParse({ type: "remote_mcp", name: "research", config }).success,
      ).toBe(false);
    }
  });

  it("supports Gateway authentication", () => {
    for (const outboundAuth of [
      { awsIam: {} },
      { none: {} },
      { oauth: { providerArn: "arn:provider", scopes: ["read"], grantType: "USER_FEDERATION" } },
    ]) {
      expect(
        HarnessToolSchema.safeParse({
          type: "agentcore_gateway",
          name: "gateway",
          config: { agentCoreGateway: { gatewayArn: "arn:gateway", outboundAuth } },
        }).success,
      ).toBe(true);
    }
  });

  it("binds truncation options to the chosen strategy", () => {
    expect(HarnessTruncationConfigSchema.parse({ strategy: "none" })).toEqual({ strategy: "none" });
    for (const truncation of [
      { strategy: "sliding_window", config: { summarization: { summaryRatio: 0.5 } } },
      { strategy: "none", config: { slidingWindow: { messagesCount: 5 } } },
      { strategy: "summarization", config: { slidingWindow: {}, summarization: {} } },
    ]) {
      expect(HarnessTruncationConfigSchema.safeParse(truncation).success).toBe(false);
    }
  });
});

describe("Harness runtime environment", () => {
  it("preserves runtime and project-only build settings separately", () => {
    const input = {
      ...base,
      dockerfile: "Dockerfile",
      networkConfig: { vpcId: "vpc-0123456789abcdef0" },
      ...environment({
        networkConfiguration,
        lifecycleConfiguration: { idleRuntimeSessionTimeout: 300, maxLifetime: 3600 },
        filesystemConfigurations: [{ sessionStorage: { mountPath: "/mnt/session" } }, efs],
      }),
    };
    expect(HarnessSpecSchema.parse(input)).toEqual({ ...input, tools: [], skills: [] });
  });

  it("requires network settings in VPC mode and rejects settings in PUBLIC mode", () => {
    for (const network of [
      { networkMode: "VPC" },
      { networkMode: "PUBLIC", networkModeConfig: networkConfiguration.networkModeConfig },
    ]) {
      expect(
        HarnessSpecSchema.safeParse({ ...base, ...environment({ networkConfiguration: network }) })
          .success,
      ).toBe(false);
    }
  });

  it("rejects unknown runtime fields instead of silently discarding them", () => {
    expect(
      HarnessSpecSchema.safeParse({
        ...base,
        ...environment({ lifecycleConfiguration: { maxLifeTime: 300 } }),
      }).success,
    ).toBe(false);
  });

  it("requires the build VPC ID only for Dockerfile builds", () => {
    const input = { ...base, ...environment({ networkConfiguration }) };
    expect(HarnessSpecSchema.safeParse({ ...input, dockerfile: "Dockerfile" }).success).toBe(false);
    expect(HarnessSpecSchema.safeParse({ ...input, environmentArtifact: image }).success).toBe(
      true,
    );
    expect(
      HarnessSpecSchema.safeParse({ ...base, networkConfig: { vpcId: "vpc-0123456789abcdef0" } })
        .success,
    ).toBe(false);
  });

  it("applies the CodeBuild security-group cap only to Dockerfile builds", () => {
    const securityGroups = Array.from({ length: 6 }, (_, i) => `sg-${String(i).padStart(17, "0")}`);
    const input = {
      ...base,
      networkConfig: { vpcId: "vpc-0123456789abcdef0" },
      ...environment({
        networkConfiguration: {
          ...networkConfiguration,
          networkModeConfig: { ...networkConfiguration.networkModeConfig, securityGroups },
        },
      }),
    };
    expect(HarnessSpecSchema.safeParse({ ...input, dockerfile: "Dockerfile" }).success).toBe(false);
    expect(HarnessSpecSchema.safeParse({ ...input, environmentArtifact: image }).success).toBe(
      true,
    );
  });

  it("validates image sources", () => {
    expect(HarnessSpecSchema.safeParse({ ...base, environmentArtifact: image }).success).toBe(true);
    expect(
      HarnessSpecSchema.safeParse({ ...base, environmentArtifact: image, dockerfile: "Dockerfile" })
        .success,
    ).toBe(false);
    expect(
      HarnessSpecSchema.safeParse({
        ...base,
        environmentArtifact: {
          containerConfiguration: { containerUri: "docker.io/example/image" },
        },
      }).success,
    ).toBe(false);
  });

  it("requires VPC mode for external filesystem mounts", () => {
    expect(
      HarnessSpecSchema.safeParse({ ...base, ...environment({ filesystemConfigurations: [efs] }) })
        .success,
    ).toBe(false);
  });

  it.each(
    [
      [{ sessionStorage: { mountPath: "/mnt/a" } }, { sessionStorage: { mountPath: "/mnt/b" } }],
      [efs, { sessionStorage: { mountPath: "/mnt/data/" } }],
      [
        efs,
        { efsAccessPoint: { ...efs.efsAccessPoint, mountPath: "/mnt/b" } },
        { efsAccessPoint: { ...efs.efsAccessPoint, mountPath: "/mnt/c" } },
      ],
      [{ sessionStorage: { mountPath: "/mnt/a/b" } }],
      [{ sessionStorage: { mountPath: "/mnt" } }],
      [{ capacityProviderVolume: { volumeName: "data", mountPath: "/mnt/data" } }],
    ].map((filesystemConfigurations) => ({ filesystemConfigurations })),
  )(
    "validates filesystem mount variants, counts, and unique paths: %j",
    ({ filesystemConfigurations }) => {
      expect(
        HarnessSpecSchema.safeParse({
          ...base,
          ...environment({ networkConfiguration, filesystemConfigurations }),
        }).success,
      ).toBe(false);
    },
  );

  it("validates JWT configuration without a separate authorizer type", () => {
    const authorizerConfiguration = {
      customJWTAuthorizer: {
        discoveryUrl: "https://example.com/.well-known/openid-configuration",
        allowedAudience: ["assistant"],
      },
    };
    expect(
      HarnessSpecSchema.parse({ ...base, authorizerConfiguration }).authorizerConfiguration,
    ).toEqual(authorizerConfiguration);
    expect(HarnessSpecSchema.safeParse({ ...base, authorizerConfiguration: {} }).success).toBe(
      false,
    );
  });
});
