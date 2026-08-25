import type { Stack } from "@aws-sdk/client-cloudformation";
import { ProjectStateError } from "../../../../errors/errors";
import type { ProjectInvokableResource } from "../../../../handlers/project/types";
import type { CdkCredentialProvider } from "./toolkit";

export type DeployedStackReader = (
  stackName: string,
  region: string,
  credentials: CdkCredentialProvider,
) => Promise<Stack | undefined>;

function sanitizeName(name: string): string {
  return name.replaceAll("_", "-");
}

export function cdkStackName(projectName: string, targetName: string): string {
  return `AgentCore-${sanitizeName(projectName)}-${sanitizeName(targetName)}`;
}

function resourceExportName(
  stackName: string,
  resourceType: ProjectInvokableResource,
  name: string,
): string {
  const resourceName = sanitizeName(name);
  return resourceType === "runtime"
    ? `${stackName}-${resourceName}-RuntimeId`
    : `${stackName}-Harness-${resourceName}-Id`;
}

export function deployedResourceId(
  stack: Stack,
  input: {
    stackName: string;
    targetName: string;
    resourceType: ProjectInvokableResource;
    name: string;
  },
): string {
  const exportName = resourceExportName(input.stackName, input.resourceType, input.name);
  const id = stack.Outputs?.find((output) => output.ExportName === exportName)?.OutputValue;
  if (id) return id;

  const label = input.resourceType === "runtime" ? "Runtime" : "Harness";
  throw new ProjectStateError(
    `${label} '${input.name}' is not deployed to target '${input.targetName}'. ` +
      `Run 'agentcore project deploy --target ${input.targetName}' first.`,
  );
}

function isStackNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; message?: unknown };
  return (
    candidate.name === "ValidationError" &&
    typeof candidate.message === "string" &&
    /Stack with id .+ does not exist/i.test(candidate.message)
  );
}

export const readDeployedStack: DeployedStackReader = async (stackName, region, credentials) => {
  const { CloudFormationClient, DescribeStacksCommand } =
    await import("@aws-sdk/client-cloudformation");
  const client = new CloudFormationClient({ credentials, region });
  try {
    const response = await client.send(new DescribeStacksCommand({ StackName: stackName }));
    return response.Stacks?.[0];
  } catch (error) {
    if (isStackNotFound(error)) return undefined;
    throw error;
  } finally {
    client.destroy();
  }
};
