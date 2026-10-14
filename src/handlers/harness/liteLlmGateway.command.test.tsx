import { describe, expect, test } from "bun:test";
import { createRootHandler } from "../index";
import { InputValidationError } from "../../errors";
import {
  createSilentLogger,
  TestCoreClient,
  TestGlobalConfigAccessor,
  testIO,
} from "../../testing";

async function run(args: string[], core: TestCoreClient) {
  const root = createRootHandler(core, {
    io: testIO().io,
    logger: createSilentLogger(),
    globalConfigAccessor: new TestGlobalConfigAccessor(),
  });
  await root.route(["node", "agentcore", ...args, "--region", "us-west-2"]);
}

describe.each([
  ["create", ["--name", "GatewayHarness"], "createHarness"],
  ["update", ["--id", "GatewayHarness-abc123"], "updateHarness"],
] as const)("harness %s LiteLLM gateway", (command, flags, method) => {
  test.each([undefined, "", " ", "not-a-url", "ftp://gateway.example.com"])(
    "rejects %j before any Core call",
    async (apiBase) => {
      const core = new TestCoreClient();
      const model = { liteLlmModelConfig: { modelId: "my-model", apiBase } };
      await expect(
        run(["harness", command, ...flags, "--model", JSON.stringify(model)], core),
      ).rejects.toBeInstanceOf(InputValidationError);
      expect(core.harness.calls).toEqual([]);
    },
  );

  test("rejects an additionalParams model override before any Core call", async () => {
    const core = new TestCoreClient();
    const model = {
      liteLlmModelConfig: {
        modelId: "my-model",
        apiBase: "https://gateway.example.com/v1",
        apiKeyArn: "arn:gateway-key",
        additionalParams: { model: "bedrock/direct-model" },
      },
    };
    await expect(
      run(["harness", command, ...flags, "--model", JSON.stringify(model)], core),
    ).rejects.toThrow("cannot override routing: model");
    expect(core.harness.calls).toEqual([]);
  });

  test("rejects a missing gateway credential before any Core call", async () => {
    const core = new TestCoreClient();
    const model = {
      liteLlmModelConfig: { modelId: "my-model", apiBase: "https://gateway.example.com/v1" },
    };
    await expect(
      run(["harness", command, ...flags, "--model", JSON.stringify(model)], core),
    ).rejects.toThrow("enter a LiteLLM gateway API-key credential provider ARN or key file");
    expect(core.harness.calls).toEqual([]);
  });

  test.each(["my-model", "litellm_proxy/my-model"])(
    "sends the gateway route for %s and preserves parameters",
    async (modelId) => {
      const core = new TestCoreClient();
      const model = {
        liteLlmModelConfig: {
          modelId,
          apiBase: "https://gateway.example.com/v1",
          apiKeyArn: "arn:gateway-key",
          maxTokens: 512,
        },
      };
      await run(["harness", command, ...flags, "--model", JSON.stringify(model)], core);
      const call = core.harness.calls.find((call) => call.method === method)!;
      expect((call.args[0] as { model: unknown }).model).toEqual({
        liteLlmModelConfig: {
          ...model.liteLlmModelConfig,
          modelId: "litellm_proxy/my-model",
        },
      });
    },
  );
});
