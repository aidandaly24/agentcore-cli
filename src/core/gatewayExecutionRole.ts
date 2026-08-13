import { createHash } from "node:crypto";
import {
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import type { GatewayPolicyStatement } from "./gatewayPolicy";

const POLICY_NAME = "AgentCoreCliGatewayExecutionPolicy";
const ROLE_PREFIX = "AgentCoreCliGateway-";

export type GatewayExecutionRoleOptions = {
  propagationDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type ManagedGatewayRole = {
  arn: string;
  name: string;
  created: boolean;
};

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

  async ensure(gatewayName: string): Promise<ManagedGatewayRole> {
    const roleName = gatewayRoleName(gatewayName);
    try {
      const response = await this.iam.send(new GetRoleCommand({ RoleName: roleName }));
      if (!response.Role?.Arn) throw new Error(`IAM returned no ARN for role ${roleName}`);
      return { arn: response.Role.Arn, name: roleName, created: false };
    } catch (error) {
      if ((error as Error).name !== "NoSuchEntityException") throw error;
    }

    const response = await this.iam.send(
      new CreateRoleCommand({
        RoleName: roleName,
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
    operation: () => Promise<T>,
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
      value = await operation();
    } catch (error) {
      if (staged) await this.write(roleName, current);
      throw error;
    }
    if (JSON.stringify(transition) !== JSON.stringify(desired)) {
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

export function gatewayRoleName(gatewayName: string): string {
  const fullName = `${ROLE_PREFIX}${gatewayName}`;
  if (fullName.length <= 64) return fullName;
  const hash = createHash("sha256").update(gatewayName).digest("hex").slice(0, 8);
  return `${fullName.slice(0, 55)}-${hash}`;
}

export function isGatewayExecutionRole(gatewayName: string, roleArn: string): boolean {
  return roleNameFromArn(roleArn) === gatewayRoleName(gatewayName);
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
