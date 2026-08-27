import { describe, expect, test } from "bun:test";
import { parseAgentEvent, type AgentEvent } from "./agentEventParser";

describe("parseAgentEvent", () => {
  test.each([
    {
      name: "JSON string",
      data: JSON.stringify("string token"),
      expected: { kind: "text", text: "string token" },
    },
    {
      name: "text object",
      data: JSON.stringify({ text: "text token" }),
      expected: { kind: "text", text: "text token" },
    },
    {
      name: "Converse text delta",
      data: JSON.stringify({
        event: { contentBlockDelta: { delta: { text: "delta token" } } },
      }),
      expected: { kind: "text", text: "delta token" },
    },
    {
      name: "non-JSON token",
      data: "raw token",
      expected: { kind: "text", text: "raw token" },
    },
  ] satisfies { name: string; data: string; expected: AgentEvent }[])(
    "extracts a $name",
    ({ data, expected }) => {
      expect(parseAgentEvent(data)).toEqual(expected);
    },
  );

  test("extracts an error object", () => {
    expect(parseAgentEvent(JSON.stringify({ error: "model denied" }))).toEqual({
      kind: "error",
      message: "model denied",
    });
  });

  test.each([
    {
      name: "message start",
      data: JSON.stringify({ event: { messageStart: { role: "assistant" } } }),
    },
    {
      name: "message stop",
      data: JSON.stringify({ event: { messageStop: { stopReason: "end_turn" } } }),
    },
    { name: "empty JSON string", data: JSON.stringify("") },
    { name: "blank text", data: JSON.stringify({ text: "" }) },
    { name: "blank error", data: JSON.stringify({ error: "" }) },
    { name: "empty non-JSON token", data: "" },
  ])("identifies $name as control", ({ data }) => {
    expect(parseAgentEvent(data)).toEqual({ kind: "control" });
  });

  test.each([
    { name: "unknown object", data: JSON.stringify({ progress: 1 }) },
    { name: "JSON number", data: JSON.stringify(42) },
    { name: "JSON boolean", data: JSON.stringify(true) },
    { name: "JSON null", data: JSON.stringify(null) },
    { name: "JSON array", data: JSON.stringify(["token"]) },
    { name: "malformed event", data: JSON.stringify({ event: "not-an-object" }) },
  ])("identifies an unsupported $name", ({ data }) => {
    expect(parseAgentEvent(data)).toEqual({ kind: "unsupported" });
  });
});
