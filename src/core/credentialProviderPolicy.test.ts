import { describe, expect, test } from "bun:test";
import {
  GetApiKeyCredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";
import { CredentialProviderPolicyResolver } from "./credentialProviderPolicy";

const API_KEY_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/apikeycredentialprovider/openai";
const OAUTH_ARN =
  "arn:aws:bedrock-agentcore:us-west-2:123456789012:token-vault/default/oauth2credentialprovider/gateway";

describe("CredentialProviderPolicyResolver", () => {
  test("resolves each typed provider to its exact backing secret", async () => {
    const control = {
      send: async (
        command: GetApiKeyCredentialProviderCommand | GetOauth2CredentialProviderCommand,
      ) => {
        if (command instanceof GetApiKeyCredentialProviderCommand) {
          return {
            credentialProviderArn: API_KEY_ARN,
            apiKeySecretArn: {
              secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:openai",
            },
          };
        }
        return {
          credentialProviderArn: OAUTH_ARN,
          clientSecretArn: {
            secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:gateway",
          },
        };
      },
    } as unknown as BedrockAgentCoreControlClient;

    await expect(
      new CredentialProviderPolicyResolver(control).resolve([
        { type: "oauth", providerArn: OAUTH_ARN },
        { type: "api-key", providerArn: API_KEY_ARN },
        { type: "api-key", providerArn: API_KEY_ARN },
      ]),
    ).resolves.toEqual([
      {
        providerArn: API_KEY_ARN,
        secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:openai",
      },
      {
        providerArn: OAUTH_ARN,
        secretArn: "arn:aws:secretsmanager:us-west-2:123456789012:secret:gateway",
      },
    ]);
  });

  test("rejects a provider ARN whose kind contradicts its configuration", async () => {
    const control = {
      send: async () => {
        throw new Error("mismatch must fail before the service read");
      },
    } as unknown as BedrockAgentCoreControlClient;

    await expect(
      new CredentialProviderPolicyResolver(control).resolve([
        { type: "api-key", providerArn: OAUTH_ARN },
      ]),
    ).rejects.toThrow(/configured as api-key.*identifies an oauth provider/);
  });
});
