import { expect, test } from "bun:test";
import { resolveScaffoldHarnessInput } from "./index";
import { InputValidationError } from "../../../errors";

test.each([
  ["at the 15-character threshold", "P".repeat(15), /^P{15}$/],
  ["one over the threshold", "P".repeat(16), /^P{9}_[0-9a-f]{5}$/],
  ["at the 23-character project name maximum", "P".repeat(23), /^P{2}_[0-9a-f]{5}$/],
])("the default harness name for a project %s", (_label, projectName, pattern) => {
  expect(resolveScaffoldHarnessInput({ name: projectName }).name).toMatch(pattern);
});

test.each([
  ["bedrock", {}, { bedrockModelConfig: { modelId: "global.anthropic.claude-sonnet-5" } }],
  [
    "open_ai",
    { "api-key-arn": "arn:example:key" },
    { openAiModelConfig: { modelId: "gpt-5", apiKeyArn: "arn:example:key" } },
  ],
  [
    "gemini",
    { "api-key-arn": "arn:example:key" },
    { geminiModelConfig: { modelId: "gemini-2.5-flash", apiKeyArn: "arn:example:key" } },
  ],
  ["lite_llm", {}, { liteLlmModelConfig: { modelId: "bedrock/global.anthropic.claude-sonnet-5" } }],
  [
    "lite_llm",
    {
      "model-id": "custom/model",
      "api-key-arn": "arn:example:key",
      "api-base": "https://example.com",
    },
    {
      liteLlmModelConfig: {
        modelId: "custom/model",
        apiKeyArn: "arn:example:key",
        apiBase: "https://example.com",
      },
    },
  ],
] as const)("constructs a native %s model from scalar inputs", (provider, flags, model) => {
  expect(
    resolveScaffoldHarnessInput({ name: "MyProject", "model-provider": provider, ...flags }),
  ).toEqual({ name: "MyProject", model });
});

test.each([
  { "model-provider": "open_ai" },
  { "model-provider": "gemini" },
  { "model-provider": "anthropic" },
  { "model-provider": "bedrock", "api-key-arn": "arn:example:key" },
  { "model-provider": "bedrock", "api-base": "https://example.com" },
  {
    "model-provider": "open_ai",
    "api-key-arn": "arn:example:key",
    "api-base": "https://example.com",
  },
  {
    "model-provider": "gemini",
    "api-key-arn": "arn:example:key",
    "api-base": "https://example.com",
  },
  { "model-provider": "open_ai", "api-key-arn": "" },
  { "model-id": "" },
] as const)("rejects invalid scalar model options: %j", (flags) => {
  expect(() => resolveScaffoldHarnessInput({ name: "MyProject", ...flags })).toThrow(
    InputValidationError,
  );
});
