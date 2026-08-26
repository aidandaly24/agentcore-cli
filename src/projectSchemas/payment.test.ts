import { describe, expect, it } from "bun:test";
import { PaymentConnectorSchema, PaymentManagerSchema } from "./payment";

describe("payment connector schema", () => {
  it("accepts manual connectors with implicit or explicit provisioning mode", () => {
    const connector = {
      name: "coinbase",
      provider: "CoinbaseCDP",
      credentialName: "coinbase-credential",
    };

    expect(PaymentConnectorSchema.safeParse(connector).success).toBe(true);
    expect(
      PaymentConnectorSchema.safeParse({ ...connector, provisionMode: "MANUAL" }).success,
    ).toBe(true);
  });

  it("accepts Coinbase Quick Create without a credential", () => {
    expect(
      PaymentConnectorSchema.safeParse({
        name: "coinbase",
        provider: "CoinbaseCDP",
        provisionMode: "QUICK_CREATE",
      }).success,
    ).toBe(true);
  });

  it("rejects StripePrivy Quick Create and Quick Create credential references", () => {
    expect(
      PaymentConnectorSchema.safeParse({
        name: "stripe",
        provider: "StripePrivy",
        provisionMode: "QUICK_CREATE",
      }).success,
    ).toBe(false);
    expect(
      PaymentConnectorSchema.safeParse({
        name: "coinbase",
        provider: "CoinbaseCDP",
        provisionMode: "QUICK_CREATE",
        credentialName: "unexpected",
      }).success,
    ).toBe(false);
  });
});

describe("payment manager custom validation", () => {
  it("requires JWT authorizer configuration only for CUSTOM_JWT", () => {
    expect(
      PaymentManagerSchema.safeParse({
        name: "payments",
        authorizerType: "CUSTOM_JWT",
      }).success,
    ).toBe(false);
    expect(
      PaymentManagerSchema.safeParse({
        name: "payments",
        authorizerType: "CUSTOM_JWT",
        authorizerConfiguration: {
          customJWTAuthorizer: {
            discoveryUrl: "https://example.com/.well-known/openid-configuration",
          },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects duplicate connector names within one manager", () => {
    const connector = {
      name: "duplicate",
      provider: "CoinbaseCDP",
      credentialName: "credential",
    };

    expect(
      PaymentManagerSchema.safeParse({
        name: "payments",
        connectors: [connector, connector],
      }).success,
    ).toBe(false);
  });
});
