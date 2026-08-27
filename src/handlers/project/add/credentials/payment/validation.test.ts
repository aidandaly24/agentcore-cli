import { describe, expect, test } from "bun:test";
import {
  stripWalletAuthPrefix,
  validateApiKeySecret,
  validateAuthorizationPrivateKey,
  validateWalletSecret,
} from "./validation";

const ed25519Key = Buffer.alloc(64, 0x41).toString("base64");
const p256Key = Buffer.alloc(138, 0x41).toString("base64");

describe("payment credential key validation", () => {
  test("accepts supported Coinbase key formats", () => {
    expect(validateApiKeySecret(ed25519Key)).toBe(true);
    expect(validateWalletSecret(p256Key)).toBe(true);
  });

  test("rejects invalid Coinbase key formats", () => {
    expect(validateApiKeySecret("not-base64")).toContain("Ed25519");
    expect(validateApiKeySecret(Buffer.alloc(48, 0x41).toString("base64"))).toContain("length");
    expect(validateWalletSecret(ed25519Key)).toContain("P-256");
  });

  test("accepts and normalizes a prefixed Stripe authorization key", () => {
    expect(validateAuthorizationPrivateKey(`wallet-auth:${p256Key}`)).toBe(true);
    expect(stripWalletAuthPrefix(`wallet-auth:${p256Key}`)).toBe(p256Key);
  });

  test("rejects invalid Stripe authorization keys", () => {
    expect(validateAuthorizationPrivateKey("wallet-auth:not-base64")).toContain("base64");
  });
});
