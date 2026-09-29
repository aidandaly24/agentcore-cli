import type { InvokeAgentRuntimeCommandStreamOutput } from "@aws-sdk/client-bedrock-agentcore";

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
