import {
  GetApiKeyCredentialProviderCommand,
  GetOauth2CredentialProviderCommand,
  type BedrockAgentCoreControlClient,
} from "@aws-sdk/client-bedrock-agentcore-control";

export type CredentialProviderPolicyState = {
  providerArn: string;
  secretArn: string;
};

export type CredentialProviderPolicyRequest = {
  type: "api-key" | "oauth";
  providerArn: string;
};

export class CredentialProviderPolicyResolver {
  constructor(private readonly control: BedrockAgentCoreControlClient) {}

  async resolve(
    requests: readonly CredentialProviderPolicyRequest[],
  ): Promise<CredentialProviderPolicyState[]> {
    const requestedTypes = new Map<string, CredentialProviderPolicyRequest["type"]>();
    for (const request of requests) {
      const existing = requestedTypes.get(request.providerArn);
      if (existing && existing !== request.type) {
        throw new Error(`Credential provider ${request.providerArn} is configured as two types.`);
      }
      requestedTypes.set(request.providerArn, request.type);
    }

    const providers: CredentialProviderPolicyState[] = [];
    for (const [providerArn, requestedType] of [...requestedTypes].sort(([left], [right]) =>
      left.localeCompare(right),
    )) {
      const identity = credentialProviderIdentity(providerArn);
      if (identity.type !== requestedType) {
        throw new Error(
          `Credential provider ${providerArn} is configured as ${requestedType} but identifies an ${identity.type} provider.`,
        );
      }
      if (identity.type === "api-key") {
        const response = await this.control.send(
          new GetApiKeyCredentialProviderCommand({ name: identity.name }),
        );
        if (response.credentialProviderArn !== providerArn) {
          throw new Error(
            `API key credential provider ${identity.name} returned an unexpected ARN.`,
          );
        }
        const secretArn = response.apiKeySecretArn?.secretArn;
        if (!secretArn) {
          throw new Error(`API key credential provider ${providerArn} returned no secret ARN.`);
        }
        providers.push({ providerArn, secretArn });
        continue;
      }

      const response = await this.control.send(
        new GetOauth2CredentialProviderCommand({ name: identity.name }),
      );
      if (response.credentialProviderArn !== providerArn) {
        throw new Error(`OAuth credential provider ${identity.name} returned an unexpected ARN.`);
      }
      const secretArn = response.clientSecretArn?.secretArn;
      if (!secretArn) {
        throw new Error(`OAuth credential provider ${providerArn} returned no secret ARN.`);
      }
      providers.push({ providerArn, secretArn });
    }
    return providers;
  }
}

function credentialProviderIdentity(providerArn: string): {
  type: "api-key" | "oauth";
  name: string;
} {
  const resource = providerArn.split(":").slice(5).join(":");
  const match = resource.match(
    /^token-vault\/[^/]+\/(apikeycredentialprovider|oauth2credentialprovider)\/([^/]+)$/,
  );
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid credential provider ARN "${providerArn}".`);
  }
  return {
    type: match[1] === "apikeycredentialprovider" ? "api-key" : "oauth",
    name: match[2],
  };
}
