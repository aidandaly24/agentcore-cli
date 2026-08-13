import { warn, type AppIO } from "../../io";
import type { CoreOptions } from "../../core/types";
import type { Core } from "../types";

export async function warnForHarnessRolePolicyUpdate(
  core: Core,
  io: AppIO,
  harnessId: string,
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
  const warning = await core.harness.getHarnessRolePolicyWarning(harnessId, options);
  if (!warning) return;
  warn(
    io,
    `Execution role ${warning.roleArn} is not recognized as managed for this Harness. ` +
      "The CLI will not modify its IAM policies. " +
      "You are responsible for permissions required by this update.",
  );
}
