import z from "zod";
import type {
  InvokeAgentRuntimeCommandRequest,
  InvokeAgentRuntimeCommandResponse,
  InvokeAgentRuntimeCommandStreamOutput,
} from "@aws-sdk/client-bedrock-agentcore";
import { flag } from "../router";

export type ExecuteCommand = (
  request: InvokeAgentRuntimeCommandRequest,
  signal?: AbortSignal,
) => Promise<InvokeAgentRuntimeCommandResponse>;

export const execFlags = [
  flag(
    "command",
    "the shell command to run",
    z
      .string()
      .refine((value) => value.trim().length > 0, "command must not be empty")
      .optional(),
  ),
  flag("qualifier", "the endpoint qualifier (default DEFAULT)", z.string().min(1).optional()),
  flag(
    "session-id",
    "the Runtime session ID to run in (33-100 characters)",
    z.string().min(33).max(100).optional(),
  ),
  flag(
    "timeout",
    "seconds to wait for the command (1-3600)",
    z.number().int().min(1).max(3600).optional(),
  ),
] as const;

export async function executeCommand(
  execute: ExecuteCommand,
  arn: string | undefined,
  input: { command: string; qualifier?: string; "session-id"?: string; timeout?: number },
) {
  const response = await execute({
    agentRuntimeArn: arn,
    qualifier: input.qualifier ?? "DEFAULT",
    runtimeSessionId: input["session-id"],
    body: { command: input.command, timeout: input.timeout },
  });
  const item = newExecItem(input.command);
  for await (const event of response.stream ?? []) applyExecEvent(item, event);
  finishExec(item);
  return {
    sessionId: response.runtimeSessionId,
    command: item.command,
    exitCode: item.exitCode,
    status: item.status,
    output: item.output,
  };
}

export type ExecItem = {
  kind: "exec";
  command: string;
  output: string;
  exitCode?: number;
  status: "running" | "success" | "error";
};

export function newExecItem(command: string): ExecItem {
  return { kind: "exec", command, output: "", status: "running" };
}

function appendLine(item: ExecItem, text: string): void {
  if (item.output !== "" && !item.output.endsWith("\n")) item.output += "\n";
  item.output += text + "\n";
}

export function applyExecEvent(item: ExecItem, event: InvokeAgentRuntimeCommandStreamOutput): void {
  if (event.chunk) {
    const { contentDelta, contentStop } = event.chunk;
    if (contentDelta) {
      item.output += (contentDelta.stdout ?? "") + (contentDelta.stderr ?? "");
    }
    if (contentStop) {
      item.exitCode = contentStop.exitCode;
      if (contentStop.status === "TIMED_OUT") appendLine(item, "command timed out");
      item.status =
        contentStop.status === "COMPLETED" && contentStop.exitCode === 0 ? "success" : "error";
    }
    return;
  }

  const error =
    event.validationException ??
    event.accessDeniedException ??
    event.resourceNotFoundException ??
    event.serviceQuotaExceededException ??
    event.throttlingException ??
    event.internalServerException ??
    event.runtimeClientError;
  if (error) {
    item.status = "error";
    appendLine(item, error.message ?? String(error));
  }
}

export function finishExec(item: ExecItem): void {
  if (item.status === "running") item.status = "error";
}
