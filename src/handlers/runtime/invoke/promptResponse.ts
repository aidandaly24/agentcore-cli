function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

type ParsedSseLine =
  { kind: "strands"; text?: string } | { kind: "error"; message: string } | { kind: "unknown" };

function parseSseLine(line: string): ParsedSseLine {
  if (!line.startsWith("data:")) return { kind: "unknown" };
  const raw = line.slice(5).trimStart();

  try {
    const parsed: unknown = JSON.parse(raw);
    const root = asRecord(parsed);
    if (!root) return { kind: "unknown" };
    if ("error" in root) {
      return {
        kind: "error",
        message: String(root.error) || "Runtime response stream failed",
      };
    }

    const event = asRecord(root.event);
    if (!event) return { kind: "unknown" };

    const contentBlockDelta = asRecord(event?.contentBlockDelta);
    const delta = asRecord(contentBlockDelta?.delta);
    return typeof delta?.text === "string"
      ? { kind: "strands", text: delta.text }
      : { kind: "strands" };
  } catch {
    return { kind: "unknown" };
  }
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
  let mode: "sniffing" | "strands" | "raw" = "sniffing";

  const processStrandsLines = function* (lines: string[]): Generator<Uint8Array> {
    for (const line of lines) {
      if (line === "") continue;
      const parsed = parseSseLine(line);
      if (parsed.kind === "error") throw new Error(parsed.message);
      if (parsed.kind === "strands" && parsed.text !== undefined) {
        yield encoder.encode(parsed.text);
      }
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

      if (mode === "strands") {
        yield* processStrandsLines(lines);
        continue;
      }

      pending.push(snapshot);
      pendingBytes += snapshot.byteLength;
      const firstLine = lines.find((line) => line !== "");
      if (firstLine !== undefined) {
        const parsed = parseSseLine(firstLine);
        if (parsed.kind === "error") {
          mode = "strands";
          pending.length = 0;
          throw new Error(parsed.message);
        }
        if (parsed.kind === "strands") {
          mode = "strands";
          pending.length = 0;
          yield* processStrandsLines(lines);
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
  if (mode === "strands") {
    if (buffer) yield* processStrandsLines([buffer]);
    return;
  }

  const parsed = buffer ? parseSseLine(buffer) : { kind: "unknown" as const };
  if (parsed.kind === "error") throw new Error(parsed.message);
  if (parsed.kind === "strands") {
    yield* processStrandsLines([buffer]);
  } else {
    yield* pending;
  }
}
