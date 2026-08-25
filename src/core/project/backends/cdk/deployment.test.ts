import { describe, expect, test } from "bun:test";
import type { Stack } from "@aws-sdk/client-cloudformation";
import { cdkStackName, deployedResourceId } from "./deployment";

function stack(outputs: NonNullable<Stack["Outputs"]>): Stack {
  return {
    StackName: "AgentCore-orders-default",
    CreationTime: new Date(0),
    StackStatus: "CREATE_COMPLETE",
    Outputs: outputs,
  };
}

describe("cdkStackName", () => {
  test("matches the stack name emitted by the generated CDK app", () => {
    expect(cdkStackName("order_service", "pre_prod")).toBe("AgentCore-order-service-pre-prod");
  });
});

describe("deployedResourceId", () => {
  test("resolves a Runtime ID by its stable CloudFormation export name", () => {
    const deployed = stack([
      {
        ExportName: "AgentCore-orders-default-checkout-agent-RuntimeId",
        OutputValue: "checkout_agent-AbCdEf1234",
      },
    ]);

    expect(
      deployedResourceId(deployed, {
        stackName: "AgentCore-orders-default",
        targetName: "default",
        resourceType: "runtime",
        name: "checkout_agent",
      }),
    ).toBe("checkout_agent-AbCdEf1234");
  });

  test("resolves a Harness ID by its stable CloudFormation export name", () => {
    const deployed = stack([
      {
        ExportName: "AgentCore-orders-default-Harness-support-agent-Id",
        OutputValue: "support_agent-AbCdEf1234",
      },
    ]);

    expect(
      deployedResourceId(deployed, {
        stackName: "AgentCore-orders-default",
        targetName: "default",
        resourceType: "harness",
        name: "support_agent",
      }),
    ).toBe("support_agent-AbCdEf1234");
  });

  test("fails when the selected resource has no deployed ID output", () => {
    expect(() =>
      deployedResourceId(stack([]), {
        stackName: "AgentCore-orders-pre-prod",
        targetName: "pre-prod",
        resourceType: "runtime",
        name: "checkout",
      }),
    ).toThrow(/Runtime 'checkout'.*not deployed.*pre-prod/s);
  });
});
