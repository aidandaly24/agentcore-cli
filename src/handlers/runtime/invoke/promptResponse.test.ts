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

  test.each([
    ['data: "JSON string"\n\n', "JSON string"],
    ['data: {"text":"text object"}\n\n', "text object"],
    ["data: non-JSON token\n\n", "non-JSON token"],
  ])("streams a shared agent event shape %#", async (wire, expected) => {
    expect(await read(renderPromptResponseBody("text/event-stream", body(Buffer.from(wire))))).toBe(
      expected,
    );
  });

  test("passes through an unsupported SSE frame before the source completes", async () => {
    const finish = Promise.withResolvers<void>();
    const source = (async function* () {
      yield Buffer.from('data: {"progress":1}\n\n');
      await finish.promise;
    })();
    const iterator = renderPromptResponseBody("text/event-stream", source)[Symbol.asyncIterator]();

    const first = await Promise.race([
      iterator.next(),
      Bun.sleep(50).then(() => ({ done: true, value: undefined })),
    ]);
    finish.resolve();
    await iterator.next();

    expect(first).toEqual({
      done: false,
      value: Uint8Array.from(Buffer.from('data: {"progress":1}\n\n')),
    });
  });

  test("ignores non-text Strands frames", async () => {
    const chunks = [
      Buffer.from('data: {"event":{"messageStart":{"role":"assistant"}}}\r\n\r\n'),
      Buffer.from('data: {"event":{"messageStop":{"stopReason":"end_turn"}}}\r\n\r\n'),
    ];

    expect(await read(renderPromptResponseBody("text/event-stream", body(...chunks)))).toBe("");
  });

  test("fails when AgentCore emits an error after partial Strands text", async () => {
    const rendered = renderPromptResponseBody(
      "text/event-stream",
      body(
        Buffer.from('data: {"event":{"contentBlockDelta":{"delta":{"text":"partial"}}}}\n\n'),
        Buffer.from(
          'data: {"error":"Model access denied","error_type":"AccessDeniedException"}\n\n',
        ),
      ),
    );
    const chunks: Uint8Array[] = [];

    await expect(async () => {
      for await (const chunk of rendered) chunks.push(Uint8Array.from(chunk));
    }).toThrow("Model access denied");
    expect(new TextDecoder().decode(Buffer.concat(chunks))).toBe("partial");
  });

  test("fails an initial AgentCore error without rendering its wire frame", async () => {
    const rendered = renderPromptResponseBody(
      "text/event-stream",
      body(Buffer.from('data: {"error":"Model access denied"}\n\n')),
    );
    const chunks: Uint8Array[] = [];

    await expect(async () => {
      for await (const chunk of rendered) chunks.push(Uint8Array.from(chunk));
    }).toThrow("Model access denied");
    expect(chunks).toEqual([]);
  });

  test("propagates an upstream failure after recognizing a Strands stream", async () => {
    const source = (async function* () {
      yield Buffer.from('data: {"event":{"messageStart":{"role":"assistant"}}}\n\n');
      throw new Error("stream failed");
    })();
    const rendered = renderPromptResponseBody("text/event-stream", source);
    const chunks: Uint8Array[] = [];

    await expect(async () => {
      for await (const chunk of rendered) chunks.push(Uint8Array.from(chunk));
    }).toThrow("stream failed");
    expect(chunks).toEqual([]);
  });
});
