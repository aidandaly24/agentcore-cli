import { describe, expect, test } from "bun:test";
import type { EC2Client } from "@aws-sdk/client-ec2";
import { HarnessClient } from "./harness";
import type { AwsClients } from "./types";
import { InputValidationError, MalformedServiceResponseError } from "../errors";

function clientWithSubnets(subnets: { VpcId?: string }[]): HarnessClient {
  const ec2 = { send: async () => ({ Subnets: subnets }) } as unknown as EC2Client;
  const unexpected = () => {
    throw new Error("unexpected client");
  };
  return new HarnessClient({
    control: unexpected,
    data: unexpected,
    ec2: () => ec2,
    iam: unexpected,
    logs: unexpected,
  } as AwsClients);
}

describe("HarnessClient.resolveVpcIdFromSubnets", () => {
  test("returns the shared VPC ID", async () => {
    const subject = clientWithSubnets([
      { VpcId: "vpc-0123456789abcdef0" },
      { VpcId: "vpc-0123456789abcdef0" },
    ]);

    await expect(
      subject.resolveVpcIdFromSubnets(["subnet-a", "subnet-b"], { region: "us-east-1" }),
    ).resolves.toBe("vpc-0123456789abcdef0");
  });

  test("rejects subnets spanning multiple VPCs", async () => {
    const subject = clientWithSubnets([{ VpcId: "vpc-a" }, { VpcId: "vpc-b" }]);

    await expect(
      subject.resolveVpcIdFromSubnets(["subnet-a", "subnet-b"], { region: "us-east-1" }),
    ).rejects.toBeInstanceOf(InputValidationError);
  });

  test("rejects an EC2 response without a VPC ID", async () => {
    const subject = clientWithSubnets([{}]);

    await expect(
      subject.resolveVpcIdFromSubnets(["subnet-a"], { region: "us-east-1" }),
    ).rejects.toBeInstanceOf(MalformedServiceResponseError);
  });
});
