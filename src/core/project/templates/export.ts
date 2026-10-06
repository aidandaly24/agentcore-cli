import { createHash } from "node:crypto";
import type { z } from "zod";
import type { ProjectRuntime } from "../../../projectSchemas/runtime";
import type {
  HarnessMemoryRef,
  HarnessMemoryRetrievalConfig,
  HarnessSkill,
  HarnessSkillGitSource,
  HarnessSkillPathSource,
  HarnessSkillS3Source,
  HarnessSkillAwsSkillsSource,
  HarnessSpec,
  HarnessTool,
  HarnessTruncationConfig,
} from "../../../projectSchemas/harness";
import type { ProjectSpecSchema } from "../../../projectSchemas/project";
import { credentialEnvVarName, type Credential } from "../../../projectSchemas/credential";
import { memoryEnvVarName, type Memory } from "../../../projectSchemas/memory";
import type { EnvLocalEntry } from "../../../handlers/project/types";
import { InputValidationError } from "../../../errors/errors";
import { toPythonPackageName } from "../fsUtils";
import { regionFromArn, resourceNameFromArn } from "../../arn";
import {
  connectionIdForTarget,
  connectionTokenFor,
  type Connection,
  type ConnectionTarget,
} from "../../../projectSchemas/connections";
import type {
  ExecutionRoleSource,
  MemoryRetrievalConfig,
} from "../../../handlers/project/export/types";

type ProjectSpec = z.infer<typeof ProjectSpecSchema>;

export const EXPORT_NOTES_FILENAME = "EXPORT_NOTES.md";
export const DEFAULT_EXPORT_SYSTEM_PROMPT = "You are a helpful assistant.";

/** A manual follow-up item recorded while mapping, written to EXPORT_NOTES.md. */
export interface ExportNote {
  category: string;
  message: string;
}

/** A single rendered output line + a tone the caller maps to its own styling. */
export interface ExportNoteLine {
  text: string;
  tone: "warn" | "dim";
}

/** Everything the mapper needs; all reads are done by the caller. */
export interface HarnessExportInput {
  harnessName: string;
  targetAgentName: string;
  /** The parsed harness spec (from app/<name>/harness.yaml or the service). */
  spec: HarnessSpec;
  /** The resolved system prompt text (explicit prompt > conventional file > default). */
  systemPrompt: string;
  /** The current project spec, for memory lookups and credential dedup. */
  projectSpec: ProjectSpec;
  /** Notes collected while converting a service response into a local harness spec. */
  sourceNotes?: ExportNote[];
  /** Service model additionalParams, which the local harness spec only holds for lite_llm. */
  modelAdditionalParams?: Record<string, unknown>;
  executionRoleSource?: ExecutionRoleSource;
  sourceArn?: string;
  memoryRetrievalConfig?: MemoryRetrievalConfig;
  modelApiBase?: string;
}

/** The pure mapping result; the project manager executes it against the filesystem. */
export interface HarnessExportPlan {
  /** Handlebars context for rendering the export-harness-python template. */
  context: Record<string, unknown>;
  /** The runtimes[] entry to append to agentcore.json. */
  runtime: ProjectRuntime;
  /** New credential entries to append (already-present names are pre-filtered). */
  credentials: Credential[];
  /** Secret material for agentcore/.env.local (e.g. remote MCP header values). */
  envEntries: EnvLocalEntry[];
  /** Generated IAM policy documents written into the agent dir, keyed by filename. */
  policyFiles: Record<string, unknown>;
  /** Whether the render includes the memory/ module. */
  hasMemory: boolean;
  notes: ExportNote[];
}

// ============================================================================
// Note categories
// ============================================================================

export const ALLOWED_TOOLS_NOTE_CATEGORY = "allowedTools: per-invocation overrides dropped";
export const GATEWAY_TOOL_NOTE_CATEGORY = "Gateway tool not exported — wire up manually";
export const BROWSER_TOOL_NOTE_CATEGORY = "Browser tool not exported — wire up manually";
export const CODE_INTERPRETER_TOOL_NOTE_CATEGORY =
  "Code-interpreter tool not exported — wire up manually";
export const MEMORY_ARN_NOTE_CATEGORY = "External memory reference retained";
export const MEMORY_MANAGED_NOTE_CATEGORY = "Managed harness memory not exported";
export const MEMORY_NAME_NOT_FOUND_NOTE_CATEGORY = "Memory reference could not be resolved";
export const MEMORY_MESSAGES_COUNT_NOTE_CATEGORY =
  "Memory messagesCount is not directly portable to Strands";
export const PATH_SKILLS_NOTE_CATEGORY = "path skills require container filesystem";
export const GIT_SKILLS_CONTAINER_NOTE_CATEGORY = "git skills require git in container image";
export const GIT_SKILLS_AUTH_NOTE_CATEGORY = "git skill credential provider referenced";
export const AWS_SKILLS_NOTE_CATEGORY =
  "AWS skills omitted — not available outside managed harness";
export const MALFORMED_S3_SKILL_NOTE_CATEGORY =
  "S3 skill URI is malformed — no S3 read permission generated";
export const MCP_HEADER_CREDS_NOTE_CATEGORY = "MCP tool header credentials";
export const LITELLM_NO_API_KEY_NOTE_CATEGORY = "LiteLLM model may require an API key";
export const MODEL_API_KEY_NOTE_CATEGORY = "Model API key credential referenced";
export const CONTAINER_IMAGE_NOTE_CATEGORY = "Container image not carried over";

// ============================================================================
// Public entry point
// ============================================================================

export function mapHarnessToExportPlan(input: HarnessExportInput): HarnessExportPlan {
  const { spec, targetAgentName, projectSpec } = input;
  const notes: ExportNote[] = [...(input.sourceNotes ?? [])];
  const credentials: Credential[] = [];
  const envEntries: EnvLocalEntry[] = [];
  const policyFiles: Record<string, unknown> = {};
  const additionalPolicies: string[] = [];
  const connections: Connection[] = [...(spec.connections ?? [])];
  const roleSource = input.executionRoleSource;
  if (input.sourceArn) {
    notes.push({
      category: "Source provenance",
      message: `Source harness: ${input.sourceArn}. Existing dependency ARNs remain literal and source-owned. The new project's default target uses the source account and region; existing project targets are unchanged.`,
    });
  }
  if (roleSource) {
    for (const policy of roleSource.inlinePolicies) {
      const filename = `source-role-${policy.name.replace(/[^a-zA-Z0-9_+=,.@-]/g, "_")}.json`;
      if (filename in policyFiles)
        throw new InputValidationError("Source inline policy filenames collide.");
      policyFiles[filename] = policy.document;
    }
    additionalPolicies.push(...roleSource.managedPolicyArns);
    notes.push({
      category: "Source execution-role access",
      message: `Captured inline policies, managed-policy references, permissions boundary and durable tags from ${roleSource.roleArn}. The runtime creates a new role with runtime-owned trust and startup permissions; source trust is not copied. Application policies are not expanded or rewritten. Managed policies remain controlled by their existing owners. Resource policies, principal-specific conditions or external owners may need changes for the new principal; this is not a universal effective-access clone.`,
    });
  }

  // Export always emits a CodeZip runtime. The generated agent is a self-contained Strands
  // application whose dependencies come from its own pyproject.toml, so it needs no image build
  // and never reaches CodeBuild. A source image or Dockerfile is reported rather than rebuilt.
  if (spec.containerUri || spec.dockerfile) {
    const what = spec.containerUri
      ? `a pre-built container image (${spec.containerUri})`
      : `a custom Dockerfile (${spec.dockerfile})`;
    notes.push({
      category: CONTAINER_IMAGE_NOTE_CATEGORY,
      message:
        `The harness used ${what} as its execution environment. The exported agent does not ` +
        `rebuild it: the generated Strands application declares its own dependencies and runs ` +
        `on the managed Python runtime. If that image supplied anything the agent needs at ` +
        `runtime — system packages, certificates, or files read from disk — add it to the ` +
        `generated project yourself.`,
    });
  }

  const networkConfig =
    spec.networkMode === "VPC" && spec.networkConfig ? spec.networkConfig : undefined;

  const allowedToolPatterns = spec.allowedTools ?? ["*"];
  if (!(allowedToolPatterns.length === 1 && allowedToolPatterns[0] === "*")) {
    notes.push({
      category: ALLOWED_TOOLS_NOTE_CATEGORY,
      message:
        "The harness allowedTools filter has been applied statically at code-generation time. " +
        "Tools excluded at export will not be available at runtime, and callers cannot override " +
        "the tool list per invocation (unlike the harness).",
    });
  }

  const model = resolveModel(spec, notes, input.modelAdditionalParams);
  const memory = resolveMemory(spec, projectSpec, notes, connections);
  const tools = resolveTools(
    spec,
    allowedToolPatterns,
    projectSpec,
    credentials,
    envEntries,
    notes,
    connections,
  );
  const skills = resolveSkills(spec, notes);
  if (!roleSource) {
    for (const [file, doc] of Object.entries(skills.policyFiles)) policyFiles[file] = doc;
    if (model.policyFile) policyFiles[model.policyFile.name] = model.policyFile.doc;
  }
  additionalPolicies.unshift(...Object.keys(policyFiles));
  const memoryRetrievalNamespaces = Object.entries(
    input.memoryRetrievalConfig ?? memory.namespaceConfig ?? {},
  ).map(([namespace, tuning]) => ({
    namespace,
    topK: tuning.topK ?? 5,
    relevanceScore: tuning.relevanceScore ?? 0,
  }));

  const hasExecutionLimits =
    spec.maxIterations !== undefined ||
    spec.maxTokens !== undefined ||
    spec.timeoutSeconds !== undefined;

  const filesystemConfigurations = buildFilesystemConfigurations(spec);
  const envVars = Object.entries(spec.environmentVariables ?? {}).map(([name, value]) => ({
    name,
    value,
  }));

  const context: Record<string, unknown> = {
    name: toPythonPackageName(targetAgentName),
    isExportHarness: true,
    entrypoint: "main",
    enableOtel: true,
    isVpc: spec.networkMode === "VPC",
    protocol: "HTTP",
    // Model
    ...model.context,
    ...(input.modelApiBase && { openAiApiBase: input.modelApiBase }),
    // System prompt (written verbatim into main.py)
    systemPromptText: input.systemPrompt,
    // Memory
    hasMemory: memory.provider !== undefined,
    memoryEnvVarName: memory.provider?.envVarName,
    memoryStrategies: memory.provider?.strategies ?? [],
    memoryRetrievalTopK:
      memory.retrievalConfig?.topK !== undefined ? String(memory.retrievalConfig.topK) : undefined,
    memoryRetrievalRelevanceScore:
      memory.retrievalConfig?.relevanceScore !== undefined
        ? String(memory.retrievalConfig.relevanceScore)
        : undefined,
    actorId: memory.actorId,
    memoryRegion: memory.region,
    memoryRetrievalNamespaces: undefinedIfEmpty(memoryRetrievalNamespaces),
    // Tools. Empty collections become undefined: the template's custom `or`/
    // `some` helpers use JS truthiness, where [] is truthy, unlike `{{#if}}`.
    inlineFunctionTools: undefinedIfEmpty(tools.inlineFunctionTools),
    remoteMcpTools: undefinedIfEmpty(tools.remoteMcpTools),
    hasIamGateway: tools.remoteMcpTools.some((tool) => tool.awsIam),
    hasShell: tools.hasShell,
    hasFileOperations: tools.hasFileOperations,
    // Skills
    hasSkillsFetcher: skills.hasSkillsFetcher,
    hasFetchedSkills: skills.hasFetchedSkills,
    s3Skills: undefinedIfEmpty(skills.s3Skills),
    gitSkills: undefinedIfEmpty(skills.gitSkills),
    // Execution limits (numbers are schema-validated >= 1, so plain #if works)
    hasExecutionLimits,
    maxIterations: spec.maxIterations,
    maxTokens: spec.maxTokens,
    timeoutSeconds: spec.timeoutSeconds,
    // Conversation truncation
    truncationStrategy:
      spec.truncation?.strategy === "none" ? undefined : spec.truncation?.strategy,
    truncationConfig: resolveTruncationConfig(spec.truncation),
    // Filesystem mounts (informational for the template; tools are harness builtins)
    sessionStorageMountPath: spec.sessionStoragePath,
    efsMounts: (spec.efsAccessPoints ?? []).map(({ mountPath }) => ({ mountPath })),
    s3Mounts: (spec.s3AccessPoints ?? []).map(({ mountPath }) => ({ mountPath })),
    needsOs:
      !!spec.sessionStoragePath ||
      (spec.efsAccessPoints?.length ?? 0) > 0 ||
      (spec.s3AccessPoints?.length ?? 0) > 0,
  };

  const runtime: ProjectRuntime = {
    name: targetAgentName,
    build: "CodeZip",
    entrypoint: "main.py",
    codeLocation: `app/${targetAgentName}` as ProjectRuntime["codeLocation"],
    protocol: "HTTP",
    runtimeVersion: "PYTHON_3_14",
    ...(envVars.length > 0 && { envVars }),
    ...(spec.networkMode && { networkMode: spec.networkMode }),
    ...(networkConfig && { networkConfig }),
    ...(spec.authorizerType && { authorizerType: spec.authorizerType }),
    ...(spec.authorizerConfiguration && {
      authorizerConfiguration: spec.authorizerConfiguration,
    }),
    ...(spec.lifecycleConfig && { lifecycleConfiguration: spec.lifecycleConfig }),
    ...(filesystemConfigurations.length > 0 && { filesystemConfigurations }),
    ...(additionalPolicies.length > 0 && { additionalPolicies }),
    ...(connections.length && { connections }),
    ...(roleSource && {
      executionRoleConfig: {
        policyMode: "explicit",
        ...(roleSource.permissionsBoundaryArn && {
          permissionsBoundaryArn: roleSource.permissionsBoundaryArn,
        }),
        tags: roleSource.tags,
      },
    }),
    ...(spec.tags && { tags: spec.tags }),
    // NOTE: the harness's executionRoleArn is deliberately NOT carried over. The
    // exported agent is a new runtime that needs its own CDK-managed role so the
    // construct can attach the runtime baseline, additionalPolicies, and grants.
  };

  return {
    context,
    runtime,
    credentials,
    envEntries,
    policyFiles,
    hasMemory: memory.provider !== undefined,
    notes,
  };
}

// ============================================================================
// Model
// ============================================================================

interface ModelResolution {
  context: Record<string, unknown>;
  policyFile?: { name: string; doc: unknown };
}

/** A Bedrock model whose apiFormat routes it through the OpenAI-compatible Mantle endpoint. */
function isBedrockMantleModel(spec: HarnessSpec): boolean {
  return (
    spec.model.provider === "bedrock" &&
    (spec.model.apiFormat === "responses" || spec.model.apiFormat === "chat_completions")
  );
}

/**
 * Proprietary OpenAI models (e.g. openai.gpt-5.x) are served on the Bedrock
 * Mantle `/openai/v1` path; open-source ones (openai.gpt-oss-*) use `/v1`.
 */
function isProprietaryOpenAiModel(modelId: string): boolean {
  return modelId.startsWith("openai.") && !modelId.includes("gpt-oss");
}

function resolveModel(
  spec: HarnessSpec,
  notes: ExportNote[],
  serviceAdditionalParams: Record<string, unknown> | undefined,
): ModelResolution {
  const model = spec.model;
  const additionalParams = serviceAdditionalParams ?? model.additionalParams;
  const context: Record<string, unknown> = {
    modelId: model.modelId,
    modelApiFormat: model.apiFormat,
    // Provider-specific parameters, passed through to the model provider unchanged.
    modelAdditionalParams:
      additionalParams && Object.keys(additionalParams).length > 0 ? additionalParams : undefined,
    // Stringified so a legal 0 (temperature/topP) stays truthy for {{#if}}.
    modelMaxTokens: model.maxTokens !== undefined ? String(model.maxTokens) : undefined,
    modelTemperature: model.temperature !== undefined ? String(model.temperature) : undefined,
    modelTopP: model.topP !== undefined ? String(model.topP) : undefined,
    modelTopK: model.topK !== undefined ? String(model.topK) : undefined,
    hasIdentity: false,
    identityProviders: [] as { name: string; envVarName: string }[],
  };

  switch (model.provider) {
    case "bedrock": {
      context.modelProvider = "Bedrock";
      if (isBedrockMantleModel(spec)) {
        context.bedrockMantle = true;
        context.strandsExtras = "openai";
        context.mantleApiFormat = model.apiFormat;
        context.mantleProprietary = isProprietaryOpenAiModel(model.modelId);
        // Mantle is invoked via the bedrock-mantle service, not bedrock:InvokeModel,
        // so the runtime role's default Bedrock grant is insufficient.
        return {
          context,
          policyFile: {
            name: "bedrock-mantle-policy.json",
            doc: {
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: "bedrock-mantle:CreateInference",
                  Resource: "arn:aws:bedrock-mantle:*:*:project/default",
                },
                {
                  Effect: "Allow",
                  Action: "bedrock-mantle:CallWithBearerToken",
                  Resource: "*",
                },
              ],
            },
          },
        };
      }
      const guardrail = (additionalParams?.guardrailConfig as { guardrailIdentifier?: unknown })
        ?.guardrailIdentifier;
      if (typeof guardrail !== "string") return { context };
      // A guardrail in the request needs bedrock:ApplyGuardrail, which the default grant lacks.
      return {
        context,
        policyFile: {
          name: "bedrock-guardrail-policy.json",
          doc: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: "bedrock:ApplyGuardrail",
                Resource: guardrail.startsWith("arn:")
                  ? guardrail
                  : `arn:aws:bedrock:*:*:guardrail/${guardrail}`,
              },
            ],
          },
        },
      };
    }
    case "open_ai":
    case "gemini": {
      context.modelProvider = model.provider === "open_ai" ? "OpenAI" : "Gemini";
      context.strandsExtras = model.provider === "open_ai" ? "openai" : "gemini";
      // The schema guarantees apiKeyArn for these providers.
      attachIdentityProvider(context, model.apiKeyArn!, notes);
      return { context };
    }
    case "lite_llm": {
      context.modelProvider = "LiteLLM";
      context.strandsExtras = "litellm";
      if (model.apiBase) context.litellmApiBase = model.apiBase;
      if (model.apiKeyArn) {
        attachIdentityProvider(context, model.apiKeyArn, notes);
      } else if (!model.modelId.startsWith("bedrock/")) {
        // A bedrock/... LiteLLM model authenticates via the execution role; any
        // other keyless provider prefix typically fails at first invocation.
        notes.push({
          category: LITELLM_NO_API_KEY_NOTE_CATEGORY,
          message:
            `The LiteLLM model "${model.modelId}" is not a Bedrock-backed (bedrock/...) model, but ` +
            `the harness has no apiKeyArn. The exported agent constructs LiteLLMModel without an ` +
            `API key and will fail at first invocation if the provider requires one. Add an ` +
            `API-key credential to the harness (model apiKeyArn), or use a bedrock/ model id ` +
            `(which authenticates via the execution role).`,
        });
      }
      return { context };
    }
  }
}

/**
 * Wire a non-Bedrock model's API key through AgentCore Identity: derive the
 * credential-provider name from the token-vault ARN, reference it from the
 * generated load.py without provisioning a replacement provider.
 */
function attachIdentityProvider(
  context: Record<string, unknown>,
  apiKeyArn: string,
  notes: ExportNote[],
): void {
  // ARN form: arn:aws:bedrock-agentcore:<region>:<acct>:token-vault/<vault>/apikeycredentialprovider/<name>
  const reference = apiKeyProviderReference(apiKeyArn);
  const credentialName = reference.name;
  const envVarName = credentialEnvVarName(credentialName);

  context.hasIdentity = true;
  context.identityProviders = [{ name: credentialName, envVarName }];

  notes.push({
    category: MODEL_API_KEY_NOTE_CATEGORY,
    message:
      `The harness model authenticates with the AgentCore Identity API-key provider ` +
      `"${credentialName}" (${reference.arn}). The existing provider is retained; no replacement ` +
      `provider or secret is created or read during export. Ensure the new runtime principal can ` +
      `use it in the provider's account and region. Local development can use ${envVarName}.`,
  });
}

// ============================================================================
// Memory
// ============================================================================

interface MemoryResolution {
  provider?: { name: string; envVarName: string; strategies: string[] };
  actorId?: string;
  retrievalConfig?: HarnessMemoryRetrievalConfig;
  region?: string;
  namespaceConfig?: MemoryRetrievalConfig;
}

function resolveMemory(
  spec: HarnessSpec,
  projectSpec: ProjectSpec,
  notes: ExportNote[],
  connections: Connection[],
): MemoryResolution {
  const memory: HarnessMemoryRef | undefined = spec.memory;
  if (!memory || memory.mode === "disabled") return {};

  if (memory.mode === "managed") {
    notes.push({
      category: MEMORY_MANAGED_NOTE_CATEGORY,
      message:
        "The harness used managed memory, which the service provisions and owns. The exported " +
        "agent has no memory wired. Add a project memory (`agentcore add memory`) and " +
        "re-run the export, or wire memory/session.py to an existing AgentCore Memory by hand.",
    });
    return {};
  }

  // mode === "existing"
  if (memory.name) {
    const entry: Memory | undefined = projectSpec.memories.find((m) => m.name === memory.name);
    if (!entry) {
      notes.push({
        category: MEMORY_NAME_NOT_FOUND_NOTE_CATEGORY,
        message:
          `The harness references the project memory "${memory.name}", but no memory with that ` +
          `name exists in agentcore.json, so the exported agent has no memory wired. Add the ` +
          `memory to the project and re-export, or wire memory/session.py by hand.`,
      });
      return { actorId: memory.actorId };
    }
    if (memory.messagesCount !== undefined) {
      notes.push({
        category: MEMORY_MESSAGES_COUNT_NOTE_CATEGORY,
        message:
          `The harness restored at most ${memory.messagesCount} short-term memory messages. ` +
          "AgentCoreMemorySessionManager restores the available session history and does not expose " +
          "an equivalent message-count setting; use conversation truncation or customize " +
          "memory/session.py if the exact restore limit is required.",
      });
    }
    return {
      provider: {
        name: entry.name,
        envVarName: memoryEnvVarName(entry.name),
        strategies: entry.strategies.map(({ type }) => type),
      },
      actorId: memory.actorId,
      retrievalConfig: memory.retrievalConfig,
      namespaceConfig: Object.fromEntries(
        entry.strategies.flatMap((strategy) =>
          (strategy.namespaceTemplates ?? strategy.namespaces ?? []).map((namespace) => [
            namespace,
            memory.retrievalConfig ?? {},
          ]),
        ),
      ),
    };
  }

  if (memory.arn) {
    const connection = addConnection(connections, { type: "memory", arn: memory.arn }, "readwrite");
    if (memory.messagesCount !== undefined) {
      notes.push({
        category: MEMORY_MESSAGES_COUNT_NOTE_CATEGORY,
        message: `The source restored at most ${memory.messagesCount} messages. The Strands session manager restores available session history and has no equivalent message-count setting; historic session format parity is not guaranteed.`,
      });
    }
    notes.push({
      category: MEMORY_ARN_NOTE_CATEGORY,
      message:
        `The exported runtime references the existing memory ${memory.arn} using native CDK binding. ` +
        `The memory stays source-owned; no data is migrated and historic session format parity is not guaranteed. ` +
        `Actor/session isolation uses the configured actor or Runtime user-id header; caller-provided headers are not authorization proof.`,
    });
    return {
      provider: {
        name: connection.id ?? connectionIdForTarget(connection.to),
        envVarName: `AGENTCORE_MEMORY_${connectionTokenFor(connection)}_ID`,
        strategies: [],
      },
      actorId: memory.actorId,
      region: regionFromArn(memory.arn),
    };
  }
  return { actorId: memory.actorId };
}

// ============================================================================
// Tools
// ============================================================================

interface ToolsResolution {
  inlineFunctionTools: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }[];
  remoteMcpTools: {
    name: string;
    pythonName: string;
    url: string;
    urlEnvVar?: string;
    awsRegion?: string;
    awsIam?: boolean;
    /** Tool patterns from `@server/tool` selectors; undefined loads every tool of the server. */
    toolPatterns?: string[];
    headerCredentials?: {
      headerKey: string;
      credentialName: string;
      envVarName: string;
      pythonName: string;
      existing?: boolean;
      prefix?: string;
      suffix?: string;
    }[];
  }[];
  hasShell: boolean;
  hasFileOperations: boolean;
}

function resolveTools(
  spec: HarnessSpec,
  allowedPatterns: string[],
  projectSpec: ProjectSpec,
  credentials: Credential[],
  envEntries: EnvLocalEntry[],
  notes: ExportNote[],
  connections: Connection[],
): ToolsResolution {
  const result: ToolsResolution = {
    inlineFunctionTools: [],
    remoteMcpTools: [],
    // Builtin tools are always available in the harness runtime; include them
    // unless the allowedTools filter excludes them.
    hasShell: isBuiltinIncluded("shell", allowedPatterns),
    hasFileOperations: isBuiltinIncluded("file_operations", allowedPatterns),
  };

  for (const tool of spec.tools) {
    const allowed =
      tool.type === "inline_function"
        ? matchesAllowedTools(tool.name, tool.name, allowedPatterns)
        : isServerAllowed(tool.name, allowedPatterns);
    if (!allowed) continue;

    switch (tool.type) {
      case "inline_function": {
        const cfg = configOf(tool, "inlineFunction") as
          { description: string; inputSchema: Record<string, unknown> } | undefined;
        if (cfg) {
          result.inlineFunctionTools.push({
            name: tool.name,
            description: cfg.description,
            inputSchema: cfg.inputSchema,
          });
        }
        break;
      }
      case "remote_mcp": {
        const cfg = configOf(tool, "remoteMcp") as
          { url: string; headers?: Record<string, string> } | undefined;
        if (!cfg) break;
        const headerKeys = Object.keys(cfg.headers ?? {});
        let headerCredentials: ToolsResolution["remoteMcpTools"][number]["headerCredentials"];
        const toolPythonName = stablePythonIdentifier(tool.name);
        if (headerKeys.length > 0) {
          headerCredentials = [];
          for (const headerKey of headerKeys) {
            const value = cfg.headers![headerKey] ?? "";
            if (value.includes("${")) {
              const placeholder = /^([^$]*)\$\{arn:(arn:[^{}]+)\}([^$]*)$/.exec(value);
              if (!placeholder?.[2])
                throw new InputValidationError(
                  `Unsupported credential template in MCP header "${headerKey}" on "${tool.name}"; authentication cannot be downgraded.`,
                );
              const reference = apiKeyProviderReference(placeholder[2]);
              headerCredentials.push({
                headerKey,
                credentialName: reference.name,
                envVarName: credentialEnvVarName(reference.name),
                pythonName: stablePythonIdentifier(`${tool.name}-${headerKey}`),
                existing: true,
                prefix: placeholder[1] ?? "",
                suffix: placeholder[3] ?? "",
              });
              continue;
            }
            const credentialName = remoteMcpCredentialName(projectSpec.name, tool.name, headerKey);
            const envVarName = credentialEnvVarName(credentialName);
            headerCredentials.push({
              headerKey,
              credentialName,
              envVarName,
              pythonName: stablePythonIdentifier(`${tool.name}-${headerKey}`),
            });
            if (
              !projectSpec.credentials.some((c) => c.name === credentialName) &&
              !credentials.some((c) => c.name === credentialName)
            ) {
              credentials.push({
                authorizerType: "ApiKeyCredentialProvider",
                name: credentialName,
              });
            }
            envEntries.push({
              key: envVarName,
              value,
              comment: `"${headerKey}" header for MCP tool "${tool.name}" (exported from harness "${spec.name}")`,
            });
          }
          notes.push({
            category: MCP_HEADER_CREDS_NOTE_CATEGORY,
            message:
              `MCP tool "${tool.name}" sends request headers whose values are managed via ` +
              `AgentCore Identity. Existing ARN placeholders retain their original provider names. ` +
              (headerCredentials.some((header) => !header.existing)
                ? "Literal header values were written to agentcore/.env.local with new credential entries. "
                : "No credentials or secret values were created during export. ") +
              `Ensure each named API-key credential provider ` +
              `exists in AgentCore Identity in its original account and region before invoking the exported runtime. ` +
              `Captured application policies stay authoritative; policy owners may need to grant the new principal access.\n\n` +
              headerCredentials
                .map((h) => `  ${h.credentialName}  (env var: ${h.envVarName})`)
                .join("\n"),
          });
        }
        result.remoteMcpTools.push({
          name: tool.name,
          pythonName: toolPythonName,
          url: cfg.url,
          headerCredentials,
          toolPatterns: serverToolPatterns(tool.name, allowedPatterns),
        });
        break;
      }
      case "agentcore_gateway": {
        const cfg = configOf(tool, "agentCoreGateway") as
          | {
              gatewayArn?: string;
              outboundAuth?: { awsIam?: object; none?: object; oauth?: object };
            }
          | undefined;
        if (!cfg?.gatewayArn || cfg.outboundAuth?.oauth) {
          notes.push({
            category: GATEWAY_TOOL_NOTE_CATEGORY,
            message: `Gateway tool "${tool.name}"${cfg?.gatewayArn ? ` (${cfg.gatewayArn})` : ""} was not exported: OAuth/user-consent or incomplete gateway configuration is unsupported. No authentication downgrade was made.`,
          });
          break;
        }
        const outboundAuth = cfg.outboundAuth?.none ? { none: {} } : { awsIam: {} };
        const connection = addConnection(connections, {
          type: "gateway",
          arn: cfg.gatewayArn,
          outboundAuth,
        });
        result.remoteMcpTools.push({
          name: tool.name,
          pythonName: stablePythonIdentifier(tool.name),
          url: "",
          urlEnvVar: `AGENTCORE_GATEWAY_${connectionTokenFor(connection)}_URL`,
          awsIam: !cfg.outboundAuth?.none,
          awsRegion: regionFromArn(cfg.gatewayArn),
          toolPatterns: serverToolPatterns(tool.name, allowedPatterns),
        });
        break;
      }
      case "agentcore_browser": {
        notes.push({
          category: BROWSER_TOOL_NOTE_CATEGORY,
          message:
            `The browser tool "${tool.name}" was not exported. Standalone Strands agents drive ` +
            `AgentCore Browser via strands-agents-tools (AgentCoreBrowser), which needs a ` +
            `Container build, the browser identifier, and bedrock-agentcore browser permissions ` +
            `on the runtime role. Add the dependency and tool wiring in main.py manually if you ` +
            `need it.`,
        });
        break;
      }
      case "agentcore_code_interpreter": {
        notes.push({
          category: CODE_INTERPRETER_TOOL_NOTE_CATEGORY,
          message:
            `The code-interpreter tool "${tool.name}" was not exported. Standalone Strands agents ` +
            `use strands-agents-tools (AgentCoreCodeInterpreter), which needs the interpreter ` +
            `identifier and bedrock-agentcore code-interpreter permissions on the runtime role. ` +
            `Add the dependency and tool wiring in main.py manually if you need it.`,
        });
        break;
      }
    }
  }

  return result;
}

function undefinedIfEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function configOf(tool: HarnessTool, key: string): unknown {
  if (!tool.config || !(key in tool.config)) return undefined;
  return (tool.config as Record<string, unknown>)[key];
}

function stablePythonIdentifier(value: string): string {
  const readable =
    value
      .replace(/[^a-zA-Z0-9]/g, "_")
      .toLowerCase()
      .slice(0, 48) || "value";
  return `${readable}_${shortHash(value)}`;
}

function remoteMcpCredentialName(projectName: string, toolName: string, headerKey: string): string {
  const readable = `${projectName}Mcp${toolName}${headerKey}`.replace(/[^a-zA-Z0-9_-]/g, "");
  const suffix = `-${shortHash(`${toolName}\0${headerKey}`)}`;
  return `${readable.slice(0, 128 - suffix.length)}${suffix}`;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

// ============================================================================
// Skills
// ============================================================================

interface SkillsResolution {
  hasSkillsFetcher: boolean;
  hasFetchedSkills: boolean;
  pathSkills: string[];
  s3Skills: string[];
  gitSkills: { url: string; path?: string; credentialArn?: string; username?: string }[];
  policyFiles: Record<string, unknown>;
}

export function isPathSkill(skill: HarnessSkill): skill is HarnessSkillPathSource {
  return "path" in skill && !("gitUrl" in skill);
}

function isS3Skill(skill: HarnessSkill): skill is HarnessSkillS3Source {
  return "s3Uri" in skill;
}

function isGitSkill(skill: HarnessSkill): skill is HarnessSkillGitSource {
  return "gitUrl" in skill;
}

function isAwsSkill(skill: HarnessSkill): skill is HarnessSkillAwsSkillsSource {
  return "awsSkills" in skill;
}

function resolveSkills(spec: HarnessSpec, notes: ExportNote[]): SkillsResolution {
  const pathSkills = spec.skills.filter(isPathSkill).map((s) => s.path);
  const s3SkillSources = spec.skills.filter(isS3Skill);
  const gitSkillSources = spec.skills.filter(isGitSkill);
  const awsSkills = spec.skills.filter(isAwsSkill);
  const policyFiles: Record<string, unknown> = {};

  // A path skill is a directory on the harness image's filesystem. The exported agent runs on the
  // managed runtime with no such image, so the files would simply be absent at invocation.
  if (pathSkills.length > 0) {
    throw new InputValidationError(
      `Harness "${spec.name}" uses path-based skills (${pathSkills.join(", ")}), which export ` +
        `does not support: the exported agent has no container filesystem to read them from. ` +
        `Republish those skills from s3 or git, then export again.`,
    );
  }

  // The agent fetches S3 skills with boto3 at runtime, so the runtime execution
  // role needs S3 read access the managed harness never granted.
  if (s3SkillSources.length > 0) {
    const malformedUris: string[] = [];
    const objectResources: string[] = [];
    const bucketResources: string[] = [];
    for (const { s3Uri } of s3SkillSources) {
      const parsed = parseS3SkillArns(s3Uri);
      if (!parsed) {
        malformedUris.push(s3Uri);
        continue;
      }
      if (!objectResources.includes(parsed.objectArn)) objectResources.push(parsed.objectArn);
      if (!bucketResources.includes(parsed.bucketArn)) bucketResources.push(parsed.bucketArn);
    }
    if (malformedUris.length > 0) {
      notes.push({
        category: MALFORMED_S3_SKILL_NOTE_CATEGORY,
        message:
          `These S3 skill URIs could not be parsed into a bucket, so no S3 read permission was ` +
          `generated for them: ${malformedUris.map((u) => `"${u}"`).join(", ")}. The exported ` +
          `agent still attempts to fetch these skills at runtime and will fail with S3 ` +
          `AccessDenied. Fix the s3Uri values (expected \`s3://<bucket>/<prefix>\`) on this ` +
          `agent in agentcore/agentcore.json and re-deploy.`,
      });
    }
    if (objectResources.length > 0) {
      policyFiles["s3-skills-policy.json"] = {
        Version: "2012-10-17",
        Statement: [
          { Effect: "Allow", Action: "s3:GetObject", Resource: objectResources },
          { Effect: "Allow", Action: "s3:ListBucket", Resource: bucketResources },
        ],
      };
    }
  }

  // Private git skills retain the source provider rather than provisioning a replacement.
  const seenGitCredentials = new Set<string>();
  for (const skill of gitSkillSources) {
    const reference = skill.auth?.credentialArn ?? skill.auth?.credentialName;
    if (!reference) continue;
    const resolved = skill.auth?.credentialArn
      ? apiKeyProviderReference(reference)
      : { name: reference, arn: reference };
    const name = resolved.name;
    if (seenGitCredentials.has(name)) continue;
    seenGitCredentials.add(name);
    notes.push({
      category: GIT_SKILLS_AUTH_NOTE_CATEGORY,
      message:
        `The git skill ${skill.gitUrl} clones with the AgentCore Identity credential provider ` +
        `"${name}" (${resolved.arn}). Its existing identity is retained; no replacement provider, secret read or ` +
        `token minting occurs during export. The new runtime principal may require owner-granted access.`,
    });
  }

  if (awsSkills.length > 0) {
    const patterns = awsSkills.map((s) => s.awsSkills.paths?.join(", ") ?? "all").join("; ");
    notes.push({
      category: AWS_SKILLS_NOTE_CATEGORY,
      message:
        `AWS skills are a managed harness feature and are not available in standalone Strands ` +
        `agents. The following skill patterns have been omitted: ${patterns}. You can copy the ` +
        `equivalent skills from https://github.com/aws/agent-toolkit-for-aws/tree/main/skills ` +
        `into your project and load them as path or git skills instead.`,
    });
  }

  return {
    hasSkillsFetcher: spec.skills.length > 0,
    hasFetchedSkills: s3SkillSources.length > 0 || gitSkillSources.length > 0,
    pathSkills,
    s3Skills: s3SkillSources.map((s) => s.s3Uri),
    gitSkills: gitSkillSources.map((s) => ({
      url: s.gitUrl,
      ...(s.path && { path: s.path }),
      ...((s.auth?.credentialArn ?? s.auth?.credentialName) && {
        credentialArn: s.auth!.credentialArn
          ? apiKeyProviderReference(s.auth!.credentialArn).arn
          : s.auth!.credentialName,
      }),
      ...(s.auth?.username && { username: s.auth.username }),
    })),
    policyFiles,
  };
}

function apiKeyProviderReference(value: string): { arn: string; name: string } {
  const arn = /^\$\{arn:(arn:[^{}]+)\}$/.exec(value)?.[1] ?? value;
  if (
    !/^arn:[^:]+:bedrock-agentcore:[a-z0-9-]+:\d{12}:token-vault\/[^/]+\/apikeycredentialprovider\/[^/{}]+$/.test(
      arn,
    )
  ) {
    throw new InputValidationError(
      "Unsupported API-key provider reference; export requires an existing API-key provider ARN, not an arbitrary template or OAuth flow.",
    );
  }
  return { arn, name: resourceNameFromArn(arn) };
}

function addConnection(
  connections: Connection[],
  to: ConnectionTarget,
  access?: Connection["access"],
): Connection {
  const existing = connections.find(
    (connection) =>
      connection.to.type === to.type &&
      "arn" in connection.to &&
      "arn" in to &&
      connection.to.arn === to.arn,
  );
  if (existing) return existing;
  const connection = { id: connectionIdForTarget(to), to, ...(access && { access }) };
  if (
    connections.some(
      (candidate) => connectionTokenFor(candidate) === connectionTokenFor(connection),
    )
  ) {
    throw new InputValidationError(
      `Connection discovery name collides for ${connection.id}; configure distinct connection ids.`,
    );
  }
  connections.push(connection);
  return connection;
}

/**
 * Parse an s3:// skill URI into its bucket and object ARNs (undefined when the
 * URI has no bucket). S3 ARNs are region/account-less.
 */
export function parseS3SkillArns(
  s3Uri: string,
): { bucket: string; bucketArn: string; objectArn: string } | undefined {
  const withoutScheme = s3Uri.replace(/^s3:\/\//, "");
  const [bucket, ...prefixParts] = withoutScheme.split("/");
  if (!bucket) return undefined;
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const prefix = prefixParts.join("/").replace(/\/+$/, "");
  const objectArn = prefix ? `${bucketArn}/${prefix}/*` : `${bucketArn}/*`;
  return { bucket, bucketArn, objectArn };
}

// ============================================================================
// Filesystem mounts
// ============================================================================

function buildFilesystemConfigurations(
  spec: HarnessSpec,
): NonNullable<ProjectRuntime["filesystemConfigurations"]> {
  return [
    ...(spec.sessionStoragePath
      ? [{ sessionStorage: { mountPath: spec.sessionStoragePath } }]
      : []),
    ...(spec.efsAccessPoints ?? []).map((efsAccessPoint) => ({ efsAccessPoint })),
    ...(spec.s3AccessPoints ?? []).map((s3FilesAccessPoint) => ({ s3FilesAccessPoint })),
  ];
}

// ============================================================================
// Truncation
// ============================================================================

function resolveTruncationConfig(
  truncation: HarnessTruncationConfig | undefined,
): Record<string, unknown> | undefined {
  if (!truncation?.config) return undefined;
  const { strategy, config } = truncation;
  if (strategy === "sliding_window" && "slidingWindow" in config) {
    const sw = config.slidingWindow;
    return sw?.messagesCount !== undefined ? { window_size: sw.messagesCount } : undefined;
  }
  if (strategy === "summarization" && "summarization" in config) {
    const s = config.summarization as Record<string, unknown>;
    const keyMap: Record<string, string> = {
      summaryRatio: "summary_ratio",
      preserveRecentMessages: "preserve_recent_messages",
      summarizationSystemPrompt: "summarization_system_prompt",
    };
    const out = Object.fromEntries(
      Object.entries(keyMap)
        .filter(([key]) => s[key] !== undefined)
        .map(([key, target]) => [target, s[key]]),
    );
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}

// ============================================================================
// allowedTools matching (mirrors the harness runtime's _matches() semantics)
// ============================================================================

/**
 * Whether allowedTools allows `tool` from `server`: builtins are served by "builtin", and each
 * customer tool by its harness tool name. A bare pattern is a glob over builtin names ("shell",
 * "file_*"); "@server" and "@server/tool" glob a server and its tools; "*" allows everything.
 */
export function matchesAllowedTools(server: string, tool: string, patterns: string[]): boolean {
  if (patterns.includes("*")) return true;
  return patterns.some((pattern) => {
    const [pServer, pTool] = pattern.startsWith("@")
      ? splitServerPattern(pattern)
      : ["builtin", pattern];
    return fnmatch(pServer, server) && fnmatch(pTool, tool);
  });
}

/**
 * Whether allowedTools allows any tool from `server`. A server's tools are only known at runtime,
 * so an MCP server is narrowed to them when it loads (see serverToolPatterns).
 */
function isServerAllowed(server: string, patterns: string[]): boolean {
  if (patterns.includes("*")) return true;
  return patterns.some(
    (pattern) => pattern.startsWith("@") && fnmatch(splitServerPattern(pattern)[0], server),
  );
}

/** The tool patterns `@server/tool` selectors name, or undefined when all tools are allowed. */
function serverToolPatterns(server: string, patterns: string[]): string[] | undefined {
  const toolPatterns: string[] = [];
  for (const pattern of patterns) {
    if (pattern === "*") return undefined;
    if (!pattern.startsWith("@")) continue;
    const [pServer, pTool] = splitServerPattern(pattern);
    if (!fnmatch(pServer, server)) continue;
    if (pTool === "*") return undefined;
    toolPatterns.push(pTool);
  }
  return toolPatterns;
}

function isBuiltinIncluded(builtinName: string, patterns: string[]): boolean {
  return matchesAllowedTools("builtin", builtinName, patterns);
}

/** Split "@server/tool" into its server and tool globs; "@server" allows every tool. */
function splitServerPattern(pattern: string): [string, string] {
  const slash = pattern.indexOf("/");
  return slash === -1
    ? [pattern.slice(1), "*"]
    : [pattern.slice(1, slash), pattern.slice(slash + 1)];
}

function fnmatch(pattern: string, str: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return re.test(str);
}

// ============================================================================
// EXPORT_NOTES.md + display formatting
// ============================================================================

/** Render the EXPORT_NOTES.md content written into the exported agent's directory. */
export function buildExportNotesMarkdown(
  notes: ExportNote[],
  harnessName: string,
  agentName: string,
  strandsVersion: string,
): string {
  const today = new Date().toISOString().split("T")[0];
  const lines: string[] = [
    `# Export Notes — ${harnessName} → ${agentName}`,
    "",
    `Exported on: ${today}`,
    `Strands version: ${strandsVersion}`,
    `Source harness: ${harnessName}`,
    `Generated agent: app/${agentName}/`,
    "",
  ];

  if (notes.length === 0) {
    lines.push("No manual steps required.");
  } else {
    lines.push("## Items requiring manual follow-up");
    for (const note of notes) {
      lines.push("", `### ${note.category}`, note.message);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Format export notes into styled lines for the export success path. Pure so the
 * CLI (and a future TUI screen) render identical wording.
 */
export function formatExportNotes(notes: ExportNote[], notesFileHint: string): ExportNoteLine[] {
  if (notes.length === 0) {
    return [{ text: `No manual follow-up required. (Details: ${notesFileHint})`, tone: "dim" }];
  }

  const label = notes.length === 1 ? "note" : "notes";
  const lines: ExportNoteLine[] = [
    { text: `${notes.length} export ${label} requiring manual follow-up:`, tone: "warn" },
  ];
  for (const note of notes) {
    lines.push({ text: `  - ${note.category}`, tone: "warn" });
    for (const messageLine of note.message.split("\n")) {
      lines.push({ text: `    ${messageLine}`, tone: "dim" });
    }
  }
  lines.push({ text: `These notes are also saved to ${notesFileHint}`, tone: "dim" });
  return lines;
}
