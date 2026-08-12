import { describe, expect, test } from "bun:test";
import {
  PolicyCompilationError,
  PolicyCompiler,
  PolicySizeError,
  allow,
  type PolicyContribution,
} from "./executionRolePolicy";

const LAMBDA_A = "arn:aws:lambda:us-west-2:123456789012:function:a";
const LAMBDA_B = "arn:aws:lambda:us-west-2:123456789012:function:b";

describe("PolicyCompiler", () => {
  test("produces one deterministic policy and retains every permission owner", () => {
    const contributions: PolicyContribution[] = [
      {
        owner: "gateway-target:b",
        reason: "invoke Lambda target b",
        statements: [allow(["lambda:InvokeFunction"], [LAMBDA_B])],
      },
      {
        owner: "gateway-target:a",
        reason: "invoke Lambda target a",
        statements: [allow(["lambda:InvokeFunction"], [LAMBDA_A])],
      },
      {
        owner: "harness-tool:a",
        reason: "invoke the same Lambda from a Harness tool",
        statements: [allow(["lambda:InvokeFunction"], [LAMBDA_A])],
      },
    ];

    const compiler = new PolicyCompiler();
    const forward = compiler.compile(contributions);
    const reverse = compiler.compile([...contributions].reverse());

    expect(forward.document).toEqual({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["lambda:InvokeFunction"],
          Resource: [LAMBDA_A, LAMBDA_B],
        },
      ],
    });
    expect(reverse.json).toBe(forward.json);
    expect(reverse.hash).toBe(forward.hash);
    expect(forward.permissions).toEqual([
      {
        action: "lambda:InvokeFunction",
        resource: LAMBDA_A,
        owners: [
          {
            owner: "gateway-target:a",
            reason: "invoke Lambda target a",
          },
          {
            owner: "harness-tool:a",
            reason: "invoke the same Lambda from a Harness tool",
          },
        ],
      },
      {
        action: "lambda:InvokeFunction",
        resource: LAMBDA_B,
        owners: [
          {
            owner: "gateway-target:b",
            reason: "invoke Lambda target b",
          },
        ],
      },
    ]);
  });

  test("compacts identical permission neighborhoods without broadening access", () => {
    const compiler = new PolicyCompiler();
    const compiled = compiler.compile([
      {
        owner: "harness-s3-files:input",
        reason: "read mounted input objects",
        statements: [
          allow(
            ["s3:GetObjectVersion", "s3:GetObject"],
            ["arn:aws:s3:::input-bucket/b", "arn:aws:s3:::input-bucket/a"],
          ),
          allow(["kms:Decrypt"], ["arn:aws:kms:us-west-2:123456789012:key/key-id"]),
        ],
      },
    ]);

    expect(compiled.document.Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["kms:Decrypt"],
        Resource: ["arn:aws:kms:us-west-2:123456789012:key/key-id"],
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:GetObjectVersion"],
        Resource: ["arn:aws:s3:::input-bucket/a", "arn:aws:s3:::input-bucket/b"],
      },
    ]);
    expect(compiled.permissions).not.toContainEqual(
      expect.objectContaining({
        action: "kms:Decrypt",
        resource: "arn:aws:s3:::input-bucket/a",
      }),
    );
  });

  test("chooses the smaller exact resource-neighborhood cover when beneficial", () => {
    const compiled = new PolicyCompiler().compile([
      {
        owner: "gateway-target:matrix",
        reason: "exercise exact compaction",
        statements: [
          allow(["service:ActionA"], ["resource:X"]),
          allow(["service:ActionB"], ["resource:Y"]),
          allow(["service:ActionC"], ["resource:X", "resource:Y"]),
        ],
      },
    ]);

    expect(compiled.document.Statement).toEqual([
      {
        Effect: "Allow",
        Action: ["service:ActionA", "service:ActionC"],
        Resource: ["resource:X"],
      },
      {
        Effect: "Allow",
        Action: ["service:ActionB", "service:ActionC"],
        Resource: ["resource:Y"],
      },
    ]);
    expect(compiled.permissions).toHaveLength(4);
  });

  test("never merges permissions with different condition sets", () => {
    const compiled = new PolicyCompiler().compile([
      {
        owner: "harness-mount:team-a",
        reason: "mount team a access point",
        statements: [
          allow(["elasticfilesystem:ClientMount"], ["arn:aws:elasticfilesystem:::file-system/fs"], {
            StringEquals: { "aws:PrincipalTag/team": "a" },
          }),
        ],
      },
      {
        owner: "harness-mount:team-b",
        reason: "mount team b access point",
        statements: [
          allow(["elasticfilesystem:ClientMount"], ["arn:aws:elasticfilesystem:::file-system/fs"], {
            StringEquals: { "aws:PrincipalTag/team": "b" },
          }),
        ],
      },
    ]);

    expect(compiled.document.Statement).toHaveLength(2);
    expect(compiled.document.Statement.map((statement) => statement.Condition)).toEqual([
      { StringEquals: { "aws:PrincipalTag/team": "a" } },
      { StringEquals: { "aws:PrincipalTag/team": "b" } },
    ]);
    expect(compiled.permissions).toHaveLength(2);
  });

  test("canonicalizes unordered IAM condition value sets", () => {
    const compiled = new PolicyCompiler().compile([
      {
        owner: "owner:a",
        reason: "first condition order",
        statements: [
          allow(["s3:GetObject"], ["arn:aws:s3:::bucket/key"], {
            StringEquals: { "aws:PrincipalTag/team": ["b", "a"] },
          }),
        ],
      },
      {
        owner: "owner:b",
        reason: "second condition order",
        statements: [
          allow(["s3:GetObject"], ["arn:aws:s3:::bucket/key"], {
            StringEquals: { "aws:PrincipalTag/team": ["a", "b"] },
          }),
        ],
      },
    ]);

    expect(compiled.permissions).toHaveLength(1);
    expect(compiled.permissions[0]!.owners).toHaveLength(2);
    expect(compiled.document.Statement[0]!.Condition).toEqual({
      StringEquals: { "aws:PrincipalTag/team": ["a", "b"] },
    });
  });

  test("preserves every small action-resource graph exactly", () => {
    const actions = ["service:A", "service:B", "service:C"];
    const resources = ["resource:1", "resource:2", "resource:3"];
    const possibleEdges = actions.flatMap((action) =>
      resources.map((resource) => ({ action, resource })),
    );
    const compiler = new PolicyCompiler();

    for (let mask = 1; mask < 1 << possibleEdges.length; mask++) {
      const edges = possibleEdges.filter((_, index) => (mask & (1 << index)) !== 0);
      const statements = edges.map(({ action, resource }) => allow([action], [resource]));
      const forward = compiler.compile([
        {
          owner: `graph:${mask}`,
          reason: "exhaustive compaction invariant",
          statements,
        },
      ]);
      const reverse = compiler.compile([
        {
          owner: `graph:${mask}`,
          reason: "exhaustive compaction invariant",
          statements: [...statements].reverse(),
        },
      ]);
      const expanded = forward.document.Statement.flatMap((statement) =>
        statement.Action.flatMap((action) =>
          statement.Resource.map((resource) => `${action}\u0000${resource}`),
        ),
      ).sort();
      const expected = edges.map(({ action, resource }) => `${action}\u0000${resource}`).sort();

      expect(expanded).toEqual(expected);
      expect(reverse.json).toBe(forward.json);
    }
  });

  test("rejects invalid generated contributions before rendering IAM JSON", () => {
    const contributions = [
      {
        owner: "",
        reason: "",
        statements: [
          {
            effect: "Deny",
            actions: [],
            resources: [""],
            conditions: { StringEquals: { "aws:PrincipalTag/team": undefined } },
          },
        ],
      },
    ] as unknown as PolicyContribution[];

    expect(() => new PolicyCompiler().compile(contributions)).toThrow(PolicyCompilationError);
    try {
      new PolicyCompiler().compile(contributions);
      throw new Error("expected compilation to fail");
    } catch (error) {
      expect((error as PolicyCompilationError).issues).toEqual([
        "contribution[0].owner must not be empty",
        "contribution[0].reason must not be empty",
        'contribution[0].statements[0].effect must be "Allow"',
        "contribution[0].statements[0].actions must contain at least one action",
        "contribution[0].statements[0].resources[0] must not be empty",
        "contribution[0].statements[0].conditions.StringEquals.aws:PrincipalTag/team must be valid JSON",
      ]);
    }
  });

  test("checks the compact policy against the configured IAM character quota", () => {
    const contribution: PolicyContribution = {
      owner: "gateway-schema:orders",
      reason: "read the OpenAPI schema",
      statements: [allow(["s3:GetObject"], ["arn:aws:s3:::bucket/key"])],
    };

    const exact = new PolicyCompiler({ maxPolicyCharacters: 122 }).compile([contribution]);
    expect(exact.characterCount).toBe(122);

    expect(() => new PolicyCompiler({ maxPolicyCharacters: 121 }).compile([contribution])).toThrow(
      PolicySizeError,
    );
    try {
      new PolicyCompiler({ maxPolicyCharacters: 121 }).compile([contribution]);
      throw new Error("expected policy size validation to fail");
    } catch (error) {
      expect(error).toMatchObject({
        name: "PolicySizeError",
        characterCount: 122,
        maxCharacters: 121,
      });
    }
  });
});
