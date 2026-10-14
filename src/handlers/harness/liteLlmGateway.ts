import z from "zod";
import type { HarnessModelConfiguration } from "@aws-sdk/client-bedrock-agentcore-control";
import { InputValidationError } from "../../errors";

const PROXY_PREFIX = "litellm_proxy/";
const ROUTING_PARAMS = [
  "model",
  "api_base",
  "base_url",
  "custom_llm_provider",
  "use_litellm_proxy",
  "fallbacks",
] as const;

export const liteLlmGatewayModelIdSchema = z
  .string({ error: "enter the model alias configured in your LiteLLM gateway" })
  .trim()
  .refine(
    (value) => value !== "" && value !== PROXY_PREFIX,
    "enter the model alias configured in your LiteLLM gateway",
  );

export const liteLlmGatewayUrlSchema = z
  .string({ error: "enter the LiteLLM gateway API base URL" })
  .trim()
  .min(1, "enter the LiteLLM gateway API base URL")
  .url("enter the LiteLLM gateway as an http(s) URL")
  .regex(/^https?:\/\//, "enter the LiteLLM gateway as an http(s) URL");

export function liteLlmGatewayModelId(modelId: string): string {
  const alias = modelId.trim();
  if (alias === "") return "";
  return alias.startsWith(PROXY_PREFIX) ? alias : `${PROXY_PREFIX}${alias}`;
}

export function toLiteLlmGatewayModel<
  T extends {
    modelId?: string;
    apiBase?: string;
    apiKeyArn?: string;
    apiKeyCredentialName?: string;
    additionalParams?: unknown;
  },
>(model: T): Omit<T, "modelId" | "apiBase"> & { modelId: string; apiBase: string } {
  const result = z
    .object({
      modelId: liteLlmGatewayModelIdSchema,
      apiBase: liteLlmGatewayUrlSchema,
      apiKeyArn: z.string().trim().optional(),
      apiKeyCredentialName: z.string().trim().optional(),
    })
    .safeParse(model);
  if (!result.success) {
    throw new InputValidationError(z.prettifyError(result.error), { cause: result.error });
  }
  if (!result.data.apiKeyArn && !result.data.apiKeyCredentialName) {
    throw new InputValidationError(
      "enter a LiteLLM gateway API-key credential provider ARN or key file",
    );
  }
  // Strands merges additionalParams over the request, including its model route.
  const params = model.additionalParams;
  if (typeof params === "object" && params !== null) {
    const overrides = ROUTING_PARAMS.filter((key) => Object.hasOwn(params, key));
    if (overrides.length > 0) {
      throw new InputValidationError(
        `LiteLLM gateway additionalParams cannot override routing: ${overrides.join(", ")}. ` +
          "Configure routing and fallbacks on the gateway instead.",
      );
    }
  }
  return {
    ...model,
    modelId: liteLlmGatewayModelId(result.data.modelId),
    apiBase: result.data.apiBase,
  };
}

export function toHarnessGatewayModel(
  model: HarnessModelConfiguration | undefined,
): HarnessModelConfiguration | undefined {
  if (!model?.liteLlmModelConfig) return model;
  return { ...model, liteLlmModelConfig: toLiteLlmGatewayModel(model.liteLlmModelConfig) };
}
