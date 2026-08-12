import { createHash } from "node:crypto";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  type IAMClient,
  type Role,
} from "@aws-sdk/client-iam";

export const RECOGNIZED_EXECUTION_ROLE_PREFIXES = [
  "AgentCoreCliHarness-",
  "AgentCoreCliGateway-",
  "AgentCoreCliOnlineEval-",
  "AmazonBedrockAgentCoreHarnessDefaultServiceRole-",
  "AmazonBedrockAgentCoreGatewayDefaultServiceRole",
  "AmazonBedrockAgentCoreRuntimeDefaultServiceRole-",
  "AgentCoreEvalsSDK-",
  "AmazonBedrockAgentCoreSDKRuntime-",
  "AgentCoreGatewayExecutionRole",
] as const;

export type AgentCoreExecutionRolePrimitive = "harness" | "gateway" | "online-eval";

export type GeneratedPolicyIdentity = {
  accountId: string;
  region: string;
  stableResourceKey: string;
};

export type ExecutionRolePolicyManagement =
  | {
      mode: "managed";
      roleArn: string;
      roleName: string;
    }
  | {
      mode: "external";
      reason: "explicit-role" | "skipped" | "unknown-role";
      roleArn: string;
    };

export type ExecutionRolePolicyManagementInput = {
  associatedRoleArn: string;
  explicitRoleArn?: string;
  skipPolicyUpdate?: boolean;
};

export class InvalidExecutionRoleArnError extends Error {
  constructor(readonly roleArn: string) {
    super(`Invalid IAM role ARN: ${roleArn}`);
    this.name = "InvalidExecutionRoleArnError";
  }
}

export type ManagedExecutionRole = {
  arn: string;
  name: string;
  created: boolean;
};

export type EnsureCliRoleInput = {
  primitive: AgentCoreExecutionRolePrimitive;
  resourceName: string;
};

export type ExecutionRoleManagerOptions = {
  cleanupMaxAttempts?: number;
  cleanupRetryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class ExecutionRoleTrustError extends Error {
  constructor(readonly roleName: string) {
    super(`IAM role ${roleName} does not allow bedrock-agentcore.amazonaws.com to assume it.`);
    this.name = "ExecutionRoleTrustError";
  }
}

export class ExecutionRoleManager {
  private readonly cleanupMaxAttempts: number;
  private readonly cleanupRetryDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly iam: IAMClient,
    options: ExecutionRoleManagerOptions = {},
  ) {
    this.cleanupMaxAttempts = Math.max(1, options.cleanupMaxAttempts ?? 5);
    this.cleanupRetryDelayMs = options.cleanupRetryDelayMs ?? 250;
    this.sleep = options.sleep ?? delay;
  }

  static cliRoleName(primitive: AgentCoreExecutionRolePrimitive, resourceName: string): string {
    const prefix = rolePrefix(primitive);
    const normalizedName = resourceName.replace(/[^A-Za-z0-9+=,.@_-]/g, "-");
    const unboundedName = `${prefix}${normalizedName}`;
    if (normalizedName === resourceName && unboundedName.length <= 64) return unboundedName;

    const hash = identityHash([primitive, resourceName], 12);
    const prefixLength = 64 - prefix.length - hash.length - 1;
    return `${prefix}${normalizedName.slice(0, prefixLength)}-${hash}`;
  }

  static generatedPolicyName(
    primitive: AgentCoreExecutionRolePrimitive,
    identity: GeneratedPolicyIdentity,
  ): string {
    const hash = identityHash(
      [primitive, identity.accountId, identity.region, identity.stableResourceKey],
      16,
    );
    return `${policyPrefix(primitive)}${hash}`;
  }

  static policyManagement(
    input: ExecutionRolePolicyManagementInput,
  ): ExecutionRolePolicyManagement {
    if (input.explicitRoleArn) {
      return {
        mode: "external",
        reason: "explicit-role",
        roleArn: input.explicitRoleArn,
      };
    }
    if (input.skipPolicyUpdate) {
      return {
        mode: "external",
        reason: "skipped",
        roleArn: input.associatedRoleArn,
      };
    }

    const roleName = ExecutionRoleManager.roleNameFromArn(input.associatedRoleArn);
    if (RECOGNIZED_EXECUTION_ROLE_PREFIXES.some((prefix) => roleName.startsWith(prefix))) {
      return {
        mode: "managed",
        roleArn: input.associatedRoleArn,
        roleName,
      };
    }
    return {
      mode: "external",
      reason: "unknown-role",
      roleArn: input.associatedRoleArn,
    };
  }

  static roleNameFromArn(roleArn: string): string {
    const match = roleArn.match(/^arn:[^:]+:iam::\d{12}:role\/(?:.+\/)?([^/]+)$/);
    if (!match?.[1]) throw new InvalidExecutionRoleArnError(roleArn);
    return match[1];
  }

  async ensureCliRole(input: EnsureCliRoleInput): Promise<ManagedExecutionRole> {
    const roleName = ExecutionRoleManager.cliRoleName(input.primitive, input.resourceName);
    try {
      const response = await this.iam.send(new GetRoleCommand({ RoleName: roleName }));
      return this.existingRole(response.Role, roleName);
    } catch (error) {
      if ((error as Error).name !== "NoSuchEntityException") throw error;
    }

    const response = await this.iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: agentCoreTrustPolicy(),
        Description: `AgentCore CLI managed execution role for ${input.primitive} "${input.resourceName}"`,
      }),
    );
    const roleArn = requiredRoleArn(response.Role, roleName);
    return { arn: roleArn, name: roleName, created: true };
  }

  async validateAgentCoreTrust(roleName: string): Promise<ManagedExecutionRole> {
    const response = await this.iam.send(new GetRoleCommand({ RoleName: roleName }));
    return this.existingRole(response.Role, roleName);
  }

  async rollbackCreatedRole(
    role: ManagedExecutionRole,
    generatedPolicyName: string,
  ): Promise<void> {
    if (!role.created) return;

    await this.retryCleanup(async () => {
      try {
        await this.iam.send(
          new DeleteRolePolicyCommand({
            RoleName: role.name,
            PolicyName: generatedPolicyName,
          }),
        );
      } catch (error) {
        if ((error as Error).name !== "NoSuchEntityException") throw error;
      }
    });
    await this.retryCleanup(async () => {
      try {
        await this.iam.send(new DeleteRoleCommand({ RoleName: role.name }));
      } catch (error) {
        if ((error as Error).name !== "NoSuchEntityException") throw error;
      }
    });
  }

  async rollbackFailedCreate(
    role: ManagedExecutionRole,
    generatedPolicyName: string,
    createError: unknown,
  ): Promise<never> {
    try {
      await this.rollbackCreatedRole(role, generatedPolicyName);
    } catch (cleanupError) {
      throw new AggregateError(
        [createError, cleanupError],
        "AgentCore parent creation failed and its new execution role could not be removed.",
      );
    }
    throw createError;
  }

  private async retryCleanup(operation: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await operation();
        return;
      } catch (error) {
        if (attempt >= this.cleanupMaxAttempts || !isRetryableCleanupError(error)) throw error;
        await this.sleep(this.cleanupRetryDelayMs);
      }
    }
  }

  private existingRole(role: Role | undefined, expectedRoleName: string): ManagedExecutionRole {
    const roleArn = requiredRoleArn(role, expectedRoleName);
    let trusted = false;
    try {
      trusted =
        role?.AssumeRolePolicyDocument !== undefined &&
        allowsAgentCoreAssumeRole(role.AssumeRolePolicyDocument);
    } catch {
      trusted = false;
    }
    if (!trusted) {
      throw new ExecutionRoleTrustError(expectedRoleName);
    }
    return {
      arn: roleArn,
      name: role?.RoleName ?? expectedRoleName,
      created: false,
    };
  }
}

function rolePrefix(primitive: AgentCoreExecutionRolePrimitive): string {
  switch (primitive) {
    case "harness":
      return "AgentCoreCliHarness-";
    case "gateway":
      return "AgentCoreCliGateway-";
    case "online-eval":
      return "AgentCoreCliOnlineEval-";
  }
}

function policyPrefix(primitive: AgentCoreExecutionRolePrimitive): string {
  switch (primitive) {
    case "harness":
      return "AgentCoreCliHarnessExecutionPolicy-";
    case "gateway":
      return "AgentCoreCliGatewayExecutionPolicy-";
    case "online-eval":
      return "AgentCoreCliOnlineEvalExecutionPolicy-";
  }
}

function identityHash(values: readonly string[], length: number): string {
  return createHash("sha256").update(JSON.stringify(values)).digest("hex").slice(0, length);
}

function agentCoreTrustPolicy(): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "bedrock-agentcore.amazonaws.com" },
        Action: "sts:AssumeRole",
      },
    ],
  });
}

function requiredRoleArn(role: Role | undefined, roleName: string): string {
  if (!role?.Arn) throw new Error(`IAM returned no ARN for role ${roleName}.`);
  return role.Arn;
}

function allowsAgentCoreAssumeRole(policyDocument: string): boolean {
  const policy = parseIamDocument(policyDocument);
  const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
  const applicable = statements.filter((statement) => {
    if (!isRecord(statement)) return false;
    if (!statementAppliesToAssumeRole(statement)) return false;
    if (statement.Principal !== undefined) {
      return principalMatchesAgentCore(statement.Principal);
    }
    if (statement.NotPrincipal !== undefined) {
      return !principalMatchesAgentCore(statement.NotPrincipal);
    }
    return false;
  });
  if (applicable.some((statement) => statement.Effect === "Deny")) return false;
  return applicable.some(
    (statement) => statement.Effect === "Allow" && statement.Condition === undefined,
  );
}

function statementAppliesToAssumeRole(statement: Record<string, unknown>): boolean {
  if (statement.Action !== undefined) {
    return stringList(statement.Action).some((pattern) =>
      iamGlobMatches(pattern, "sts:AssumeRole"),
    );
  }
  if (statement.NotAction !== undefined) {
    return !stringList(statement.NotAction).some((pattern) =>
      iamGlobMatches(pattern, "sts:AssumeRole"),
    );
  }
  return false;
}

function iamGlobMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${expression}$`, "i").test(value);
}

function principalMatchesAgentCore(principal: unknown): boolean {
  if (principal === "*") return true;
  if (!isRecord(principal)) return false;
  return stringList(principal.Service).some(
    (service) => service === "*" || service.toLowerCase() === "bedrock-agentcore.amazonaws.com",
  );
}

function parseIamDocument(policyDocument: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(policyDocument);
    if (!isRecord(parsed)) throw new Error("IAM policy document must be an object.");
    return parsed;
  } catch (originalError) {
    try {
      const parsed = JSON.parse(decodeURIComponent(policyDocument));
      if (!isRecord(parsed)) throw new Error("IAM policy document must be an object.");
      return parsed;
    } catch {
      throw originalError;
    }
  }
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
  return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRetryableCleanupError(error: unknown): boolean {
  return ["ConcurrentModificationException", "DeleteConflictException"].includes(
    (error as Error).name,
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
