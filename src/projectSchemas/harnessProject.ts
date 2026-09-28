import { z } from "zod";
import {
  EfsAccessPointConfigSchema,
  LifecycleConfigurationSchema,
  NetworkConfigSchema,
  S3FilesAccessPointConfigSchema,
  SessionStorageSchema,
} from "./runtime";
import { CustomJwtAuthorizerConfigSchema } from "./auth";
import { ConnectionSchema } from "./connections";
import {
  AllowedToolSchema,
  HarnessMemoryRetrievalConfigSchema,
  HarnessModelSchema,
  HarnessNameSchema,
  HarnessSkillAwsSkillsSourceSchema,
  HarnessSkillGitAuthSchema,
  HarnessSkillPathSourceSchema,
  HarnessSpecSchema,
  HarnessToolSchema,
  HarnessTruncationConfigSchema,
  ManagedMemoryStrategySchema,
  type HarnessSpec,
} from "./harness";
import { TagsSchema } from "./tags";

const modelFields = HarnessModelSchema.shape;
const ModelSchema = z.union([
  z
    .object({
      bedrockModelConfig: z
        .object({
          modelId: modelFields.modelId,
          apiFormat: modelFields.apiFormat,
          maxTokens: modelFields.maxTokens,
          temperature: modelFields.temperature,
          topP: modelFields.topP,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      openAiModelConfig: z
        .object({
          modelId: modelFields.modelId,
          apiKeyArn: modelFields.apiKeyArn,
          apiFormat: modelFields.apiFormat,
          maxTokens: modelFields.maxTokens,
          temperature: modelFields.temperature,
          topP: modelFields.topP,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      geminiModelConfig: z
        .object({
          modelId: modelFields.modelId,
          apiKeyArn: modelFields.apiKeyArn,
          maxTokens: modelFields.maxTokens,
          temperature: modelFields.temperature,
          topP: modelFields.topP,
          topK: modelFields.topK,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      liteLlmModelConfig: z
        .object({
          modelId: modelFields.modelId,
          apiKeyArn: modelFields.apiKeyArn,
          apiBase: modelFields.apiBase,
          maxTokens: modelFields.maxTokens,
          temperature: modelFields.temperature,
          topP: modelFields.topP,
          additionalParams: modelFields.additionalParams,
        })
        .strict(),
    })
    .strict(),
]);

const SkillSchema = z.union([
  HarnessSkillPathSourceSchema,
  HarnessSkillAwsSkillsSourceSchema,
  z.object({ s3: z.object({ uri: z.string().startsWith("s3://") }).strict() }).strict(),
  z
    .object({
      git: z
        .object({
          url: z.string().startsWith("https://"),
          path: z.string().min(1).optional(),
          auth: HarnessSkillGitAuthSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);

const MemorySchema = z.union([
  z
    .object({
      managedMemoryConfiguration: z
        .object({
          strategies: z.array(ManagedMemoryStrategySchema).min(1).max(4).optional(),
          eventExpiryDuration: z.number().int().min(3).max(365).optional(),
          encryptionKeyArn: z.string().min(1).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      agentCoreMemoryConfiguration: z
        .object({
          name: z.string().min(1).optional(),
          arn: z.string().min(1).optional(),
          actorId: z.string().optional(),
          messagesCount: z.number().int().min(1).optional(),
          retrievalConfig: HarnessMemoryRetrievalConfigSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z.object({ disabled: z.object({}).strict() }).strict(),
]);

const NetworkConfigurationSchema = z
  .object({
    networkMode: z.enum(["PUBLIC", "VPC"]),
    networkModeConfig: z
      .object({
        subnets: NetworkConfigSchema.shape.subnets,
        securityGroups: NetworkConfigSchema.shape.securityGroups,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((network, ctx) => {
    if (network.networkMode === "PUBLIC" && network.networkModeConfig) {
      ctx.addIssue({
        code: "custom",
        path: ["networkModeConfig"],
        message: "networkModeConfig is only allowed when networkMode is VPC",
      });
    }
  });

const FilesystemConfigurationSchema = z.union([
  z.object({ sessionStorage: SessionStorageSchema }).strict(),
  z.object({ efsAccessPoint: EfsAccessPointConfigSchema }).strict(),
  z.object({ s3FilesAccessPoint: S3FilesAccessPointConfigSchema }).strict(),
]);

const EnvironmentSchema = z
  .object({
    agentCoreRuntimeEnvironment: z
      .object({
        networkConfiguration: NetworkConfigurationSchema.optional(),
        lifecycleConfiguration: LifecycleConfigurationSchema.optional(),
        filesystemConfigurations: z.array(FilesystemConfigurationSchema).optional(),
      })
      .strict()
      .superRefine((environment, ctx) => {
        const sessionStorageCount = environment.filesystemConfigurations?.filter(
          (item) => "sessionStorage" in item,
        ).length;
        if (sessionStorageCount && sessionStorageCount > 1) {
          ctx.addIssue({
            code: "custom",
            path: ["filesystemConfigurations"],
            message: "Only one sessionStorage mount is allowed",
          });
        }
      }),
  })
  .strict();

const ApiShapedHarnessSchema = z
  .object({
    name: HarnessNameSchema,
    model: ModelSchema,
    systemPrompt: z
      .array(z.object({ text: z.string().min(1) }).strict())
      .length(1)
      .optional(),
    tools: z.array(HarnessToolSchema).optional(),
    skills: z.array(SkillSchema).optional(),
    allowedTools: z.array(AllowedToolSchema).optional(),
    memory: MemorySchema.optional(),
    truncation: HarnessTruncationConfigSchema.optional(),
    maxIterations: HarnessSpecSchema.shape.maxIterations,
    maxTokens: HarnessSpecSchema.shape.maxTokens,
    timeoutSeconds: HarnessSpecSchema.shape.timeoutSeconds,
    environmentVariables: HarnessSpecSchema.shape.environmentVariables,
    environmentArtifact: z
      .object({
        containerConfiguration: z
          .object({ containerUri: HarnessSpecSchema.shape.containerUri.unwrap() })
          .strict(),
      })
      .strict()
      .optional(),
    environment: EnvironmentSchema.optional(),
    authorizerConfiguration: z
      .object({ customJWTAuthorizer: CustomJwtAuthorizerConfigSchema })
      .strict()
      .optional(),
    executionRoleArn: HarnessSpecSchema.shape.executionRoleArn,
    tags: TagsSchema.optional(),
    dockerfile: HarnessSpecSchema.shape.dockerfile,
    networkConfig: z
      .object({ vpcId: NetworkConfigSchema.shape.vpcId.unwrap() })
      .strict()
      .optional(),
    connections: z.array(ConnectionSchema).optional(),
  })
  .strict();

export type ApiShapedHarness = z.infer<typeof ApiShapedHarnessSchema>;

function normalizeModel(value: ApiShapedHarness["model"]) {
  if ("bedrockModelConfig" in value)
    return { provider: "bedrock" as const, ...value.bedrockModelConfig };
  if ("openAiModelConfig" in value)
    return { provider: "open_ai" as const, ...value.openAiModelConfig };
  if ("geminiModelConfig" in value)
    return { provider: "gemini" as const, ...value.geminiModelConfig };
  return { provider: "lite_llm" as const, ...value.liteLlmModelConfig };
}

function normalizeMemory(value: ApiShapedHarness["memory"]) {
  if (value === undefined) return undefined;
  if ("managedMemoryConfiguration" in value)
    return { mode: "managed" as const, ...value.managedMemoryConfiguration };
  if ("agentCoreMemoryConfiguration" in value)
    return { mode: "existing" as const, ...value.agentCoreMemoryConfiguration };
  return { mode: "disabled" as const };
}

export function parseHarnessProjectSpec(value: unknown): HarnessSpec {
  if (value && typeof value === "object" && "model" in value) {
    const rawModel = value.model;
    if (rawModel && typeof rawModel === "object" && "provider" in rawModel) {
      if (
        ["bedrockModelConfig", "openAiModelConfig", "geminiModelConfig", "liteLlmModelConfig"].some(
          (variant) => variant in rawModel,
        )
      ) {
        throw new z.ZodError([
          {
            code: "custom",
            path: ["model"],
            message: "model cannot combine provider with an API model configuration",
          },
        ]);
      }
      return HarnessSpecSchema.parse(value);
    }
  }

  const input = ApiShapedHarnessSchema.parse(value);
  const runtime = input.environment?.agentCoreRuntimeEnvironment;
  const network = runtime?.networkConfiguration;
  const mounts = runtime?.filesystemConfigurations ?? [];
  const efsAccessPoints = mounts.flatMap((item) =>
    "efsAccessPoint" in item ? [item.efsAccessPoint] : [],
  );
  const s3AccessPoints = mounts.flatMap((item) =>
    "s3FilesAccessPoint" in item ? [item.s3FilesAccessPoint] : [],
  );
  const skills = input.skills?.map((skill) => {
    if ("s3" in skill) return { s3Uri: skill.s3.uri };
    if ("git" in skill)
      return { gitUrl: skill.git.url, path: skill.git.path, auth: skill.git.auth };
    return skill;
  });
  const normalized = {
    name: input.name,
    model: normalizeModel(input.model),
    systemPrompt: input.systemPrompt?.[0]?.text,
    tools: input.tools,
    skills,
    allowedTools: input.allowedTools,
    memory: normalizeMemory(input.memory),
    truncation: input.truncation,
    maxIterations: input.maxIterations,
    maxTokens: input.maxTokens,
    timeoutSeconds: input.timeoutSeconds,
    environmentVariables: input.environmentVariables,
    containerUri: input.environmentArtifact?.containerConfiguration.containerUri,
    networkMode: network?.networkMode ?? "PUBLIC",
    networkConfig:
      network?.networkMode === "VPC"
        ? { ...network.networkModeConfig, ...input.networkConfig }
        : input.networkConfig,
    lifecycleConfig: runtime?.lifecycleConfiguration,
    sessionStoragePath: mounts.find((item) => "sessionStorage" in item)?.sessionStorage.mountPath,
    efsAccessPoints: efsAccessPoints.length ? efsAccessPoints : undefined,
    s3AccessPoints: s3AccessPoints.length ? s3AccessPoints : undefined,
    authorizerType: input.authorizerConfiguration ? "CUSTOM_JWT" : "AWS_IAM",
    authorizerConfiguration: input.authorizerConfiguration && {
      customJwtAuthorizer: input.authorizerConfiguration.customJWTAuthorizer,
    },
    executionRoleArn: input.executionRoleArn,
    tags: input.tags,
    dockerfile: input.dockerfile,
    connections: input.connections,
  };
  return HarnessSpecSchema.parse(
    Object.fromEntries(Object.entries(normalized).filter(([, field]) => field !== undefined)),
  );
}

function toApiModel(config: HarnessSpec["model"]): ApiShapedHarness["model"] {
  const {
    provider,
    modelId,
    maxTokens,
    temperature,
    topP,
    apiFormat,
    apiKeyArn,
    topK,
    apiBase,
    additionalParams,
  } = config;
  const common = { modelId, maxTokens, temperature, topP };
  switch (provider) {
    case "bedrock":
      return { bedrockModelConfig: { ...common, apiFormat } };
    case "open_ai":
      return { openAiModelConfig: { ...common, apiFormat, apiKeyArn } };
    case "gemini":
      return { geminiModelConfig: { ...common, apiKeyArn, topK } };
    case "lite_llm":
      return { liteLlmModelConfig: { ...common, apiKeyArn, apiBase, additionalParams } };
  }
}

export function toApiShapedHarnessSpec(spec: HarnessSpec): ApiShapedHarness {
  let memory: ApiShapedHarness["memory"];
  if (spec.memory?.mode === "managed") {
    const { mode: _mode, ...config } = spec.memory;
    memory = { managedMemoryConfiguration: config };
  } else if (spec.memory?.mode === "existing") {
    const { mode: _mode, ...config } = spec.memory;
    memory = { agentCoreMemoryConfiguration: config };
  } else if (spec.memory?.mode === "disabled") {
    memory = { disabled: {} };
  }
  const filesystemConfigurations = [
    ...(spec.sessionStoragePath
      ? [{ sessionStorage: { mountPath: spec.sessionStoragePath } }]
      : []),
    ...(spec.efsAccessPoints ?? []).map((efsAccessPoint) => ({ efsAccessPoint })),
    ...(spec.s3AccessPoints ?? []).map((s3FilesAccessPoint) => ({ s3FilesAccessPoint })),
  ];
  const runtime = {
    networkConfiguration:
      spec.networkMode === "VPC" && spec.networkConfig
        ? {
            networkMode: "VPC",
            networkModeConfig: {
              subnets: spec.networkConfig.subnets,
              securityGroups: spec.networkConfig.securityGroups,
            },
          }
        : undefined,
    lifecycleConfiguration: spec.lifecycleConfig,
    filesystemConfigurations: filesystemConfigurations.length
      ? filesystemConfigurations
      : undefined,
  };
  const env = Object.fromEntries(
    Object.entries(runtime).filter(([, field]) => field !== undefined),
  );
  const candidate = {
    name: spec.name,
    model: toApiModel(spec.model),
    systemPrompt: spec.systemPrompt === undefined ? undefined : [{ text: spec.systemPrompt }],
    tools: spec.tools,
    allowedTools: spec.allowedTools,
    skills: spec.skills.map((skill) => {
      if ("s3Uri" in skill) return { s3: { uri: skill.s3Uri } };
      if ("gitUrl" in skill)
        return { git: { url: skill.gitUrl, path: skill.path, auth: skill.auth } };
      return skill;
    }),
    memory,
    truncation: spec.truncation,
    maxIterations: spec.maxIterations,
    maxTokens: spec.maxTokens,
    timeoutSeconds: spec.timeoutSeconds,
    environmentVariables: spec.environmentVariables,
    environmentArtifact: spec.containerUri
      ? { containerConfiguration: { containerUri: spec.containerUri } }
      : undefined,
    environment: Object.keys(env).length ? { agentCoreRuntimeEnvironment: env } : undefined,
    authorizerConfiguration: spec.authorizerConfiguration?.customJwtAuthorizer
      ? { customJWTAuthorizer: spec.authorizerConfiguration.customJwtAuthorizer }
      : undefined,
    executionRoleArn: spec.executionRoleArn,
    tags: spec.tags,
    dockerfile: spec.dockerfile,
    networkConfig:
      spec.networkMode === "VPC" && spec.networkConfig?.vpcId
        ? { vpcId: spec.networkConfig.vpcId }
        : undefined,
    connections: spec.connections,
  };
  return ApiShapedHarnessSchema.parse(
    Object.fromEntries(Object.entries(candidate).filter(([, field]) => field !== undefined)),
  );
}
