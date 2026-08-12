import { warn, type AppIO } from "../../io";
import type { CoreOptions } from "../../core/types";
import type { Core } from "../types";

export async function warnForGatewayRolePolicyUpdate(
  core: Core,
  io: AppIO,
  gatewayId: string,
  options: CoreOptions,
  input: {
    explicitRoleArn?: string;
    skipRolePolicyUpdate?: boolean;
  },
): Promise<void> {
  if (input.skipRolePolicyUpdate) return;
  if (input.explicitRoleArn) {
    warn(
      io,
      `Using customer-managed execution role ${input.explicitRoleArn}; IAM policies will not be modified.`,
    );
    return;
  }

  const warning = await core.gateway.getGatewayRolePolicyWarning(gatewayId, options);
  if (!warning) return;
  warn(
    io,
    `Execution role ${warning.roleArn} is not recognized as AgentCore CLI or console managed. ` +
      "The CLI will not modify its IAM policies. " +
      "You are responsible for permissions required by this update.",
  );
}
