import { InvalidEnvironmentError } from "../../errors";
import { abortable } from "../abortable";
import type { RuntimeInvokeResponse } from "../invokeRuntime";

export type LocalRuntimeInvokeRequest = {
  port: number;
  payload: Uint8Array;
};

async function* emptyBody(): AsyncGenerator<Uint8Array> {}

export async function invokeLocalRuntime(
  request: LocalRuntimeInvokeRequest,
  signal?: AbortSignal,
): Promise<RuntimeInvokeResponse> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${request.port}/invocations`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/json" },
      body: request.payload as RequestInit["body"],
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw new InvalidEnvironmentError(
      `Local dev server is not running on port ${request.port}. Start it with: ` +
        `agentcore project dev --mode headless --agent <name> --port ${request.port}`,
      { cause: error },
    );
  }

  const body = (response.body as AsyncIterable<Uint8Array> | null) ?? emptyBody();
  return {
    statusCode: response.status,
    contentType: response.headers.get("content-type") ?? "",
    runtimeSessionId:
      response.headers.get("x-amzn-bedrock-agentcore-runtime-session-id") ??
      response.headers.get("x-session-id") ??
      undefined,
    mcpSessionId: response.headers.get("mcp-session-id") ?? undefined,
    mcpProtocolVersion: response.headers.get("mcp-protocol-version") ?? undefined,
    traceId: response.headers.get("x-amzn-trace-id") ?? undefined,
    traceParent: response.headers.get("traceparent") ?? undefined,
    traceState: response.headers.get("tracestate") ?? undefined,
    baggage: response.headers.get("baggage") ?? undefined,
    body: signal ? abortable(body, signal) : body,
  };
}
