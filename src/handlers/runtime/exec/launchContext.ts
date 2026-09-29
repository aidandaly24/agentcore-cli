import { contextKey } from "../../../router";

export type RuntimeExecLaunchContext = {
  runtimeId: string;
  runtimeSessionId?: string;
  timeout?: number;
};

export const RuntimeExecLaunchContextKey =
  contextKey<RuntimeExecLaunchContext>("runtime.exec.launch");
