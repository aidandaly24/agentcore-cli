import { contextKey } from "../../../router";

export type RuntimeInvokeLaunchContext = {
  runtimeId: string;
  inputMode?: "json" | "prompt";
  runtimeSessionId?: string;
  runtimeUserId?: string;
  applicationHeaders?: [string, string][];
  bearerToken?: string;
};

export const RuntimeInvokeLaunchContextKey =
  contextKey<RuntimeInvokeLaunchContext>("runtime.invoke.launch");
