import { describe, expect, test } from "bun:test";
import {
  DeleteRolePolicyCommand,
  GetRolePolicyCommand,
  ListRolePoliciesCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import { allow, type PolicyContribution } from "./executionRolePolicy";
import {
  ExecutionRolePolicyUpdater,
  PolicyDriftError,
  PolicyFinalizationError,
  PolicyOperationOutcomeUnknownError,
  RoleInlinePolicyQuotaError,
} from "./executionRolePolicyUpdater";

const ROLE_NAME = "AgentCoreCliGateway-orders";
const POLICY_NAME = "AgentCoreCliGatewayExecutionPolicy-a1b2c3d4";
const LAMBDA_A = "arn:aws:lambda:us-west-2:123456789012:function:a";
const LAMBDA_B = "arn:aws:lambda:us-west-2:123456789012:function:b";

type SentCommand =
  DeleteRolePolicyCommand | GetRolePolicyCommand | ListRolePoliciesCommand | PutRolePolicyCommand;

function contribution(owner: string, resource: string): PolicyContribution {
  return {
    owner,
    reason: `invoke ${resource}`,
    statements: [allow(["lambda:InvokeFunction"], [resource])],
  };
}

function statefulIam(
  events: string[],
  options: { failPutAt?: number } = {},
): {
  iam: IAMClient;
  writes: string[];
  setPolicyDocument: (policyDocument: string) => void;
} {
  let policyDocument: string | undefined;
  let putCount = 0;
  const writes: string[] = [];
  const iam = {
    send: async (command: SentCommand) => {
      events.push(command.constructor.name);
      if (command instanceof PutRolePolicyCommand) {
        putCount++;
        if (putCount === options.failPutAt) throw new Error(`put ${putCount} failed`);
        policyDocument = command.input.PolicyDocument;
        writes.push(command.input.PolicyDocument!);
        return {};
      }
      if (command instanceof GetRolePolicyCommand) {
        if (!policyDocument) {
          const error = new Error("policy does not exist");
          error.name = "NoSuchEntityException";
          throw error;
        }
        return { PolicyDocument: policyDocument };
      }
      if (command instanceof DeleteRolePolicyCommand) {
        policyDocument = undefined;
        return {};
      }
      if (command instanceof ListRolePoliciesCommand) {
        return { PolicyNames: policyDocument ? [POLICY_NAME] : [], IsTruncated: false };
      }
      throw new Error("unexpected IAM command");
    },
  } as unknown as IAMClient;

  return {
    iam,
    writes,
    setPolicyDocument: (document) => {
      policyDocument = document;
    },
  };
}

describe("ExecutionRolePolicyUpdater", () => {
  test("stages current union desired, waits, mutates, and writes exact desired", async () => {
    const events: string[] = [];
    const { iam, writes } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    const result = await updater.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [contribution("gateway-target:a", LAMBDA_A)],
      desired: [contribution("gateway-target:b", LAMBDA_B)],
      operation: async () => {
        events.push("AgentCoreOperation");
        return { status: "READY" };
      },
    });

    expect(events).toEqual([
      "ListRolePoliciesCommand",
      "PutRolePolicyCommand",
      "GetRolePolicyCommand",
      "AgentCoreOperation",
      "GetRolePolicyCommand",
      "ListRolePoliciesCommand",
      "PutRolePolicyCommand",
      "GetRolePolicyCommand",
    ]);
    expect(writes.map((policy) => JSON.parse(policy))).toEqual([
      {
        Statement: [
          {
            Action: ["lambda:InvokeFunction"],
            Effect: "Allow",
            Resource: [LAMBDA_A, LAMBDA_B],
          },
        ],
        Version: "2012-10-17",
      },
      {
        Statement: [
          {
            Action: ["lambda:InvokeFunction"],
            Effect: "Allow",
            Resource: [LAMBDA_B],
          },
        ],
        Version: "2012-10-17",
      },
    ]);
    expect(result.value).toEqual({ status: "READY" });
    expect(result.currentHash).not.toBe(result.desiredHash);
    expect(result.transitionHash).not.toBe(result.desiredHash);
  });

  test("accounts for customer inline policies before writing the transition policy", async () => {
    const externalPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["service:Action"],
          Resource: [`arn:aws:service:::${"x".repeat(10_050)}`],
        },
      ],
    });
    let putCalled = false;
    let operationCalled = false;
    const iam = {
      send: async (command: SentCommand) => {
        if (command instanceof ListRolePoliciesCommand) {
          return {
            PolicyNames: ["CustomerPolicy", POLICY_NAME],
            IsTruncated: false,
          };
        }
        if (
          command instanceof GetRolePolicyCommand &&
          command.input.PolicyName === "CustomerPolicy"
        ) {
          return { PolicyDocument: externalPolicy };
        }
        if (command instanceof PutRolePolicyCommand) {
          putCalled = true;
          return {};
        }
        throw new Error(`unexpected IAM command ${command.constructor.name}`);
      },
    } as unknown as IAMClient;
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    const error = await updater
      .update({
        roleName: ROLE_NAME,
        policyName: POLICY_NAME,
        current: [contribution("gateway-target:a", LAMBDA_A)],
        desired: [contribution("gateway-target:b", LAMBDA_B)],
        operation: async () => {
          operationCalled = true;
        },
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(RoleInlinePolicyQuotaError);
    expect(error).toMatchObject({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      externalCharacterCount: externalPolicy.length,
      maxCharacters: 10_240,
    });
    expect((error as RoleInlinePolicyQuotaError).totalCharacterCount).toBeGreaterThan(10_240);
    expect(putCalled).toBeFalse();
    expect(operationCalled).toBeFalse();
  });

  test("restores exact current permissions when the AgentCore operation fails", async () => {
    const events: string[] = [];
    const { iam, writes } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });
    const operationError = new Error("AgentCore reached FAILED");

    const error = await updater
      .update({
        roleName: ROLE_NAME,
        policyName: POLICY_NAME,
        current: [contribution("gateway-target:a", LAMBDA_A)],
        desired: [contribution("gateway-target:b", LAMBDA_B)],
        operation: async () => {
          events.push("AgentCoreOperation");
          throw operationError;
        },
      })
      .catch((caught) => caught);

    expect(error).toBe(operationError);
    expect(events).toEqual([
      "ListRolePoliciesCommand",
      "PutRolePolicyCommand",
      "GetRolePolicyCommand",
      "AgentCoreOperation",
      "ListRolePoliciesCommand",
      "PutRolePolicyCommand",
      "GetRolePolicyCommand",
    ]);
    expect(writes.map((document) => JSON.parse(document).Statement[0].Resource)).toEqual([
      [LAMBDA_A, LAMBDA_B],
      [LAMBDA_A],
    ]);
  });

  test("preserves both the AgentCore and restoration failures", async () => {
    const events: string[] = [];
    const { iam } = statefulIam(events, { failPutAt: 2 });
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    const error = await updater
      .update({
        roleName: ROLE_NAME,
        policyName: POLICY_NAME,
        current: [contribution("gateway-target:a", LAMBDA_A)],
        desired: [contribution("gateway-target:b", LAMBDA_B)],
        operation: async () => {
          throw new Error("AgentCore reached FAILED");
        },
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((cause) => (cause as Error).message)).toEqual([
      "AgentCore reached FAILED",
      "put 2 failed",
    ]);
  });

  test("reports partial success and retains the transition policy when finalization fails", async () => {
    const events: string[] = [];
    const { iam, writes } = statefulIam(events, { failPutAt: 2 });
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    const error = await updater
      .update({
        roleName: ROLE_NAME,
        policyName: POLICY_NAME,
        current: [contribution("gateway-target:a", LAMBDA_A)],
        desired: [contribution("gateway-target:b", LAMBDA_B)],
        operation: async () => ({ status: "READY" }),
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PolicyFinalizationError);
    expect(error).toMatchObject({
      value: { status: "READY" },
      cause: expect.objectContaining({ message: "put 2 failed" }),
    });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).Statement[0].Resource).toEqual([LAMBDA_A, LAMBDA_B]);
  });

  test("does not overwrite a generated policy changed during the AgentCore operation", async () => {
    const events: string[] = [];
    const { iam, setPolicyDocument, writes } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    const error = await updater
      .update({
        roleName: ROLE_NAME,
        policyName: POLICY_NAME,
        current: [contribution("gateway-target:a", LAMBDA_A)],
        desired: [contribution("gateway-target:b", LAMBDA_B)],
        operation: async () => {
          setPolicyDocument('{"Version":"2012-10-17","Statement":[]}');
          return { status: "READY" };
        },
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PolicyFinalizationError);
    expect((error as PolicyFinalizationError<unknown>).cause).toBeInstanceOf(PolicyDriftError);
    expect(writes).toHaveLength(1);
  });

  test("restores current policy when transition propagation fails before AgentCore", async () => {
    let policyDocument: string | undefined;
    let putCount = 0;
    let operationCalled = false;
    const writes: string[] = [];
    const iam = {
      send: async (command: SentCommand) => {
        if (command instanceof ListRolePoliciesCommand) {
          return {
            PolicyNames: policyDocument ? [POLICY_NAME] : [],
            IsTruncated: false,
          };
        }
        if (command instanceof PutRolePolicyCommand) {
          putCount++;
          policyDocument = command.input.PolicyDocument;
          writes.push(command.input.PolicyDocument!);
          return {};
        }
        if (command instanceof GetRolePolicyCommand) {
          if (putCount === 1) {
            const error = new Error("not visible");
            error.name = "NoSuchEntityException";
            throw error;
          }
          return { PolicyDocument: policyDocument };
        }
        throw new Error(`unexpected IAM command ${command.constructor.name}`);
      },
    } as unknown as IAMClient;
    const updater = new ExecutionRolePolicyUpdater(iam, {
      maxVisibilityAttempts: 1,
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    await expect(
      updater.update({
        roleName: ROLE_NAME,
        policyName: POLICY_NAME,
        current: [contribution("gateway-target:a", LAMBDA_A)],
        desired: [contribution("gateway-target:b", LAMBDA_B)],
        operation: async () => {
          operationCalled = true;
        },
      }),
    ).rejects.toMatchObject({ name: "PolicyPropagationError" });

    expect(writes.map((document) => JSON.parse(document).Statement[0].Resource)).toEqual([
      [LAMBDA_A, LAMBDA_B],
      [LAMBDA_A],
    ]);
    expect(operationCalled).toBeFalse();
  });

  test("keeps current permissions when inventory is incomplete", async () => {
    const events: string[] = [];
    const { iam, writes, setPolicyDocument } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });
    const unreadLambdaArn = "arn:aws:lambda:us-west-2:123456789012:function:unread-child";
    setPolicyDocument(
      JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["lambda:InvokeFunction"],
            Resource: [LAMBDA_A, unreadLambdaArn],
          },
        ],
      }),
    );

    const result = await updater.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [contribution("gateway-target:a", LAMBDA_A)],
      desired: [contribution("gateway-target:b", LAMBDA_B)],
      inventoryComplete: false,
      operation: async () => ({ status: "READY" }),
    });

    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).Statement[0].Resource).toEqual([
      LAMBDA_A,
      LAMBDA_B,
      unreadLambdaArn,
    ]);
    expect(result.tightened).toBeFalse();
    expect(result.desiredHash).toBe(result.transitionHash);
  });

  test("resolves generated child permissions after AgentCore reaches READY", async () => {
    const events: string[] = [];
    const { iam, writes } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });
    const stagedMemoryArn = "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/harness_*";
    const exactMemoryArn =
      "arn:aws:bedrock-agentcore:us-west-2:123456789012:memory/generated-memory-id";

    const result = await updater.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [],
      desired: [
        {
          owner: "harness-memory:managed",
          reason: "stage managed Memory access",
          statements: [allow(["bedrock-agentcore:ListEvents"], [stagedMemoryArn])],
        },
      ],
      operation: async () => {
        events.push("AgentCoreReady");
        return { harnessId: "harness-id", status: "READY" };
      },
      resolveDesired: async (value) => {
        events.push(`ResolveDesired:${value.harnessId}`);
        return {
          contributions: [
            {
              owner: "harness-memory:managed",
              reason: "use generated managed Memory",
              statements: [allow(["bedrock-agentcore:ListEvents"], [exactMemoryArn])],
            },
          ],
          inventoryComplete: true,
        };
      },
    });

    expect(events.indexOf("AgentCoreReady")).toBeLessThan(
      events.indexOf("ResolveDesired:harness-id"),
    );
    expect(writes.map((document) => JSON.parse(document).Statement[0].Resource)).toEqual([
      [stagedMemoryArn],
      [exactMemoryArn],
    ]);
    expect(result.desiredHash).not.toBe(result.transitionHash);
  });

  test("deletes only the generated policy after a successful capability removal", async () => {
    const events: string[] = [];
    const { iam, writes } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    await updater.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [contribution("gateway-target:a", LAMBDA_A)],
      desired: [],
      operation: async () => {
        events.push("AgentCoreDelete");
      },
    });

    expect(events).toEqual([
      "ListRolePoliciesCommand",
      "PutRolePolicyCommand",
      "GetRolePolicyCommand",
      "AgentCoreDelete",
      "GetRolePolicyCommand",
      "DeleteRolePolicyCommand",
      "GetRolePolicyCommand",
    ]);
    expect(writes).toHaveLength(1);
  });

  test("paginates customer policies and excludes insignificant JSON whitespace from quota", async () => {
    const events: string[] = [];
    let generatedPolicy: string | undefined;
    const prettyExternalPolicy = `{
      "Version": "2012-10-17",
      "Statement": [${" ".repeat(6_000)}]
    }`;
    const iam = {
      send: async (command: SentCommand) => {
        events.push(command.constructor.name);
        if (command instanceof ListRolePoliciesCommand) {
          return command.input.Marker
            ? {
                PolicyNames: ["CustomerB", POLICY_NAME],
                IsTruncated: false,
              }
            : {
                PolicyNames: ["CustomerA"],
                IsTruncated: true,
                Marker: "next",
              };
        }
        if (command instanceof GetRolePolicyCommand) {
          if (command.input.PolicyName === "CustomerA") {
            return { PolicyDocument: prettyExternalPolicy };
          }
          if (command.input.PolicyName === "CustomerB") {
            return { PolicyDocument: encodeURIComponent(prettyExternalPolicy) };
          }
          return { PolicyDocument: generatedPolicy };
        }
        if (command instanceof PutRolePolicyCommand) {
          generatedPolicy = command.input.PolicyDocument;
          return {};
        }
        throw new Error(`unexpected IAM command ${command.constructor.name}`);
      },
    } as unknown as IAMClient;
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });

    await updater.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [],
      desired: [contribution("gateway-target:a", LAMBDA_A)],
      operation: async () => {
        events.push("AgentCoreOperation");
      },
    });

    expect(events.slice(0, 5)).toEqual([
      "ListRolePoliciesCommand",
      "ListRolePoliciesCommand",
      "GetRolePolicyCommand",
      "GetRolePolicyCommand",
      "PutRolePolicyCommand",
    ]);
  });

  test("waits through IAM visibility delay before running AgentCore", async () => {
    let generatedPolicy: string | undefined;
    let visibilityReads = 0;
    const sleeps: number[] = [];
    let operationReads = 0;
    const iam = {
      send: async (command: SentCommand) => {
        if (command instanceof ListRolePoliciesCommand) {
          return { PolicyNames: [], IsTruncated: false };
        }
        if (command instanceof PutRolePolicyCommand) {
          generatedPolicy = command.input.PolicyDocument;
          return {};
        }
        if (command instanceof GetRolePolicyCommand) {
          visibilityReads++;
          if (visibilityReads < 3) {
            const error = new Error("not visible");
            error.name = "NoSuchEntityException";
            throw error;
          }
          return { PolicyDocument: encodeURIComponent(generatedPolicy!) };
        }
        throw new Error(`unexpected IAM command ${command.constructor.name}`);
      },
    } as unknown as IAMClient;
    const updater = new ExecutionRolePolicyUpdater(iam, {
      retryDelayMs: 11,
      propagationDelayMs: 22,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await updater.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [],
      desired: [contribution("gateway-target:a", LAMBDA_A)],
      operation: async () => {
        operationReads = visibilityReads;
      },
    });

    expect(operationReads).toBe(3);
    expect(sleeps).toEqual([11, 11, 22]);
  });

  test("serializes complete transactions targeting the same role", async () => {
    const events: string[] = [];
    const { iam } = statefulIam(events);
    const updaterA = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });
    const updaterB = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstOperationStarted = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = updaterA.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [contribution("gateway-target:a", LAMBDA_A)],
      desired: [contribution("gateway-target:b", LAMBDA_B)],
      operation: async () => {
        events.push("FirstOperation");
        firstStarted();
        await holdFirst;
      },
    });
    await firstOperationStarted;

    const second = updaterB.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [contribution("gateway-target:b", LAMBDA_B)],
      desired: [contribution("gateway-target:a", LAMBDA_A)],
      operation: async () => {
        events.push("SecondOperation");
      },
    });
    await Bun.sleep(10);

    expect(events.filter((event) => event === "PutRolePolicyCommand")).toHaveLength(1);
    expect(events).not.toContain("SecondOperation");

    releaseFirst();
    await Promise.all([first, second]);
    expect(events.indexOf("SecondOperation")).toBeGreaterThan(events.indexOf("FirstOperation"));
  });

  test("retries only caller-classified pre-mutation propagation failures", async () => {
    const events: string[] = [];
    const sleeps: number[] = [];
    const { iam } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    let attempts = 0;

    const result = await updater.update({
      roleName: ROLE_NAME,
      policyName: POLICY_NAME,
      current: [contribution("gateway-target:a", LAMBDA_A)],
      desired: [contribution("gateway-target:b", LAMBDA_B)],
      operation: async () => {
        attempts++;
        if (attempts === 1) {
          const error = new Error("execution role permissions have not propagated");
          error.name = "ValidationException";
          throw error;
        }
        return { status: "READY" };
      },
      operationRetry: {
        maxAttempts: 3,
        delayMs: 17,
        shouldRetry: (error) =>
          (error as Error).name === "ValidationException" &&
          /permissions.*propagat/i.test((error as Error).message),
      },
    });

    expect(attempts).toBe(2);
    expect(sleeps.filter((milliseconds) => milliseconds > 0)).toEqual([17]);
    expect(result.value).toEqual({ status: "READY" });
  });

  test("retains the transition policy when the AgentCore outcome is unknown", async () => {
    const events: string[] = [];
    const { iam, writes } = statefulIam(events);
    const updater = new ExecutionRolePolicyUpdater(iam, {
      propagationDelayMs: 0,
      retryDelayMs: 0,
    });
    const timeout = new Error("status polling timed out");
    timeout.name = "GatewayOutcomeUnknownError";

    const error = await updater
      .update({
        roleName: ROLE_NAME,
        policyName: POLICY_NAME,
        current: [contribution("gateway-target:a", LAMBDA_A)],
        desired: [contribution("gateway-target:b", LAMBDA_B)],
        operation: async () => {
          throw timeout;
        },
        isOperationOutcomeUnknown: (caught) =>
          (caught as Error).name === "GatewayOutcomeUnknownError",
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(PolicyOperationOutcomeUnknownError);
    expect((error as PolicyOperationOutcomeUnknownError).cause).toBe(timeout);
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]!).Statement[0].Resource).toEqual([LAMBDA_A, LAMBDA_B]);
  });
});
