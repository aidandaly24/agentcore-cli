const BASE64_PATTERN = /^[A-Za-z0-9+/]+=*$/;
const ED25519_KEY_LENGTHS = new Set([32, 64]);
const P256_MIN_BYTES = 100;
const P256_MAX_BYTES = 200;
const WALLET_AUTH_PREFIX = "wallet-auth:";

function decodedBase64Length(value: string): number | undefined {
  if (!BASE64_PATTERN.test(value)) return undefined;
  return Buffer.from(value, "base64").length;
}

export function validateApiKeySecret(value: string): true | string {
  const length = decodedBase64Length(value.trim());
  if (length === undefined) return "apiKeySecret must be a base64-encoded Ed25519 private key";
  if (!ED25519_KEY_LENGTHS.has(length)) {
    return "apiKeySecret must be a base64-encoded Ed25519 private key (unexpected length)";
  }
  return true;
}

export function validateWalletSecret(value: string): true | string {
  const length = decodedBase64Length(value.trim());
  if (length === undefined) return "walletSecret must be a base64-encoded EC P-256 private key";
  if (length < P256_MIN_BYTES || length > P256_MAX_BYTES) {
    return "walletSecret must be a base64-encoded EC P-256 private key (unexpected length)";
  }
  return true;
}

export function stripWalletAuthPrefix(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith(WALLET_AUTH_PREFIX)
    ? trimmed.slice(WALLET_AUTH_PREFIX.length)
    : trimmed;
}

export function validateAuthorizationPrivateKey(value: string): true | string {
  const length = decodedBase64Length(stripWalletAuthPrefix(value));
  if (length === undefined) return "authorizationPrivateKey must be base64-encoded";
  if (length < P256_MIN_BYTES || length > P256_MAX_BYTES) {
    return "authorizationPrivateKey must be a base64-encoded EC P-256 private key (unexpected length)";
  }
  return true;
}
