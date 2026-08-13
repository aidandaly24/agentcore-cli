import { describe, expect, test } from "bun:test";
import { PutRolePolicyCommand, type IAMClient } from "@aws-sdk/client-iam";
import { GatewayExecutionRole } from "./gatewayExecutionRole";
import type { GatewayPolicyStatement } from "./gatewayPolicy";

const ROLE_ARN = "arn:aws:iam::123456789012:role/AgentCoreCliGateway-orders";
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

describe("GatewayExecutionRole update", () => {
  test("stages current and desired grants before writing exact desired", async () => {
    const { iam, writes } = policyWrites();
    const role = new GatewayExecutionRole(iam, { propagationDelayMs: 0 });

    await role.update(ROLE_ARN, current, desired, async () => {
      expect(writes).toEqual([[...current, ...desired]]);
      return "updated";
    });

    expect(writes).toEqual([[...current, ...desired], desired]);
  });

  test("restores current grants when the Gateway operation fails", async () => {
    const { iam, writes } = policyWrites();
    const role = new GatewayExecutionRole(iam, { propagationDelayMs: 0 });

    await expect(
      role.update(ROLE_ARN, current, desired, async () => {
        throw new Error("update failed");
      }),
    ).rejects.toThrow("update failed");

    expect(writes).toEqual([[...current, ...desired], current]);
  });
});
