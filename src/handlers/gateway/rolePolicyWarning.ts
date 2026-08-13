import { warn, type AppIO } from "../../io";
import type { CoreOptions } from "../../core/types";
import type { Core } from "../types";

export async function warnForGatewayRolePolicyUpdate(
  core: Core,
  io: AppIO,
  gatewayId: string,
  options: CoreOptions,
  skip = false,
): Promise<void> {
  if (skip) return;
  const roleArn = await core.gateway.getGatewayRolePolicyWarning(gatewayId, options);
  if (!roleArn) return;
  warn(
    io,
    `Execution role ${roleArn} is not managed by the AgentCore CLI. IAM policies will not be modified; you are responsible for permissions required by this operation.`,
  );
}
