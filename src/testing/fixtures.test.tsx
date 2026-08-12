import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
} from "@aws-sdk/client-iam";
import { fixtureFactories } from "./fixtures";
import { stringify } from "./serialization";

const directories: string[] = [];

afterEach(() => {
  delete process.env.RECORD;
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixturePath(directory: string, command: object & { input: unknown }): string {
  const operation = command.constructor.name;
  const hash = Bun.hash(stringify(command.input ?? {})).toString(16);
  return join(directory, `${operation}.${hash}.json`);
}

function record(directory: string, command: object & { input: unknown }, response: unknown): void {
  writeFileSync(fixturePath(directory, command), stringify(response));
}

describe("fixture IAM replay", () => {
  test("replays evolving inline policy state while retaining recorded external names", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agentcore-fixture-iam-"));
    directories.push(directory);
    const roleName = "AgentCoreCliGateway-orders";
    const policyName = "AgentCoreCliGatewayExecutionPolicy-test";
    const firstDocument = '{"Version":"2012-10-17","Statement":[]}';
    const secondDocument =
      '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"s3:GetObject","Resource":"*"}]}';
    const firstPut = new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: firstDocument,
    });
    const secondPut = new PutRolePolicyCommand({
      RoleName: roleName,
      PolicyName: policyName,
      PolicyDocument: secondDocument,
    });
    const list = new ListRolePoliciesCommand({ RoleName: roleName });
    record(directory, firstPut, {});
    record(directory, secondPut, {});
    record(directory, list, {
      PolicyNames: ["CustomerPolicy"],
      IsTruncated: false,
    });
    const iam = fixtureFactories(directory).createIamClient({ region: "us-west-2" });

    await iam.send(firstPut);
    await expect(iam.send(list)).resolves.toMatchObject({
      PolicyNames: ["AgentCoreCliGatewayExecutionPolicy-test", "CustomerPolicy"],
    });
    await expect(
      iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName })),
    ).resolves.toMatchObject({
      PolicyDocument: encodeURIComponent(firstDocument),
    });

    await iam.send(secondPut);
    await expect(
      iam.send(new GetRolePolicyCommand({ RoleName: roleName, PolicyName: policyName })),
    ).resolves.toMatchObject({
      PolicyDocument: encodeURIComponent(secondDocument),
    });
  });
});
