import { createHash } from "node:crypto";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  PutRolePolicyCommand,
  type IAMClient,
  type Role,
  type Tag,
} from "@aws-sdk/client-iam";
import { AgentCoreCLIError, ERROR_SOURCE } from "../errors";
import type { GatewayPolicyStatement } from "./gatewayPolicy";

const POLICY_NAME = "AgentCoreCliGatewayExecutionPolicy";
const ROLE_PREFIX = "AgentCoreCliGateway-";
const ROLE_TAGS = {
  managed: "AgentCoreCLIManaged",
  resourceType: "AgentCoreCLIResourceType",
  region: "AgentCoreCLIRegion",
  resourceName: "AgentCoreCLIResourceName",
} as const;

export type GatewayExecutionRoleOptions = {
  propagationDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type ManagedGatewayRole = {
  arn: string;
  name: string;
  created: boolean;
};

export class GatewayMutationIndeterminateError extends AgentCoreCLIError {
  constructor(resource: string, options?: ErrorOptions) {
    super(`The outcome of the ${resource} mutation could not be determined`, {
      ...options,
      source: ERROR_SOURCE.SERVICE,
    });
  }
}

export class GatewayMutationTerminalError extends AgentCoreCLIError {
  constructor(
    readonly resource: string,
    readonly status: string,
    readonly statusReasons: readonly string[],
  ) {
    super(`${resource} reached ${status}: ${statusReasons.join(", ")}`, {
      source: ERROR_SOURCE.SERVICE,
    });
  }
}

export class GatewayExecutionRole {
  private readonly propagationDelayMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly iam: IAMClient,
    options: GatewayExecutionRoleOptions = {},
  ) {
    this.propagationDelayMs = options.propagationDelayMs ?? 10_000;
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async ensure(gatewayName: string, region: string): Promise<ManagedGatewayRole> {
    const roleName = gatewayRoleName(gatewayName, region);
    try {
      const response = await this.iam.send(new GetRoleCommand({ RoleName: roleName }));
      if (!response.Role?.Arn) throw new Error(`IAM returned no ARN for role ${roleName}`);
      if (!isOwnedRole(response.Role, gatewayName, region)) {
        throw new Error(
          `IAM role ${roleName} already exists but is not tagged as managed by the AgentCore CLI`,
        );
      }
      return { arn: response.Role.Arn, name: roleName, created: false };
    } catch (error) {
      if ((error as Error).name !== "NoSuchEntityException") throw error;
    }

    const response = await this.iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
        Tags: gatewayRoleTags(gatewayName, region),
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "bedrock-agentcore.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      }),
    );
    if (!response.Role?.Arn) throw new Error(`IAM returned no ARN for role ${roleName}`);
    return { arn: response.Role.Arn, name: roleName, created: true };
  }

  async isManaged(gatewayName: string, region: string, roleArn: string): Promise<boolean> {
    if (!matchesGatewayExecutionRole(gatewayName, region, roleArn)) return false;
    const roleName = roleNameFromArn(roleArn);

    try {
      const response = await this.iam.send(new GetRoleCommand({ RoleName: roleName }));
      return response.Role?.Arn === roleArn && isOwnedRole(response.Role, gatewayName, region);
    } catch (error) {
      if (
        ["NoSuchEntityException", "AccessDenied", "AccessDeniedException"].includes(
          (error as Error).name,
        )
      ) {
        return false;
      }
      throw error;
    }
  }

  async rollbackCreate(role: ManagedGatewayRole): Promise<void> {
    if (!role.created) return;
    await this.write(role.name, []);
    await this.iam.send(new DeleteRoleCommand({ RoleName: role.name }));
  }

  async read(roleArn: string): Promise<GatewayPolicyStatement[]> {
    try {
      const response = await this.iam.send(
        new GetRolePolicyCommand({
          RoleName: roleNameFromArn(roleArn),
          PolicyName: POLICY_NAME,
        }),
      );
      if (!response.PolicyDocument) return [];
      const document = parsePolicy(response.PolicyDocument);
      return Array.isArray(document.Statement) ? document.Statement : [];
    } catch (error) {
      if ((error as Error).name === "NoSuchEntityException") return [];
      throw error;
    }
  }

  async update<T>(
    roleArn: string,
    current: GatewayPolicyStatement[],
    desired: GatewayPolicyStatement[],
    operation: {
      mutate: () => Promise<T>;
      stabilize: () => Promise<void>;
    },
    options: { forcePropagation?: boolean } = {},
  ): Promise<T> {
    const roleName = roleNameFromArn(roleArn);
    const transition = uniqueStatements([...current, ...desired]);
    const staged = JSON.stringify(transition) !== JSON.stringify(current);
    if (staged) await this.write(roleName, transition);
    if ((staged || options.forcePropagation) && this.propagationDelayMs > 0) {
      await this.sleep(this.propagationDelayMs);
    }

    let value: T;
    try {
      value = await operation.mutate();
    } catch (error) {
      if (staged && !(error instanceof GatewayMutationIndeterminateError)) {
        await this.write(roleName, current);
      }
      throw error;
    }
    try {
      await operation.stabilize();
    } catch (error) {
      if (staged && error instanceof GatewayMutationTerminalError) {
        await this.write(roleName, current);
      }
      throw error;
    }
    if (!staged || JSON.stringify(transition) !== JSON.stringify(desired)) {
      await this.write(roleName, desired);
    }
    return value;
  }

  async replace(roleArn: string, desired: GatewayPolicyStatement[]): Promise<void> {
    await this.write(roleNameFromArn(roleArn), desired);
  }

  private async write(roleName: string, statements: GatewayPolicyStatement[]): Promise<void> {
    if (statements.length === 0) {
      try {
        await this.iam.send(
          new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: POLICY_NAME }),
        );
      } catch (error) {
        if ((error as Error).name !== "NoSuchEntityException") throw error;
      }
      return;
    }

    await this.iam.send(
      new PutRolePolicyCommand({
        RoleName: roleName,
        PolicyName: POLICY_NAME,
        PolicyDocument: JSON.stringify({ Version: "2012-10-17", Statement: statements }),
      }),
    );
  }
}

function parsePolicy(document: string): { Statement?: GatewayPolicyStatement[] } {
  try {
    return JSON.parse(document);
  } catch {
    return JSON.parse(decodeURIComponent(document));
  }
}

export function gatewayRoleName(gatewayName: string, region: string): string {
  const fullName = `${ROLE_PREFIX}${region}-${gatewayName}`;
  if (fullName.length <= 64) return fullName;
  const hash = createHash("sha256").update(`${region}:${gatewayName}`).digest("hex").slice(0, 8);
  return `${fullName.slice(0, 55)}-${hash}`;
}

export function matchesGatewayExecutionRole(
  gatewayName: string,
  region: string,
  roleArn: string,
): boolean {
  try {
    return roleNameFromArn(roleArn) === gatewayRoleName(gatewayName, region);
  } catch {
    return false;
  }
}

function gatewayRoleTags(gatewayName: string, region: string): Tag[] {
  return [
    { Key: ROLE_TAGS.managed, Value: "true" },
    { Key: ROLE_TAGS.resourceType, Value: "Gateway" },
    { Key: ROLE_TAGS.region, Value: region },
    { Key: ROLE_TAGS.resourceName, Value: gatewayName },
  ];
}

function isOwnedRole(role: Role, gatewayName: string, region: string): boolean {
  const tags = new Map((role.Tags ?? []).map(({ Key, Value }) => [Key, Value]));
  return (
    tags.get(ROLE_TAGS.managed) === "true" &&
    tags.get(ROLE_TAGS.resourceType) === "Gateway" &&
    tags.get(ROLE_TAGS.region) === region &&
    tags.get(ROLE_TAGS.resourceName) === gatewayName
  );
}

function uniqueStatements(statements: GatewayPolicyStatement[]): GatewayPolicyStatement[] {
  return [
    ...new Map(statements.map((statement) => [JSON.stringify(statement), statement])).values(),
  ];
}

function roleNameFromArn(roleArn: string): string {
  const roleName = roleArn.split("/").at(-1);
  if (!roleName) throw new Error(`Invalid IAM role ARN: ${roleArn}`);
  return roleName;
}
