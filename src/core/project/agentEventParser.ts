export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "error"; message: string }
  | { kind: "control" }
  | { kind: "unsupported" };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function textEvent(value: unknown): AgentEvent {
  const text = String(value);
  return text ? { kind: "text", text } : { kind: "control" };
}

export function parseAgentEvent(data: string): AgentEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return data ? { kind: "text", text: data } : { kind: "control" };
  }

  if (typeof parsed === "string") return textEvent(parsed);

  const root = asRecord(parsed);
  if (!root) return { kind: "unsupported" };

  if ("error" in root) {
    const message = String(root.error);
    return message ? { kind: "error", message } : { kind: "control" };
  }
  if ("text" in root) return textEvent(root.text);

  if ("event" in root) {
    const event = asRecord(root.event);
    if (!event) return { kind: "unsupported" };
    const contentBlockDelta = asRecord(event.contentBlockDelta);
    const delta = asRecord(contentBlockDelta?.delta);
    return typeof delta?.text === "string" ? textEvent(delta.text) : { kind: "control" };
  }

  return { kind: "unsupported" };
}
