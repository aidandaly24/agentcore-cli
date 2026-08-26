import { describe, expect, test } from "bun:test";
import { renderPromptResponseBody } from "./promptResponse";

function body(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield* chunks;
  })();
}

async function read(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(Uint8Array.from(chunk));
  return new TextDecoder().decode(Buffer.concat(chunks));
}

describe("renderPromptResponseBody", () => {
  test("passes non-SSE response bodies through unchanged", () => {
    const source = body(Buffer.from('{"result":"hello"}'));
    expect(renderPromptResponseBody("application/json", source)).toBe(source);
  });

  test("streams Strands text deltas across arbitrary chunk boundaries", async () => {
    const wire = [
      'data: {"init_event_loop":true}\n\n',
      'data: {"event":{"messageStart":{"role":"assistant"}}}\n\n',
      'data: {"event":{"contentBlockDelta":{"delta":{"text":"Hello"},"contentBlockIndex":0}}}\n\n',
      'data: {"event":{"contentBlockDelta":{"delta":{"toolUse":{"input":"{}"}}}}}\n\n',
      'data: {"event":{"contentBlockDelta":{"delta":{"text":" world"},"contentBlockIndex":0}}}\n\n',
      'data: {"event":{"messageStop":{"stopReason":"end_turn"}}}\n\n',
    ].join("");
    const bytes = Buffer.from(wire);

    expect(
      await read(
        renderPromptResponseBody(
          "text/event-stream; charset=utf-8",
          body(bytes.subarray(0, 19), bytes.subarray(19, 97), bytes.subarray(97)),
        ),
      ),
    ).toBe("Hello world");
  });

  test("preserves whitespace-only Strands text deltas", async () => {
    const wire = 'data: {"event":{"contentBlockDelta":{"delta":{"text":" "}}}}\n\n';

    expect(await read(renderPromptResponseBody("text/event-stream", body(Buffer.from(wire))))).toBe(
      " ",
    );
  });

  test("does not recognize non-Strands SSE event shapes", async () => {
    const chunks = [
      Buffer.from('data: "plain text"\n\n'),
      Buffer.from('data: {"text":"text chunk"}\n\n'),
      Buffer.from('data: {"error":"failed"}\n\n'),
    ];

    expect(await read(renderPromptResponseBody("text/event-stream", body(...chunks)))).toBe(
      new TextDecoder().decode(Buffer.concat(chunks)),
    );
  });

  test("falls back to the exact raw response when no Strands text is found", async () => {
    const chunks = [
      Buffer.from('data: {"event":{"messageStart":{"role":"assistant"}}}\r\n\r\n'),
      Buffer.from('data: {"event":{"messageStop":{"stopReason":"end_turn"}}}\r\n\r\n'),
    ];

    expect(await read(renderPromptResponseBody("text/event-stream", body(...chunks)))).toBe(
      new TextDecoder().decode(Buffer.concat(chunks)),
    );
  });

  test("preserves buffered raw bytes before propagating a stream failure", async () => {
    const source = (async function* () {
      yield Buffer.from('data: {"event":{"messageStart":{"role":"assistant"}}}\n\n');
      throw new Error("stream failed");
    })();
    const rendered = renderPromptResponseBody("text/event-stream", source);
    const chunks: Uint8Array[] = [];

    await expect(async () => {
      for await (const chunk of rendered) chunks.push(Uint8Array.from(chunk));
    }).toThrow("stream failed");
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe(
      'data: {"event":{"messageStart":{"role":"assistant"}}}\n\n',
    );
  });
});
