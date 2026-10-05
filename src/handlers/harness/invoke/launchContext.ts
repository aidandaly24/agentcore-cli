import { contextKey } from "../../../router";

export type HarnessInvokeLaunchContext = {
  harnessId: string;
  runtimeUserId?: string;
};

export const HarnessInvokeLaunchContextKey =
  contextKey<HarnessInvokeLaunchContext>("harness.invoke.launch");
