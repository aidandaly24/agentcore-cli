import { describe, expect, test } from "bun:test";
import type { IAMClient } from "@aws-sdk/client-iam";
import { ExecutionRoleSourceReader } from "./executionRoleSource";
import type { AwsClients, ClientConfig } from "./types";

const roleArn = "arn:aws:iam::111122223333:role/path/HarnessRole";
const policyArn = "arn:aws:iam::111122223333:policy/SourceOwned";
const document = {
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Deny",
      NotResource: ["arn:aws:s3:::allowed/*"],
      Action: "s3:*",
      Condition: { StringEquals: { "aws:PrincipalTag/team": "agents%team" } },
    },
  ],
};

function reader(responses: unknown[]) {
  const calls: { command: string; input: unknown }[] = [];
  const configs: ClientConfig[] = [];
  const client = {
    send: async (command: { constructor: { name: string }; input: unknown }) => {
      calls.push({ command: command.constructor.name, input: command.input });
      const result = responses.shift();
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as IAMClient;
  const clients = {
    iam: (config: ClientConfig) => {
      configs.push(config);
      return client;
    },
  } as AwsClients;
  return { subject: new ExecutionRoleSourceReader(clients), calls, configs };
}

describe("ExecutionRoleSourceReader", () => {
  test("accepts a fully read role with no application policies", async () => {
    expect(
      await reader([
        { Role: { Arn: roleArn } },
        { PolicyNames: [], IsTruncated: false },
        { AttachedPolicies: [], IsTruncated: false },
        { Tags: [], IsTruncated: false },
      ]).subject.read(roleArn, { region: "us-west-2" }),
    ).toEqual({
      roleArn,
      inlinePolicies: [],
      managedPolicyArns: [],
      tags: {},
    });
  });
  test("captures complete policies, paginated references and durable tags without reading managed documents or trust", async () => {
    const boundary = "arn:aws:iam::111122223333:policy/Boundary";
    const { subject, calls, configs } = reader([
      {
        Role: {
          Arn: roleArn,
          PermissionsBoundary: { PermissionsBoundaryArn: boundary },
          AssumeRolePolicyDocument: "old trust",
        },
      },
      { PolicyNames: ["First"], IsTruncated: true, Marker: "inline-2" },
      { PolicyDocument: encodeURIComponent(JSON.stringify(document)) },
      { PolicyNames: ["Second"], IsTruncated: false },
      { PolicyDocument: JSON.stringify(document) },
      { AttachedPolicies: [{ PolicyArn: policyArn }], IsTruncated: true, Marker: "managed-2" },
      { AttachedPolicies: [{ PolicyArn: `${policyArn}2` }], IsTruncated: false },
      { Tags: [{ Key: "team", Value: "agents" }], IsTruncated: true, Marker: "tags-2" },
      {
        Tags: [
          { Key: "empty", Value: "" },
          { Key: "aws:cloudformation:stack-id", Value: "stack" },
        ],
        IsTruncated: false,
      },
    ]);
    const credentials = { accessKeyId: "test", secretAccessKey: "test" };
    expect(
      await subject.read(roleArn, {
        region: "us-west-2",
        endpointUrl: "https://agentcore.example",
        credentials,
      }),
    ).toEqual({
      roleArn,
      inlinePolicies: [
        { name: "First", document },
        { name: "Second", document },
      ],
      managedPolicyArns: [policyArn, `${policyArn}2`],
      permissionsBoundaryArn: boundary,
      tags: { team: "agents", empty: "" },
    });
    expect(configs).toEqual([{ region: "us-west-2", credentials }]);
    expect(
      calls.filter((call) => (call.input as { Marker?: string }).Marker).map((call) => call.input),
    ).toEqual([
      { RoleName: "HarnessRole", Marker: "inline-2" },
      { RoleName: "HarnessRole", Marker: "managed-2" },
      { RoleName: "HarnessRole", Marker: "tags-2" },
    ]);
    expect(calls.some((call) => call.command === "GetPolicyVersionCommand")).toBe(false);
  });

  test.each([
    [{ Role: {} }],
    [{ Role: { Arn: roleArn, PermissionsBoundary: {} } }],
    [{ Role: { Arn: roleArn } }, { IsTruncated: false }],
    [{ Role: { Arn: roleArn } }, { PolicyNames: [], IsTruncated: true }],
    [{ Role: { Arn: roleArn } }, { PolicyNames: ["Missing"], IsTruncated: false }, {}],
    [
      { Role: { Arn: roleArn } },
      { PolicyNames: ["Invalid"], IsTruncated: false },
      { PolicyDocument: "%broken" },
    ],
    [
      { Role: { Arn: roleArn } },
      { PolicyNames: [], IsTruncated: false },
      { AttachedPolicies: [{}], IsTruncated: false },
    ],
    [
      { Role: { Arn: roleArn } },
      { PolicyNames: [], IsTruncated: false },
      { AttachedPolicies: [], IsTruncated: false },
      { Tags: [{ Key: "team" }], IsTruncated: false },
    ],
  ])("rejects incomplete capture %#", async (...responses) => {
    await expect(reader(responses).subject.read(roleArn, { region: "us-west-2" })).rejects.toThrow(
      /Cannot capture/,
    );
  });

  test("propagates access failures instead of exporting an empty role", async () => {
    await expect(
      reader([new Error("AccessDenied")]).subject.read(roleArn, { region: "us-west-2" }),
    ).rejects.toThrow("AccessDenied");
  });
});
