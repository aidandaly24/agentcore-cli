import type {
  Harness,
  HarnessSkill as ApiHarnessSkill,
} from "@aws-sdk/client-bedrock-agentcore-control";
import z from "zod";
import { InputValidationError, MalformedServiceResponseError } from "../../../errors";
import { HarnessSpecSchema, type HarnessSpec } from "../../../projectSchemas/harness";
import type { ExportNote } from "../../../core/project/templates/export";

export const SERVICE_FIELD_OMITTED_NOTE_CATEGORY = "Service harness field not exported";
export const MEMORY_TUNING_NOTE_CATEGORY = "Harness memory tuning requires manual follow-up";

function parseHarnessArn(arn: string): { region: string; harnessId: string } {
  const match = /^arn:[^:]+:bedrock-agentcore:([a-z0-9-]+):(\d{12}):harness\/([^/]+)$/.exec(arn);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new InputValidationError(
      `"${arn}" is not a valid harness ARN ` +
        "(expected arn:<partition>:bedrock-agentcore:<region>:<account>:harness/<id>)",
    );
  }
  return { region: match[1], harnessId: match[3] };
}

/** Extract the harness id from a validated harness ARN. */
export function harnessIdFromArn(arn: string): string {
  return parseHarnessArn(arn).harnessId;
}

/**
 * The region embedded in a harness ARN (`arn:<partition>:bedrock-agentcore:<region>:...`).
 * The harness lives in this region, so it takes precedence over the CLI's resolved
 * region for the export fetch.
 */
export function regionFromHarnessArn(arn: string): string {
  return parseHarnessArn(arn).region;
}

/**
 * Map a control-plane Harness (GetHarness response) onto the local
 * {@link HarnessSpecSchema} shape, so the `--arn` path feeds the export mapper
 * exactly like an in-project harness. Throws when the payload cannot be
 * expressed as a valid local spec.
 */
export function mapServiceHarnessToSpec(harness: Harness): {
  spec: HarnessSpec;
  notes: ExportNote[];
} {
  const notes: ExportNote[] = [];
  const promptBlocks: { text: string }[] = [];
  for (const block of harness.systemPrompt ?? []) {
    if ("text" in block && typeof block.text === "string" && block.text.trim().length > 0) {
      promptBlocks.push({ text: block.text });
      continue;
    }
    const unknown = unknownMemberName(block);
    notes.push({
      category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
      message:
        `A system prompt block${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
        "its service payload was unknown or incomplete.",
    });
  }

  const candidate = clean({
    name: harness.harnessName,
    model: mapModel(harness.model, notes),
    systemPrompt: promptBlocks.length ? promptBlocks : undefined,
    tools: (harness.tools ?? []).map((tool) =>
      clean({
        type: tool.type,
        name: tool.name ?? tool.type,
        config: tool.config,
      }),
    ),
    skills: (harness.skills ?? [])
      .map((skill) => mapSkill(skill, notes))
      .filter((skill) => skill !== undefined),
    allowedTools: harness.allowedTools,
    memory: mapMemory(harness.memory, notes),
    maxIterations: harness.maxIterations ?? undefined,
    maxTokens: harness.maxTokens ?? undefined,
    timeoutSeconds: harness.timeoutSeconds ?? undefined,
    truncation: harness.truncation,
    environmentArtifact: mapEnvironmentArtifact(harness.environmentArtifact, notes),
    environmentVariables: harness.environmentVariables,
    // The harness's executionRoleArn is deliberately NOT carried: the exported
    // agent is a new runtime that gets its own CDK-managed execution role.
    environment: mapRuntimeEnvironment(harness, notes),
    authorizerConfiguration: harness.authorizerConfiguration,
  });

  const parsed = HarnessSpecSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new MalformedServiceResponseError(
      `The fetched harness cannot be expressed as a local harness spec:\n${z.prettifyError(parsed.error)}`,
      { cause: parsed.error },
    );
  }
  return { spec: parsed.data, notes };
}

function mapModel(model: Harness["model"], notes: ExportNote[]): Record<string, unknown> {
  for (const key of [
    "bedrockModelConfig",
    "openAiModelConfig",
    "geminiModelConfig",
    "liteLlmModelConfig",
  ] as const) {
    const c = model?.[key];
    if (!c) continue;
    const config = clean({
      modelId: c.modelId,
      apiKeyArn: "apiKeyArn" in c ? c.apiKeyArn : undefined,
      apiFormat: "apiFormat" in c ? c.apiFormat : undefined,
      apiBase: "apiBase" in c ? c.apiBase : undefined,
      temperature: c.temperature,
      topP: c.topP,
      topK: "topK" in c ? c.topK : undefined,
      maxTokens: c.maxTokens,
      additionalParams: key === "liteLlmModelConfig" ? c.additionalParams : undefined,
    });
    if (key !== "liteLlmModelConfig" && c.additionalParams !== undefined) {
      notes.push({
        category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
        message:
          `The harness model's additionalParams were omitted because they are only supported for ` +
          `liteLlmModelConfig (this harness uses ${key}). Set the equivalent options ` +
          `directly in the generated model/load.py if the exported agent needs them.`,
      });
    }
    return { [key]: config };
  }
  throw new MalformedServiceResponseError(
    "The fetched harness has no recognized model configuration.",
  );
}

function mapSkill(
  skill: ApiHarnessSkill,
  notes: ExportNote[],
): Record<string, unknown> | undefined {
  if ("path" in skill && skill.path) return { path: skill.path };
  if ("s3" in skill && skill.s3?.uri) return { s3: { uri: skill.s3.uri } };
  if ("git" in skill && skill.git?.url) {
    const { url, path, auth } = skill.git;
    return {
      git: clean({
        url,
        path,
        auth: auth?.credentialArn
          ? clean({ credentialArn: auth.credentialArn, username: auth.username })
          : undefined,
      }),
    };
  }
  if ("awsSkills" in skill && skill.awsSkills) {
    return { awsSkills: clean({ paths: skill.awsSkills.paths }) };
  }
  const unknown = unknownMemberName(skill);
  notes.push({
    category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
    message:
      `A harness skill${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
      "its service payload was unknown or incomplete.",
  });
  return undefined;
}

/**
 * Service memory union -> the local memory ref. A provisioned harness memory
 * (managed, with a service-populated ARN) is referenced by ARN like any
 * bring-your-own memory; managed-without-ARN keeps the `managed` marker so the
 * export mapper can emit its follow-up note.
 */
function mapMemory(
  memory: Harness["memory"],
  notes: ExportNote[],
): Record<string, unknown> | undefined {
  if (!memory) return undefined;
  if ("agentCoreMemoryConfiguration" in memory && memory.agentCoreMemoryConfiguration?.arn) {
    const { arn, actorId, messagesCount, retrievalConfig } = memory.agentCoreMemoryConfiguration;
    if (messagesCount !== undefined || retrievalConfig !== undefined) {
      notes.push({
        category: MEMORY_TUNING_NOTE_CATEGORY,
        message:
          `The service harness configured external memory${messagesCount !== undefined ? ` messagesCount=${messagesCount}` : ""}` +
          `${retrievalConfig !== undefined ? " with per-namespace retrieval tuning" : ""}. ` +
          "The exported runtime cannot apply those settings until the external memory is wired manually.",
      });
    }
    return { agentCoreMemoryConfiguration: clean({ arn, actorId, messagesCount }) };
  }
  if ("managedMemoryConfiguration" in memory && memory.managedMemoryConfiguration) {
    const arn = memory.managedMemoryConfiguration.arn;
    if (arn) return { agentCoreMemoryConfiguration: { arn } };
    return { managedMemoryConfiguration: {} };
  }
  if ("disabled" in memory && memory.disabled) return { disabled: {} };
  const unknown = unknownMemberName(memory);
  notes.push({
    category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
    message:
      `The harness memory configuration${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
      "the service payload was unknown or incomplete.",
  });
  return undefined;
}

/**
 * A VPC harness without explicit subnets/security groups
 * cannot be expressed locally; fail here — before anything is written — with a
 * clear message instead of a downstream schema error.
 */
function mapRuntimeEnvironment(
  harness: Harness,
  notes: ExportNote[],
): Record<string, unknown> | undefined {
  if (harness.environment && !("agentCoreRuntimeEnvironment" in harness.environment)) {
    const unknown = unknownMemberName(harness.environment);
    notes.push({
      category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
      message:
        `The harness environment${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
        "the service payload is not an AgentCore Runtime environment.",
    });
    return undefined;
  }
  const env = harness.environment?.agentCoreRuntimeEnvironment;
  if (!env) return undefined;
  const out: Record<string, unknown> = {};

  const net = env.networkConfiguration;
  if (net?.networkMode === "VPC") {
    const subnets = net.networkModeConfig?.subnets;
    const securityGroups = net.networkModeConfig?.securityGroups;
    if (!subnets?.length || !securityGroups?.length) {
      throw new InputValidationError(
        "This harness runs in a VPC but its network configuration is missing explicit subnets " +
          "and/or security groups, which the exported agent requires. Re-create the harness with " +
          "explicit VPC subnets and security groups, or export a non-VPC harness.",
      );
    }
    out.networkConfiguration = {
      networkMode: "VPC",
      networkModeConfig: { subnets, securityGroups },
    };
  } else if (net) {
    out.networkConfiguration = { networkMode: net.networkMode };
  }

  const lifecycle = env.lifecycleConfiguration;
  if (lifecycle && (lifecycle.idleRuntimeSessionTimeout != null || lifecycle.maxLifetime != null)) {
    out.lifecycleConfiguration = clean({
      idleRuntimeSessionTimeout: lifecycle.idleRuntimeSessionTimeout ?? undefined,
      maxLifetime: lifecycle.maxLifetime ?? undefined,
    });
  }

  const mounts: Record<string, unknown>[] = [];
  for (const fs of env.filesystemConfigurations ?? []) {
    if ("sessionStorage" in fs && fs.sessionStorage?.mountPath) {
      mounts.push({ sessionStorage: { mountPath: fs.sessionStorage.mountPath } });
    } else if (
      "efsAccessPoint" in fs &&
      fs.efsAccessPoint?.accessPointArn &&
      fs.efsAccessPoint.mountPath
    ) {
      mounts.push({
        efsAccessPoint: {
          accessPointArn: fs.efsAccessPoint.accessPointArn,
          mountPath: fs.efsAccessPoint.mountPath,
        },
      });
    } else if (
      "s3FilesAccessPoint" in fs &&
      fs.s3FilesAccessPoint?.accessPointArn &&
      fs.s3FilesAccessPoint.mountPath
    ) {
      mounts.push({
        s3FilesAccessPoint: {
          accessPointArn: fs.s3FilesAccessPoint.accessPointArn,
          mountPath: fs.s3FilesAccessPoint.mountPath,
        },
      });
    } else {
      const unknown = unknownMemberName(fs);
      notes.push({
        category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
        message:
          `A filesystem configuration${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
          "its service payload was unknown or incomplete.",
      });
    }
  }
  if (mounts.length) out.filesystemConfigurations = mounts;

  return { agentCoreRuntimeEnvironment: out };
}

function mapEnvironmentArtifact(
  artifact: Harness["environmentArtifact"],
  notes: ExportNote[],
): Record<string, unknown> | undefined {
  if (!artifact) return undefined;
  if ("containerConfiguration" in artifact) {
    const containerUri = artifact.containerConfiguration?.containerUri;
    if (containerUri) return { containerConfiguration: { containerUri } };
  }
  const unknown = unknownMemberName(artifact);
  notes.push({
    category: SERVICE_FIELD_OMITTED_NOTE_CATEGORY,
    message:
      `The harness environment artifact${unknown ? ` of type "${unknown}"` : ""} was omitted because ` +
      "its service payload was unknown or incomplete.",
  });
  return undefined;
}

function unknownMemberName(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("$unknown" in value)) return undefined;
  const unknown = (value as { $unknown?: unknown }).$unknown;
  return Array.isArray(unknown) && typeof unknown[0] === "string" ? unknown[0] : undefined;
}

/** Drop undefined-valued keys so optional fields stay omitted. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
