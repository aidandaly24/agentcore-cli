import { parseAgentEvent, type AgentEvent } from "../../../core/project/agentEventParser";

function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

function parseSseLine(line: string): AgentEvent {
  return line.startsWith("data:")
    ? parseAgentEvent(line.slice(5).trimStart())
    : { kind: "unsupported" };
}

export function renderPromptResponseBody(
  contentType: string,
  body: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (mediaType(contentType) !== "text/event-stream") return body;
  return renderSseBody(body);
}

async function* renderSseBody(body: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pending: Uint8Array[] = [];
  const maxSniffBytes = 64 * 1024;
  let buffer = "";
  let pendingBytes = 0;
  let mode: "sniffing" | "parsed" | "raw" = "sniffing";

  const processParsedLines = function* (lines: string[]): Generator<Uint8Array> {
    for (const line of lines) {
      if (line === "") continue;
      const event = parseSseLine(line);
      if (event.kind === "error") throw new Error(event.message);
      if (event.kind === "text") yield encoder.encode(event.text);
    }
  };

  try {
    for await (const chunk of body) {
      const snapshot = Uint8Array.from(chunk);
      if (mode === "raw") {
        yield snapshot;
        continue;
      }

      buffer += decoder.decode(snapshot, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";

      if (mode === "parsed") {
        yield* processParsedLines(lines);
        continue;
      }

      pending.push(snapshot);
      pendingBytes += snapshot.byteLength;
      const firstLine = lines.find((line) => line !== "");
      if (firstLine !== undefined) {
        const event = parseSseLine(firstLine);
        if (event.kind === "error") {
          mode = "parsed";
          pending.length = 0;
          throw new Error(event.message);
        }
        if (event.kind !== "unsupported") {
          mode = "parsed";
          pending.length = 0;
          yield* processParsedLines(lines);
          continue;
        }
        mode = "raw";
      } else if (pendingBytes >= maxSniffBytes) {
        mode = "raw";
      }

      if (mode === "raw") {
        yield* pending;
        pending.length = 0;
        buffer = "";
      }
    }
  } catch (error) {
    if (mode === "sniffing") yield* pending;
    throw error;
  }

  if (mode === "raw") return;

  buffer += decoder.decode();
  if (mode === "parsed") {
    if (buffer) yield* processParsedLines([buffer]);
    return;
  }

  const event = buffer ? parseSseLine(buffer) : { kind: "unsupported" as const };
  if (event.kind === "error") throw new Error(event.message);
  if (event.kind !== "unsupported") {
    yield* processParsedLines([buffer]);
  } else {
    yield* pending;
  }
}
