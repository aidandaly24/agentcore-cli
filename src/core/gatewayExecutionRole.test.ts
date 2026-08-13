import { describe, expect, test } from "bun:test";
import {
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  type IAMClient,
} from "@aws-sdk/client-iam";
import {
  GatewayExecutionRole,
  GatewayMutationIndeterminateError,
  GatewayMutationTerminalError,
  gatewayRoleName,
  matchesGatewayExecutionRole,
} from "./gatewayExecutionRole";
import type { GatewayPolicyStatement } from "./gatewayPolicy";

const REGION = "us-west-2";
const ROLE_NAME = "AgentCoreCliGateway-us-west-2-orders";
const ROLE_ARN = `arn:aws:iam::123456789012:role/${ROLE_NAME}`;
const ROLE_TAGS = [
  { Key: "AgentCoreCLIManaged", Value: "true" },
  { Key: "AgentCoreCLIResourceType", Value: "Gateway" },
  { Key: "AgentCoreCLIRegion", Value: REGION },
  { Key: "AgentCoreCLIResourceName", Value: "orders" },
];
const current: GatewayPolicyStatement[] = [
  { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: ["arn:lambda:old"] },
];
const desired: GatewayPolicyStatement[] = [
  { Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: ["arn:lambda:new"] },
];

function policyWrites(): { iam: IAMClient; writes: GatewayPolicyStatement[][] } {
  const writes: GatewayPolicyStatement[][] = [];
  const iam = {
    send: async (command: PutRolePolicyCommand) => {
      expect(command).toBeInstanceOf(PutRolePolicyCommand);
      writes.push(JSON.parse(command.input.PolicyDocument!).Statement);
      return {};
    },
  } as unknown as IAMClient;
  return { iam, writes };
}

describe("GatewayExecutionRole ownership", () => {
  test("creates a region-scoped role with CLI ownership tags", async () => {
    const commands: unknown[] = [];
    const iam = {
      send: async (command: unknown) => {
        commands.push(command);
        if (command instanceof GetRoleCommand) {
          const error = new Error("missing");
          error.name = "NoSuchEntityException";
          throw error;
        }
        return { Role: { Arn: ROLE_ARN } };
      },
    } as unknown as IAMClient;

    await expect(new GatewayExecutionRole(iam).ensure("orders", REGION)).resolves.toEqual({
      arn: ROLE_ARN,
      name: ROLE_NAME,
      created: true,
    });

    expect(gatewayRoleName("orders", REGION)).toBe(ROLE_NAME);
    expect((commands[1] as CreateRoleCommand).input).toMatchObject({
      RoleName: ROLE_NAME,
      Tags: ROLE_TAGS,
    });
  });

  test("requires both the regional name and ownership tags", async () => {
    let calls = 0;
    const iam = {
      send: async () => {
        calls += 1;
        return {
          Role: {
            Arn: ROLE_ARN,
            RoleName: ROLE_NAME,
            Tags: ROLE_TAGS,
          },
        };
      },
    } as unknown as IAMClient;
    const role = new GatewayExecutionRole(iam);

    await expect(role.isManaged("orders", REGION, ROLE_ARN)).resolves.toBe(true);
    await expect(role.isManaged("orders", "us-east-1", ROLE_ARN)).resolves.toBe(false);
    await expect(
      new GatewayExecutionRole({
        send: async () => ({ Role: { Arn: ROLE_ARN, RoleName: ROLE_NAME } }),
      } as unknown as IAMClient).isManaged("orders", REGION, ROLE_ARN),
    ).resolves.toBe(false);
    expect(matchesGatewayExecutionRole("orders", REGION, ROLE_ARN)).toBe(true);
    expect(calls).toBe(1);
  });

  test("rejects an untagged role that collides with the generated name", async () => {
    const iam = {
      send: async () => ({
        Role: { Arn: ROLE_ARN, RoleName: ROLE_NAME },
      }),
    } as unknown as IAMClient;

    await expect(new GatewayExecutionRole(iam).ensure("orders", REGION)).rejects.toThrow(
      /not tagged as managed by the AgentCore CLI/,
    );
  });
});

describe("GatewayExecutionRole update", () => {
  test("stages current and desired grants before writing exact desired", async () => {
    const { iam, writes } = policyWrites();
    const role = new GatewayExecutionRole(iam, { propagationDelayMs: 0 });

    await role.update(ROLE_ARN, current, desired, {
      mutate: async () => {
        expect(writes).toEqual([[...current, ...desired]]);
        return "updated";
      },
      stabilize: async () => {},
    });

    expect(writes).toEqual([[...current, ...desired], desired]);
  });

  test("rewrites exact desired grants after a successful retry with no state delta", async () => {
    const { iam, writes } = policyWrites();
    const role = new GatewayExecutionRole(iam, { propagationDelayMs: 0 });

    await role.update(ROLE_ARN, desired, desired, {
      mutate: async () => "updated",
      stabilize: async () => {},
    });

    expect(writes).toEqual([desired]);
  });

  test("restores current grants when the mutation is rejected", async () => {
    const { iam, writes } = policyWrites();
    const role = new GatewayExecutionRole(iam, { propagationDelayMs: 0 });

    await expect(
      role.update(ROLE_ARN, current, desired, {
        mutate: async () => {
          throw new Error("update failed");
        },
        stabilize: async () => {},
      }),
    ).rejects.toThrow("update failed");

    expect(writes).toEqual([[...current, ...desired], current]);
  });

  test("restores current grants after a terminal service failure", async () => {
    const { iam, writes } = policyWrites();
    const role = new GatewayExecutionRole(iam, { propagationDelayMs: 0 });

    await expect(
      role.update(ROLE_ARN, current, desired, {
        mutate: async () => "accepted",
        stabilize: async () => {
          throw new GatewayMutationTerminalError("Gateway", "FAILED", ["invalid"]);
        },
      }),
    ).rejects.toThrow("Gateway reached FAILED: invalid");

    expect(writes).toEqual([[...current, ...desired], current]);
  });

  test.each(["mutation", "stabilization"] as const)(
    "retains transition grants after indeterminate %s",
    async (phase) => {
      const { iam, writes } = policyWrites();
      const role = new GatewayExecutionRole(iam, { propagationDelayMs: 0 });

      await expect(
        role.update(ROLE_ARN, current, desired, {
          mutate: async () => {
            if (phase === "mutation") {
              throw new GatewayMutationIndeterminateError("Gateway");
            }
            return "accepted";
          },
          stabilize: async () => {
            if (phase === "stabilization") {
              throw new GatewayMutationIndeterminateError("Gateway");
            }
          },
        }),
      ).rejects.toBeInstanceOf(GatewayMutationIndeterminateError);

      expect(writes).toEqual([[...current, ...desired]]);
    },
  );
});
