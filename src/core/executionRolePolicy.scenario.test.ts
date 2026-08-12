import { describe, expect, test } from "bun:test";
import { AgentCorePolicyGrants } from "./agentCorePolicyGrants";
import { PolicyCompiler, type PolicyContribution } from "./executionRolePolicy";

const LAMBDA_ARN = "arn:aws:lambda:us-west-2:123456789012:function:evaluator";
const MEMORY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/memory-id";
const POLICY_ENGINE_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:policy-engine/engine-id";
const GATEWAY_ARN = "arn:aws:bedrock-agentcore:us-west-2:123456789012:gateway/gateway-id";
const KMS_KEY_ARN = "arn:aws:kms:us-west-2:123456789012:key/key-id";

describe("execution-role policy scenarios", () => {
  test("combines Gateway, Harness, and online-evaluation contributions without compiler features", () => {
    const contributions: PolicyContribution[] = [
      {
        owner: "gateway-target:lambda",
        reason: "invoke Lambda target",
        statements: [AgentCorePolicyGrants.invokeLambda(LAMBDA_ARN)],
      },
      {
        owner: "gateway:policy-engine",
        reason: "authorize Gateway requests",
        statements: [
          AgentCorePolicyGrants.getPolicyEngine(POLICY_ENGINE_ARN),
          AgentCorePolicyGrants.authorizeGateway(POLICY_ENGINE_ARN, GATEWAY_ARN),
        ],
      },
      {
        owner: "harness-tool:lambda",
        reason: "invoke Lambda from Harness",
        statements: [AgentCorePolicyGrants.invokeLambda(LAMBDA_ARN)],
      },
      {
        owner: "harness-memory:managed",
        reason: "use managed Harness Memory",
        statements: [AgentCorePolicyGrants.useMemory(MEMORY_ARN)],
      },
      {
        owner: "online-eval:evaluator",
        reason: "invoke code-based evaluator",
        statements: [AgentCorePolicyGrants.evaluateWithLambda(LAMBDA_ARN)],
      },
      {
        owner: "online-eval:kms",
        reason: "decrypt evaluator configuration",
        statements: [AgentCorePolicyGrants.decryptKmsKey(KMS_KEY_ARN)],
      },
    ];

    const compiled = new PolicyCompiler().compile(contributions);
    const sharedLambdaPermission = compiled.permissions.find(
      ({ action, resource }) => action === "lambda:InvokeFunction" && resource === LAMBDA_ARN,
    );

    expect(sharedLambdaPermission?.owners).toEqual([
      {
        owner: "gateway-target:lambda",
        reason: "invoke Lambda target",
      },
      {
        owner: "harness-tool:lambda",
        reason: "invoke Lambda from Harness",
      },
      {
        owner: "online-eval:evaluator",
        reason: "invoke code-based evaluator",
      },
    ]);
    expect(compiled.permissions.map(({ action, resource }) => `${action} ${resource}`)).toEqual(
      expect.arrayContaining([
        `bedrock-agentcore:AuthorizeAction ${GATEWAY_ARN}`,
        `bedrock-agentcore:CreateEvent ${MEMORY_ARN}`,
        `kms:Decrypt ${KMS_KEY_ARN}`,
        `lambda:GetFunction ${LAMBDA_ARN}`,
        `lambda:InvokeFunction ${LAMBDA_ARN}`,
      ]),
    );
  });
});
