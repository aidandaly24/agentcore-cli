function mediaType(contentType: string): string {
  return contentType.split(";", 1)[0]!.trim().toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parseStrandsTextDelta(line: string): string | undefined {
  if (!line.startsWith("data:")) return undefined;
  const raw = line.slice(5).trimStart();

  try {
    const parsed: unknown = JSON.parse(raw);
    const event = asRecord(asRecord(parsed)?.event);
    const contentBlockDelta = asRecord(event?.contentBlockDelta);
    const delta = asRecord(contentBlockDelta?.delta);
    return typeof delta?.text === "string" ? delta.text : undefined;
  } catch {
    return undefined;
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
  const rawChunks: Uint8Array[] = [];
  let buffer = "";
  let rendered = false;

  const processLines = function* (lines: string[]): Generator<Uint8Array> {
    for (const line of lines) {
      const text = parseStrandsTextDelta(line);
      if (text === undefined) continue;
      if (!rendered) {
        rendered = true;
        rawChunks.length = 0;
      }
      yield encoder.encode(text);
    }
  };

  try {
    for await (const chunk of body) {
      const snapshot = Uint8Array.from(chunk);
      if (!rendered) rawChunks.push(snapshot);

      buffer += decoder.decode(snapshot, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      yield* processLines(lines);
    }
  } catch (error) {
    if (!rendered) yield* rawChunks;
    throw error;
  }

  buffer += decoder.decode();
  if (buffer) yield* processLines([buffer]);
  if (!rendered) yield* rawChunks;
}
