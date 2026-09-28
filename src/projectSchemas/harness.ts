import {
  EfsAccessPointConfigSchema,
  LifecycleConfigurationSchema,
  NetworkConfigSchema,
  S3FilesAccessPointConfigSchema,
  SessionStorageSchema,
} from "./runtime";
import { CustomJwtAuthorizerConfigSchema } from "./auth";
import { ConnectionSchema } from "./connections";
import { uniqueBy } from "./zod-util";
import { TagsSchema } from "./tags";
import { z } from "zod";
export const CONTAINER_URI_PATTERN =
  /^(([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com(\.cn)?|public\.ecr\.aws)\/((?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*)(?::([^:@]{1,300}))?(?:@(.+))?$/;
export const MAX_CONTAINER_URI_LENGTH = 1024;
export const MAX_ENV_VAR_VALUE_LENGTH = 5000;
export const MAX_ENV_VARS = 50;
export const MAX_ENV_VAR_KEY_LENGTH = 100;
export const HarnessNameSchema = z
  .string()
  .min(1, "Harness name is required")
  .max(40)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/,
    "Must begin with a letter and contain only alphanumeric characters and underscores (max 40 chars)",
  );
export const HarnessModelProviderSchema = z.enum(["bedrock", "open_ai", "gemini", "lite_llm"]);
export type HarnessModelProvider = z.infer<typeof HarnessModelProviderSchema>;

/** The model a harness runs on when none is configured; `agentcore create`'s
 * harness path and the `harness create` screen share it so the entry points
 * cannot drift. It lives here, not in a handler, so the TUI can import it
 * without pulling in the handler tree (which imports the TUI back). */
export const DEFAULT_HARNESS_MODEL = {
  bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-5" },
} as const;
export const MAX_LITE_LLM_API_BASE_LENGTH = 16383;
export const BedrockApiFormatSchema = z.enum(["converse_stream", "responses", "chat_completions"]);
export type BedrockApiFormat = z.infer<typeof BedrockApiFormatSchema>;
export const OpenAiApiFormatSchema = z.enum(["responses", "chat_completions"]);
export type OpenAiApiFormat = z.infer<typeof OpenAiApiFormatSchema>;
export const HarnessApiFormatSchema = z.enum(["converse_stream", "responses", "chat_completions"]);
export type HarnessApiFormat = z.infer<typeof HarnessApiFormatSchema>;
const modelFields = {
  modelId: z.string().min(1, "Model ID is required"),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
};
export const HarnessModelSchema = z.union([
  z.strictObject({
    bedrockModelConfig: z.strictObject({
      ...modelFields,
      apiFormat: BedrockApiFormatSchema.optional(),
    }),
  }),
  z.strictObject({
    openAiModelConfig: z.strictObject({
      ...modelFields,
      apiKeyArn: z.string().min(1),
      apiFormat: OpenAiApiFormatSchema.optional(),
    }),
  }),
  z.strictObject({
    geminiModelConfig: z.strictObject({
      ...modelFields,
      apiKeyArn: z.string().min(1),
      topK: z.number().int().min(0).max(500).optional(),
    }),
  }),
  z.strictObject({
    liteLlmModelConfig: z.strictObject({
      ...modelFields,
      apiKeyArn: z.string().min(1).optional(),
      apiBase: z.string().min(1).max(MAX_LITE_LLM_API_BASE_LENGTH).optional(),
      additionalParams: z.record(z.string(), z.unknown()).optional(),
    }),
  }),
]);
export type HarnessModel = z.infer<typeof HarnessModelSchema>;
export function validateApiFormat(
  apiFormat: string,
  provider: string,
):
  | {
      valid: true;
    }
  | {
      valid: false;
      error: string;
    } {
  const allFormats = HarnessApiFormatSchema.options as readonly string[];
  if (!allFormats.includes(apiFormat)) {
    return {
      valid: false,
      error: `Invalid API format: ${apiFormat}. Use ${allFormats.join(", ")}`,
    };
  }
  if (provider !== "bedrock" && provider !== "open_ai") {
    return {
      valid: false,
      error: "--api-format is only supported for bedrock and open_ai providers",
    };
  }
  const formats = provider === "open_ai" ? OpenAiApiFormatSchema : BedrockApiFormatSchema;
  if (!formats.safeParse(apiFormat).success) {
    return {
      valid: false,
      error: `Invalid API format for ${provider}: ${apiFormat}. Use ${formats.options.join(", ")}`,
    };
  }
  return { valid: true };
}
export const HarnessToolTypeSchema = z.enum([
  "remote_mcp",
  "agentcore_browser",
  "agentcore_gateway",
  "inline_function",
  "agentcore_code_interpreter",
]);
export type HarnessToolType = z.infer<typeof HarnessToolTypeSchema>;
export const HarnessToolNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Tool name must contain only alphanumeric characters, hyphens, and underscores (1-64 chars)",
  );
export const RemoteMcpConfigSchema = z
  .object({
    remoteMcp: z.object({
      url: z.string().min(1),
      headers: z.record(z.string(), z.string()).optional(),
    }),
  })
  .strict();
export const AgentCoreBrowserConfigSchema = z
  .object({
    agentCoreBrowser: z.object({
      browserArn: z.string().optional(),
    }),
  })
  .strict();
export const AgentCoreCodeInterpreterConfigSchema = z
  .object({
    agentCoreCodeInterpreter: z.object({
      codeInterpreterArn: z.string().optional(),
    }),
  })
  .strict();
export const GatewayOAuthGrantTypeSchema = z.enum(["CLIENT_CREDENTIALS", "USER_FEDERATION"]);
export const HarnessGatewayOutboundAuthSchema = z.union([
  z.object({ awsIam: z.object({}) }),
  z.object({ none: z.object({}) }),
  z.object({
    oauth: z.object({
      providerArn: z.string().min(1),
      scopes: z.array(z.string().min(1)),
      grantType: GatewayOAuthGrantTypeSchema.optional(),
      customParameters: z.record(z.string(), z.string()).optional(),
    }),
  }),
]);
export type HarnessGatewayOutboundAuth = z.infer<typeof HarnessGatewayOutboundAuthSchema>;
export const AgentCoreGatewayConfigSchema = z
  .object({
    agentCoreGateway: z.strictObject({
      gatewayArn: z.string().min(1),
      outboundAuth: HarnessGatewayOutboundAuthSchema.optional(),
    }),
  })
  .strict();
export const InlineFunctionConfigSchema = z
  .object({
    inlineFunction: z.object({
      description: z.string().min(1),
      inputSchema: z.record(z.string(), z.unknown()),
    }),
  })
  .strict();
export const HarnessToolConfigSchema = z.union([
  RemoteMcpConfigSchema,
  AgentCoreBrowserConfigSchema,
  AgentCoreCodeInterpreterConfigSchema,
  AgentCoreGatewayConfigSchema,
  InlineFunctionConfigSchema,
]);
const TOOL_TYPE_TO_CONFIG_KEY: Record<HarnessToolType, string> = {
  remote_mcp: "remoteMcp",
  agentcore_browser: "agentCoreBrowser",
  agentcore_gateway: "agentCoreGateway",
  inline_function: "inlineFunction",
  agentcore_code_interpreter: "agentCoreCodeInterpreter",
};
const TOOL_TYPES_REQUIRING_CONFIG = new Set<HarnessToolType>([
  "remote_mcp",
  "agentcore_gateway",
  "inline_function",
]);
export const HarnessToolSchema = z
  .object({
    type: HarnessToolTypeSchema,
    name: HarnessToolNameSchema,
    config: HarnessToolConfigSchema.optional(),
  })
  .superRefine((tool, ctx) => {
    const expectedKey = TOOL_TYPE_TO_CONFIG_KEY[tool.type];
    if (!tool.config) {
      if (TOOL_TYPES_REQUIRING_CONFIG.has(tool.type)) {
        ctx.addIssue({
          code: "custom",
          message: `Tool type "${tool.type}" requires a "${expectedKey}" config`,
          path: ["config"],
        });
      }
      return;
    }
    const configKeys = Object.keys(tool.config);
    if (configKeys.length !== 1 || configKeys[0] !== expectedKey) {
      ctx.addIssue({
        code: "custom",
        message: `Tool type "${tool.type}" requires "${expectedKey}" config, got "${configKeys[0]}"`,
        path: ["config"],
      });
    }
  });
export type HarnessTool = z.infer<typeof HarnessToolSchema>;
export const HarnessMemoryRetrievalConfigSchema = z
  .object({
    topK: z.number().int().min(1).optional(),
    relevanceScore: z.number().min(0).max(1).optional(),
  })
  .strict()
  .refine((v) => v.topK !== undefined || v.relevanceScore !== undefined, {
    message: "retrievalConfig must specify at least one of topK or relevanceScore",
  });
export type HarnessMemoryRetrievalConfig = z.infer<typeof HarnessMemoryRetrievalConfigSchema>;
export const ManagedMemoryStrategySchema = z.enum([
  "SEMANTIC",
  "SUMMARIZATION",
  "USER_PREFERENCE",
  "EPISODIC",
]);
const ManagedMemoryRefSchema = z
  .object({
    strategies: z.array(ManagedMemoryStrategySchema).min(1).max(4).optional(),
    eventExpiryDuration: z.number().int().min(3).max(365).optional(),
    encryptionKeyArn: z.string().min(1).optional(),
  })
  .strict();
const ExistingMemoryRefSchema = z
  .object({
    name: z.string().min(1).optional(),
    arn: z.string().min(1).optional(),
    actorId: z.string().optional(),
    messagesCount: z.number().int().min(1).optional(),
    retrievalConfig: HarnessMemoryRetrievalConfigSchema.optional(),
  })
  .strict()
  .refine((m) => m.arn != null || m.name != null, {
    message: "existing memory requires `arn` or `name`",
    path: ["name"],
  })
  .superRefine((ref, ctx) => {
    if (ref.arn && ref.retrievalConfig !== undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "retrievalConfig is not supported when memory is referenced by `arn` (per-namespace tuning is only resolvable for a by-name reference). Reference the memory by `name` only, or drop retrievalConfig.",
        path: ["retrievalConfig"],
      });
    }
  });
export const HarnessMemoryRefSchema = z.union([
  z.strictObject({ managedMemoryConfiguration: ManagedMemoryRefSchema }),
  z.strictObject({ agentCoreMemoryConfiguration: ExistingMemoryRefSchema }),
  z.strictObject({ disabled: z.strictObject({}) }),
]);
export type HarnessMemoryRef = z.infer<typeof HarnessMemoryRefSchema>;
export type ManagedMemoryStrategy = z.infer<typeof ManagedMemoryStrategySchema>;
export const HarnessTruncationStrategySchema = z.enum(["sliding_window", "summarization", "none"]);
export const SlidingWindowConfigSchema = z
  .object({
    slidingWindow: z.object({
      messagesCount: z.number().int().min(1).optional(),
    }),
  })
  .strict();
export const SummarizationConfigSchema = z
  .object({
    summarization: z.object({
      summaryRatio: z.number().min(0).max(1).optional(),
      preserveRecentMessages: z.number().int().min(0).optional(),
      summarizationSystemPrompt: z.string().optional(),
    }),
  })
  .strict();
export const HarnessTruncationConfigSchema = z
  .object({
    strategy: HarnessTruncationStrategySchema,
    config: z.union([SlidingWindowConfigSchema, SummarizationConfigSchema]).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.config) return;
    const configKey = "slidingWindow" in data.config ? "slidingWindow" : "summarization";
    const expected: Record<typeof data.strategy, string | undefined> = {
      sliding_window: "slidingWindow",
      summarization: "summarization",
      none: undefined,
    };
    if (expected[data.strategy] === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `Truncation strategy "${data.strategy}" does not take a config`,
        path: ["config"],
      });
    } else if (expected[data.strategy] !== configKey) {
      ctx.addIssue({
        code: "custom",
        message: `Truncation strategy "${data.strategy}" requires a "${expected[data.strategy]}" config, got "${configKey}"`,
        path: ["config"],
      });
    }
  });
export type HarnessTruncationConfig = z.infer<typeof HarnessTruncationConfigSchema>;
export const HarnessSkillGitAuthSchema = z
  .object({
    credentialName: z.string().min(1).optional(),
    credentialArn: z.string().min(1).optional(),
    username: z.string().optional(),
  })
  .refine((data) => Boolean(data.credentialName) !== Boolean(data.credentialArn), {
    message: "Exactly one of credentialName or credentialArn must be provided",
    path: ["credentialName"],
  });
export type HarnessSkillGitAuth = z.infer<typeof HarnessSkillGitAuthSchema>;
export const HarnessSkillS3SourceSchema = z
  .object({
    s3: z.strictObject({
      uri: z
        .string()
        .min(5)
        .regex(/^s3:\/\//, "Must be an S3 URI starting with s3://"),
    }),
  })
  .strict();
export type HarnessSkillS3Source = z.infer<typeof HarnessSkillS3SourceSchema>;
export const HarnessSkillGitSourceSchema = z
  .object({
    git: z.strictObject({
      url: z
        .string()
        .min(8)
        .regex(/^https:\/\//, "Must be an HTTPS git URL"),
      path: z.string().min(1).optional(),
      auth: HarnessSkillGitAuthSchema.optional(),
    }),
  })
  .strict();
export type HarnessSkillGitSource = z.infer<typeof HarnessSkillGitSourceSchema>;
export const HarnessSkillPathSourceSchema = z
  .object({
    path: z.string().min(1),
  })
  .strict();
export type HarnessSkillPathSource = z.infer<typeof HarnessSkillPathSourceSchema>;
export const HarnessSkillAwsSkillsSourceSchema = z
  .object({
    awsSkills: z
      .object({
        paths: z.array(z.string().min(1).max(4096)).optional(),
      })
      .strict(),
  })
  .strict();
export type HarnessSkillAwsSkillsSource = z.infer<typeof HarnessSkillAwsSkillsSourceSchema>;
export const HarnessSkillSchema = z.union([
  HarnessSkillS3SourceSchema,
  HarnessSkillGitSourceSchema,
  HarnessSkillPathSourceSchema,
  HarnessSkillAwsSkillsSourceSchema,
]);
export type HarnessSkillInput = z.input<typeof HarnessSkillSchema>;
export type HarnessSkill = z.output<typeof HarnessSkillSchema>;
export const AllowedToolSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\*$|^@?[^/]+$|^@?[^/]+\/[^/]+$/, 'Must be "*" or a tool name pattern (max 64 chars)');
const HarnessNetworkConfigurationSchema = z.union([
  z.strictObject({ networkMode: z.literal("PUBLIC") }),
  z.strictObject({
    networkMode: z.literal("VPC"),
    networkModeConfig: NetworkConfigSchema.pick({ subnets: true, securityGroups: true }).strict(),
  }),
]);
const HarnessFilesystemConfigurationSchema = z.union([
  z.strictObject({ sessionStorage: SessionStorageSchema.strict() }),
  z.strictObject({ efsAccessPoint: EfsAccessPointConfigSchema.strict() }),
  z.strictObject({ s3FilesAccessPoint: S3FilesAccessPointConfigSchema.strict() }),
]);
export const HarnessSpecSchema = z
  .object({
    name: HarnessNameSchema,
    model: HarnessModelSchema,
    systemPrompt: z
      .array(
        z.strictObject({
          text: z.string().refine((value) => value.trim().length > 0, {
            message: "systemPrompt text must not be empty or whitespace-only",
          }),
        }),
      )
      .min(1)
      .optional(),
    tools: z
      .array(HarnessToolSchema)
      .default([])
      .superRefine(
        uniqueBy(
          (tool) => tool.name,
          (name) => `Duplicate tool name: ${name}`,
        ),
      ),
    skills: z.array(HarnessSkillSchema).default([]),
    allowedTools: z.array(AllowedToolSchema).optional(),
    memory: HarnessMemoryRefSchema.optional(),
    maxIterations: z.number().int().min(1).optional(),
    maxTokens: z.number().int().min(1).optional(),
    timeoutSeconds: z.number().int().min(1).optional(),
    truncation: HarnessTruncationConfigSchema.optional(),
    environmentArtifact: z
      .strictObject({
        containerConfiguration: z.strictObject({
          containerUri: z
            .string()
            .min(1)
            .max(MAX_CONTAINER_URI_LENGTH)
            .regex(
              CONTAINER_URI_PATTERN,
              "containerUri must be an ECR image URI (12-digit private ECR or public.ecr.aws)",
            ),
        }),
      })
      .optional(),
    dockerfile: z.string().min(1).optional(),
    executionRoleArn: z.string().optional(),
    networkConfig: NetworkConfigSchema.pick({ vpcId: true }).required().strict().optional(),
    environment: z
      .strictObject({
        agentCoreRuntimeEnvironment: z.strictObject({
          networkConfiguration: HarnessNetworkConfigurationSchema.optional(),
          lifecycleConfiguration: LifecycleConfigurationSchema.strict().optional(),
          filesystemConfigurations: z.array(HarnessFilesystemConfigurationSchema).max(5).optional(),
        }),
      })
      .optional(),
    environmentVariables: z
      .record(
        z.string().min(1).max(MAX_ENV_VAR_KEY_LENGTH),
        z.string().max(MAX_ENV_VAR_VALUE_LENGTH),
      )
      .refine((rec) => Object.keys(rec).length <= MAX_ENV_VARS, {
        message: `A maximum of ${MAX_ENV_VARS} environment variables is allowed`,
      })
      .optional(),
    authorizerConfiguration: z
      .strictObject({
        customJWTAuthorizer: CustomJwtAuthorizerConfigSchema,
      })
      .optional(),
    connections: z.array(ConnectionSchema).optional(),
    tags: TagsSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.environmentArtifact && data.dockerfile) {
      ctx.addIssue({
        code: "custom",
        message: "environmentArtifact and dockerfile are mutually exclusive",
        path: ["environmentArtifact"],
      });
    }
    const runtime = data.environment?.agentCoreRuntimeEnvironment;
    const network = runtime?.networkConfiguration;
    if (network?.networkMode !== "VPC" && data.networkConfig) {
      ctx.addIssue({
        code: "custom",
        message: "networkConfig is only allowed when networkMode is VPC",
        path: ["networkConfig"],
      });
    }
    if (network?.networkMode === "VPC" && data.dockerfile && !data.networkConfig?.vpcId) {
      ctx.addIssue({
        code: "custom",
        message:
          "networkConfig.vpcId is required for Dockerfile builds in VPC mode (CodeBuild cannot infer the VPC from subnets)",
        path: ["networkConfig", "vpcId"],
      });
    }
    if (
      network?.networkMode === "VPC" &&
      data.dockerfile &&
      network.networkModeConfig.securityGroups.length > 5
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Dockerfile builds in VPC mode allow at most 5 security groups (CodeBuild limit)",
        path: [
          "environment",
          "agentCoreRuntimeEnvironment",
          "networkConfiguration",
          "networkModeConfig",
          "securityGroups",
        ],
      });
    }
    const mounts = runtime?.filesystemConfigurations ?? [];
    const mountPath = ["environment", "agentCoreRuntimeEnvironment", "filesystemConfigurations"];
    if (mounts.some((mount) => !("sessionStorage" in mount)) && network?.networkMode !== "VPC") {
      ctx.addIssue({
        code: "custom",
        message: "efsAccessPoint and s3FilesAccessPoint mounts require networkMode: VPC",
        path: mountPath,
      });
    }
    for (const [kind, limit] of [
      ["sessionStorage", 1],
      ["efsAccessPoint", 2],
      ["s3FilesAccessPoint", 2],
    ] as const) {
      if (mounts.filter((mount) => kind in mount).length > limit) {
        ctx.addIssue({
          code: "custom",
          message: `Maximum ${limit} ${kind} mounts allowed`,
          path: mountPath,
        });
      }
    }
    const mountPaths = mounts.map((mount) => {
      const config =
        "sessionStorage" in mount
          ? mount.sessionStorage
          : "efsAccessPoint" in mount
            ? mount.efsAccessPoint
            : mount.s3FilesAccessPoint;
      return config.mountPath.replace(/\/$/, "");
    });
    if (new Set(mountPaths).size !== mountPaths.length) {
      ctx.addIssue({
        code: "custom",
        message: "Filesystem mount paths must be unique",
        path: mountPath,
      });
    }
  });
export type HarnessSpec = z.infer<typeof HarnessSpecSchema>;
export const HarnessRegistryEntrySchema = z.object({
  name: HarnessNameSchema,
  path: z.string().min(1, "Path to harness config directory is required"),
});
export type HarnessRegistryEntry = z.infer<typeof HarnessRegistryEntrySchema>;
