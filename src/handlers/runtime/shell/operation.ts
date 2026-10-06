import { InputValidationError } from "../../../errors";
import type { AppIO } from "../../../io";
import type { Context } from "../../../router";
import { ShellOperation } from "../../shell";
import type { Core } from "../../types";
import { coreOptsFromCtx } from "../../utils";
import type { RuntimeShellLaunchContext } from "./launchContext";
import { normalizeRuntimeShellRequest } from "./request";

export type RunRuntimeShellInput = {
  ctx: Context;
  core: Core;
  io: AppIO;
  runtimeId: string;
  qualifier: string;
  launchContext?: RuntimeShellLaunchContext;
};

export async function runRuntimeShell(input: RunRuntimeShellInput): Promise<void> {
  const { ctx, core, io, runtimeId, qualifier, launchContext } = input;
  const shell = new ShellOperation(io);
  shell.requireTerminal();

  const options = coreOptsFromCtx(ctx);
  if (options.endpointUrl !== undefined) {
    throw new InputValidationError("runtime shell does not support --endpoint-url");
  }
  const detail = await core.runtime.getRuntime(runtimeId, options);
  const request = normalizeRuntimeShellRequest(detail, {
    qualifier,
    runtimeSessionId: launchContext?.runtimeSessionId,
    bearerToken: launchContext?.bearerToken,
  });
  request.onReconnect = shell.onReconnect;

  io.stderr.write(`Connecting to Runtime ${runtimeId} (${qualifier})...\n`);
  await shell.run(await core.runtime.openRuntimeShell(request, options));
}
