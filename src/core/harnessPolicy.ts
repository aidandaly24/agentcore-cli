import type {
  HarnessEnvironmentArtifact,
  HarnessEnvironmentProvider,
  HarnessEnvironmentProviderRequest,
  HarnessMemoryConfiguration,
  HarnessModelConfiguration,
  HarnessSkill,
  HarnessTool,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { AgentCorePolicyGrants } from "./agentCorePolicyGrants";
import type {
  CredentialProviderPolicyRequest,
  CredentialProviderPolicyState,
} from "./credentialProviderPolicy";
import { allow, type PolicyContribution } from "./executionRolePolicy";

export type HarnessPolicyState = {
  region: string;
  accountId: string;
  harnessName: string;
  model?: HarnessModelConfiguration;
  tools?: readonly HarnessTool[];
  skills?: readonly HarnessSkill[];
  memory?: HarnessMemoryConfiguration;
  environment?: HarnessEnvironmentProviderRequest | HarnessEnvironmentProvider;
  environmentArtifact?: HarnessEnvironmentArtifact;
  credentialProviders?: readonly CredentialProviderPolicyState[];
};

export class UninferrableHarnessPermissionError extends Error {
  constructor(
    readonly owner: string,
    message: string,
  ) {
    super(`Cannot infer execution-role permissions for ${owner}: ${message}`);
    this.name = "UninferrableHarnessPermissionError";
  }
}

export class HarnessPolicyPlanner {
  plan(state: HarnessPolicyState): PolicyContribution[] {
    if (containsKey(state, "$unknown")) {
      throw new UninferrableHarnessPermissionError(
        "harness",
        "configuration contains an unknown SDK union",
      );
    }
    const contributions = [
      ...this.baseline(state),
      ...this.memory(state),
      ...this.tools(state),
      ...this.skills(state),
      ...this.environment(state),
    ];
    return [...contributions, ...this.credentials(state)];
  }

  private baseline(state: HarnessPolicyState): PolicyContribution[] {
    const statements = [
      allow(["ecr-public:GetAuthorizationToken"], ["*"]),
      allow(["sts:GetServiceBearerToken"], ["*"]),
      allow(
        [
          "xray:GetSamplingRules",
          "xray:GetSamplingTargets",
          "xray:PutTelemetryRecords",
          "xray:PutTraceSegments",
        ],
        ["*"],
      ),
      allow(
        ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
        [
          `arn:aws:logs:${state.region}:${state.accountId}:log-group:/aws/bedrock-agentcore/runtimes/*`,
        ],
      ),
      allow(
        ["logs:DescribeLogGroups"],
        [`arn:aws:logs:${state.region}:${state.accountId}:log-group:*`],
      ),
      allow(
        ["logs:CreateLogStream", "logs:PutLogEvents"],
        [
          `arn:aws:logs:${state.region}:${state.accountId}:log-group:/aws/bedrock-agentcore/runtimes/*:log-stream:*`,
        ],
      ),
      allow(["cloudwatch:PutMetricData"], ["*"], {
        StringEquals: { "cloudwatch:namespace": "bedrock-agentcore" },
      }),
    ];
    const model = state.model;
    if (!model || model.bedrockModelConfig || isBedrockLiteLlmModel(model)) {
      const modelId =
        model?.bedrockModelConfig?.modelId ??
        model?.liteLlmModelConfig?.modelId?.replace(/^bedrock\//, "");
      const resources = modelId?.startsWith("arn:")
        ? [modelId]
        : [
            "arn:aws:bedrock:*::foundation-model/*",
            `arn:aws:bedrock:${state.region}:${state.accountId}:*`,
          ];
      statements.unshift(AgentCorePolicyGrants.invokeModel(resources));
      const apiFormat = model?.bedrockModelConfig?.apiFormat;
      if (apiFormat === "responses" || apiFormat === "chat_completions") {
        statements.push(
          AgentCorePolicyGrants.createMantleInference([
            `arn:aws:bedrock-mantle:${state.region}:${state.accountId}:*`,
          ]),
          AgentCorePolicyGrants.callMantleWithBearerToken(),
        );
      }
    }
    return [{ owner: "harness:baseline", reason: "run Harness", statements }];
  }

  private memory(state: HarnessPolicyState): PolicyContribution[] {
    if (state.memory?.disabled) return [];
    const arn =
      state.memory?.agentCoreMemoryConfiguration?.arn ??
      state.memory?.managedMemoryConfiguration?.arn;
    if (!arn) return [];
    return [
      {
        owner: "harness:memory",
        reason: "use Harness Memory",
        statements: [AgentCorePolicyGrants.useMemory(arn)],
      },
    ];
  }

  private tools(state: HarnessPolicyState): PolicyContribution[] {
    const contributions: PolicyContribution[] = [];
    for (const [index, tool] of (state.tools ?? []).entries()) {
      const owner = `harness:tool:${tool.name ?? index}`;
      const browser = tool.config?.agentCoreBrowser;
      if (browser) {
        contributions.push({
          owner,
          reason: "use AgentCore Browser",
          statements: [
            AgentCorePolicyGrants.useBrowser(
              browser.browserArn ?? `arn:aws:bedrock-agentcore:${state.region}:aws:browser/*`,
            ),
          ],
        });
        continue;
      }
      const codeInterpreter = tool.config?.agentCoreCodeInterpreter;
      if (codeInterpreter) {
        contributions.push({
          owner,
          reason: "use AgentCore Code Interpreter",
          statements: [
            AgentCorePolicyGrants.useCodeInterpreter(
              codeInterpreter.codeInterpreterArn ??
                `arn:aws:bedrock-agentcore:${state.region}:aws:code-interpreter/*`,
            ),
          ],
        });
        continue;
      }
      const gateway = tool.config?.agentCoreGateway;
      if (gateway) {
        if (!gateway.gatewayArn) {
          throw new UninferrableHarnessPermissionError(owner, "Gateway ARN is missing");
        }
        if (!gateway.outboundAuth || gateway.outboundAuth.awsIam) {
          contributions.push({
            owner,
            reason: "invoke AgentCore Gateway",
            statements: [AgentCorePolicyGrants.invokeGateway(gateway.gatewayArn)],
          });
        }
        continue;
      }
      if (tool.config?.inlineFunction || tool.config?.remoteMcp) continue;
      throw new UninferrableHarnessPermissionError(owner, "tool configuration is missing");
    }
    return contributions;
  }

  private skills(state: HarnessPolicyState): PolicyContribution[] {
    const contributions: PolicyContribution[] = [];
    for (const [index, skill] of (state.skills ?? []).entries()) {
      const owner = `harness:skill:${index}`;
      if (skill.awsSkills) {
        throw new UninferrableHarnessPermissionError(
          owner,
          "AWS skill actions and resources cannot be inferred",
        );
      }
      if (skill.s3) {
        const location = s3Prefix(skill.s3.uri, owner);
        contributions.push({
          owner,
          reason: "read S3 skill",
          statements: [
            allow(["s3:ListBucket"], [location.bucketArn]),
            allow(["s3:GetObject"], [location.objectArn]),
          ],
        });
      }
    }
    return contributions;
  }

  private environment(state: HarnessPolicyState): PolicyContribution[] {
    const statements = [];
    const containerUri = state.environmentArtifact?.containerConfiguration?.containerUri;
    if (containerUri) {
      const repositoryArn = ecrRepositoryArn(containerUri);
      if (repositoryArn) {
        statements.push(
          allow(["ecr:GetAuthorizationToken"], ["*"]),
          allow(
            ["ecr:BatchCheckLayerAvailability", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
            [repositoryArn],
          ),
        );
      }
    }
    const environment = state.environment?.agentCoreRuntimeEnvironment;
    for (const filesystem of environment?.filesystemConfigurations ?? []) {
      const efs = filesystem.efsAccessPoint;
      if (efs?.accessPointArn) {
        const context = arnContext(efs.accessPointArn, "harness:environment");
        statements.push(
          allow(
            ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite"],
            [
              `arn:${context.partition}:elasticfilesystem:${context.region}:${context.accountId}:file-system/*`,
            ],
            { ArnEquals: { "elasticfilesystem:AccessPointArn": efs.accessPointArn } },
          ),
          allow(
            ["elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets"],
            [
              efs.accessPointArn,
              `arn:${context.partition}:elasticfilesystem:${context.region}:${context.accountId}:file-system/*`,
            ],
          ),
        );
      }
      const s3Files = filesystem.s3FilesAccessPoint;
      if (s3Files?.accessPointArn) {
        const fileSystemArn = s3FilesFileSystemArn(s3Files.accessPointArn);
        statements.push(
          allow(["s3files:ClientMount", "s3files:ClientWrite"], [fileSystemArn], {
            ArnEquals: { "s3files:AccessPointArn": s3Files.accessPointArn },
          }),
          allow(
            [
              "s3files:GetAccessPoint",
              "s3files:GetFileSystem",
              "s3files:GetMountTarget",
              "s3files:ListMountTargets",
            ],
            ["*"],
          ),
        );
      }
    }
    return statements.length
      ? [{ owner: "harness:environment", reason: "run Harness environment", statements }]
      : [];
  }

  private credentials(state: HarnessPolicyState): PolicyContribution[] {
    const requested = harnessCredentialRequests(state);
    if (requested.length === 0) return [];
    const resolved = new Map(
      (state.credentialProviders ?? []).map((provider) => [provider.providerArn, provider]),
    );
    const directory = `arn:aws:bedrock-agentcore:${state.region}:${state.accountId}:workload-identity-directory/default`;
    const workload = `${directory}/workload-identity/harness_${state.harnessName}-*`;
    const vault = `arn:aws:bedrock-agentcore:${state.region}:${state.accountId}:token-vault/default`;
    return requested.map(({ type, arn }) => {
      const provider = resolved.get(arn);
      if (!provider?.secretArn) {
        throw new UninferrableHarnessPermissionError(
          `harness:credential:${arn}`,
          "resolved secret ARN is missing",
        );
      }
      return {
        owner: `harness:credential:${arn}`,
        reason: type === "api-key" ? "retrieve API key" : "retrieve OAuth token",
        statements: [
          AgentCorePolicyGrants.getWorkloadAccessToken([directory, workload]),
          allow(
            [
              type === "api-key"
                ? "bedrock-agentcore:GetResourceApiKey"
                : "bedrock-agentcore:GetResourceOauth2Token",
            ],
            [vault, directory, workload, arn],
          ),
          AgentCorePolicyGrants.readSecret(provider.secretArn),
        ],
      };
    });
  }
}

export function harnessCredentialProviderRequests(
  state: HarnessPolicyState,
): CredentialProviderPolicyRequest[] {
  return harnessCredentialRequests(state).map(({ type, arn }) => ({
    type,
    providerArn: arn,
  }));
}

function harnessCredentialRequests(
  state: HarnessPolicyState,
): { type: "api-key" | "oauth"; arn: string }[] {
  const requests = new Map<string, "api-key" | "oauth">();
  const modelKey =
    state.model?.openAiModelConfig?.apiKeyArn ??
    state.model?.geminiModelConfig?.apiKeyArn ??
    state.model?.liteLlmModelConfig?.apiKeyArn;
  if (modelKey) requests.set(modelKey, "api-key");
  for (const tool of state.tools ?? []) {
    const oauth = tool.config?.agentCoreGateway?.outboundAuth?.oauth?.providerArn;
    if (oauth) requests.set(oauth, "oauth");
    for (const value of Object.values(tool.config?.remoteMcp?.headers ?? {})) {
      for (const arn of credentialArns(value)) requests.set(arn, credentialType(arn));
    }
  }
  for (const skill of state.skills ?? []) {
    const arn = skill.git?.auth?.credentialArn;
    if (arn) requests.set(arn, "api-key");
  }
  return [...requests].map(([arn, type]) => ({ arn, type }));
}

function credentialArns(value: string): string[] {
  return [...value.matchAll(/\$\{(arn:[^}]+)\}/g)].map((match) => match[1]!);
}

function credentialType(arn: string): "api-key" | "oauth" {
  if (arn.includes("/apikeycredentialprovider/")) return "api-key";
  if (arn.includes("/oauth2credentialprovider/")) return "oauth";
  throw new UninferrableHarnessPermissionError(
    `harness:credential:${arn}`,
    "credential provider type is unknown",
  );
}

function isBedrockLiteLlmModel(model: HarnessModelConfiguration): boolean {
  return model.liteLlmModelConfig?.modelId?.startsWith("bedrock/") ?? false;
}

function s3Prefix(
  uri: string | undefined,
  owner: string,
): {
  bucketArn: string;
  objectArn: string;
} {
  const match = uri?.match(/^s3:\/\/([^/]+)\/?(.*)$/);
  if (!match?.[1]) {
    throw new UninferrableHarnessPermissionError(owner, `invalid S3 URI "${uri ?? ""}"`);
  }
  const prefix = match[2]?.replace(/\/+$/, "");
  return {
    bucketArn: `arn:aws:s3:::${match[1]}`,
    objectArn: `arn:aws:s3:::${match[1]}/${prefix ? `${prefix}/` : ""}*`,
  };
}

function ecrRepositoryArn(uri: string): string | undefined {
  const match = uri.match(
    /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com\/([^@:]+(?:\/[^@:]+)*)(?:[:@].+)?$/,
  );
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return `arn:aws:ecr:${match[2]}:${match[1]}:repository/${match[3]}`;
}

function arnContext(
  arn: string,
  owner: string,
): {
  partition: string;
  region: string;
  accountId: string;
} {
  const [prefix, partition, , region, accountId] = arn.split(":");
  if (prefix !== "arn" || !partition || !region || !accountId) {
    throw new UninferrableHarnessPermissionError(owner, `invalid ARN "${arn}"`);
  }
  return { partition, region, accountId };
}

function s3FilesFileSystemArn(accessPointArn: string): string {
  const match = accessPointArn.match(
    /^(arn:[^:]+:s3files:[^:]+:\d{12}:file-system\/fs-[^/]+)\/access-point\/fsap-[^/]+$/,
  );
  if (!match?.[1]) {
    throw new UninferrableHarnessPermissionError(
      "harness:environment",
      `invalid S3 Files access point ARN "${accessPointArn}"`,
    );
  }
  return match[1];
}

function containsKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => containsKey(entry, key));
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return key in record || Object.values(record).some((entry) => containsKey(entry, key));
}
