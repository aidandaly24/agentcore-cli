import z from "zod";
import { InputValidationError } from "../../../../../errors";
import { type AppIO, SourceResolver } from "../../../../../io";
import type { PaymentProvider } from "../../../../../projectSchemas/payment";
import { flag } from "../../../../../router";
import type { EnvLocalEntry } from "../../../types";
import { credentialEnvVarName } from "../shared";
import {
  stripWalletAuthPrefix,
  validateApiKeySecret,
  validateAuthorizationPrivateKey,
  validateWalletSecret,
} from "./validation";

export const paymentCredentialInputFlags = [
  flag("api-key-id", "Coinbase CDP API key ID", z.string().optional()),
  flag(
    "api-key-secret",
    "Coinbase CDP API key secret (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag(
    "wallet-secret",
    "Coinbase CDP wallet secret (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag("app-id", "Privy application ID", z.string().optional()),
  flag(
    "app-secret",
    "Privy application secret (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag(
    "authorization-private-key",
    "Stripe/Privy authorization private key (file://path or - for stdin; inline values are rejected)",
    z.string().optional(),
    { sensitive: true },
  ),
  flag("authorization-id", "Stripe/Privy authorization identifier", z.string().optional()),
] as const;

export type PaymentCredentialInputFlags = {
  "api-key-id"?: string;
  "api-key-secret"?: string;
  "wallet-secret"?: string;
  "app-id"?: string;
  "app-secret"?: string;
  "authorization-private-key"?: string;
  "authorization-id"?: string;
};

const COINBASE_FLAGS = ["api-key-id", "api-key-secret", "wallet-secret"] as const;
const STRIPE_FLAGS = [
  "app-id",
  "app-secret",
  "authorization-private-key",
  "authorization-id",
] as const;

export function hasPaymentCredentialInput(flags: PaymentCredentialInputFlags): boolean {
  return [...COINBASE_FLAGS, ...STRIPE_FLAGS].some((name) => flags[name] !== undefined);
}

export async function resolvePaymentCredentialEnvEntries(input: {
  name: string;
  provider: PaymentProvider;
  flags: PaymentCredentialInputFlags;
  io: AppIO;
}): Promise<EnvLocalEntry[]> {
  const { name, provider, flags, io } = input;
  const invalidFlags = (provider === "CoinbaseCDP" ? STRIPE_FLAGS : COINBASE_FLAGS).filter(
    (flagName) => flags[flagName] !== undefined,
  );
  if (invalidFlags.length > 0) {
    throw new InputValidationError(
      `${invalidFlags.map((flagName) => `--${flagName}`).join(", ")} ${
        invalidFlags.length === 1 ? "is" : "are"
      } not valid with --provider ${provider}`,
    );
  }

  const resolver = new SourceResolver({ stdin: io.stdin });
  if (provider === "StripePrivy") {
    const appSecret = await resolver.resolveSecret("app-secret", flags["app-secret"]);
    const resolvedAuthorizationPrivateKey = await resolver.resolveSecret(
      "authorization-private-key",
      flags["authorization-private-key"],
    );
    const authorizationPrivateKey =
      resolvedAuthorizationPrivateKey === undefined
        ? undefined
        : stripWalletAuthPrefix(resolvedAuthorizationPrivateKey);
    if (authorizationPrivateKey !== undefined) {
      const validation = validateAuthorizationPrivateKey(authorizationPrivateKey);
      if (validation !== true) throw new InputValidationError(validation);
    }
    return [
      {
        key: credentialEnvVarName(name, "_APP_ID"),
        value: flags["app-id"],
        comment: `Privy application ID for payment credential provider '${name}' (set before deploy)`,
      },
      {
        key: credentialEnvVarName(name, "_APP_SECRET"),
        value: appSecret,
        comment: `Privy application secret for payment credential provider '${name}' (set before deploy)`,
      },
      {
        key: credentialEnvVarName(name, "_AUTHORIZATION_PRIVATE_KEY"),
        value: authorizationPrivateKey,
        comment: `Stripe/Privy authorization private key for payment credential provider '${name}' (set before deploy)`,
      },
      {
        key: credentialEnvVarName(name, "_AUTHORIZATION_ID"),
        value: flags["authorization-id"],
        comment: `Stripe/Privy authorization ID for payment credential provider '${name}' (set before deploy)`,
      },
    ];
  }

  const apiKeySecret = await resolver.resolveSecret("api-key-secret", flags["api-key-secret"]);
  const walletSecret = await resolver.resolveSecret("wallet-secret", flags["wallet-secret"]);
  if (apiKeySecret !== undefined) {
    const validation = validateApiKeySecret(apiKeySecret);
    if (validation !== true) throw new InputValidationError(validation);
  }
  if (walletSecret !== undefined) {
    const validation = validateWalletSecret(walletSecret);
    if (validation !== true) throw new InputValidationError(validation);
  }
  return [
    {
      key: credentialEnvVarName(name, "_API_KEY_ID"),
      value: flags["api-key-id"],
      comment: `Coinbase CDP API key ID for payment credential provider '${name}' (set before deploy)`,
    },
    {
      key: credentialEnvVarName(name, "_API_KEY_SECRET"),
      value: apiKeySecret,
      comment: `Coinbase CDP API key secret for payment credential provider '${name}' (set before deploy)`,
    },
    {
      key: credentialEnvVarName(name, "_WALLET_SECRET"),
      value: walletSecret,
      comment: `Coinbase CDP wallet secret for payment credential provider '${name}' (set before deploy)`,
    },
  ];
}
