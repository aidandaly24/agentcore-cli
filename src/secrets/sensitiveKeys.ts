const SECRET_SUFFIXES = [
  "_API_KEY_SECRET",
  "_WALLET_SECRET",
  "_AUTHORIZATION_PRIVATE_KEY",
  "_APP_SECRET",
  "_CLIENT_SECRET",
  "_API_KEY",
];

const REFERENCE_SUFFIXES = ["_API_KEY_ID", "_APP_ID", "_CLIENT_ID", "_AUTHORIZATION_ID"];

export function isSensitiveKey(key: string): boolean {
  if (REFERENCE_SUFFIXES.some((suffix) => key.endsWith(suffix))) return false;
  return (
    SECRET_SUFFIXES.some((suffix) => key.endsWith(suffix)) ||
    key.startsWith("AGENTCORE_CREDENTIAL_")
  );
}
