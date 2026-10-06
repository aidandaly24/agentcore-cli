import { contextKey } from "../../../router";

export type HarnessShellLaunchContext = {
  harnessId: string;
  runtimeSessionId?: string;
  bearerToken?: string;
};

export const HarnessShellLaunchContextKey =
  contextKey<HarnessShellLaunchContext>("harness.shell.launch");
