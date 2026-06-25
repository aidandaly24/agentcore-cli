/**
 * Valid global-config keys in dot notation, mirroring the shape of
 * GlobalConfigSchemaStrict in src/lib/schemas/io/global-config.ts. Hand-written
 * so each key can carry a human-readable hint the schema alone cannot provide.
 */
export const CONFIG_KEYS: readonly { key: string; description: string }[] = [
  { key: 'installationId', description: 'Anonymous installation identifier (UUID)' },
  { key: 'uvDefaultIndex', description: 'Default package index URL passed to uv' },
  { key: 'uvIndex', description: 'Additional package index URL passed to uv' },
  { key: 'disableTransactionSearch', description: 'Disable transaction search (boolean)' },
  { key: 'transactionSearchIndexPercentage', description: 'Transaction search index percentage (integer 0-100)' },
  { key: 'telemetry.enabled', description: 'Enable anonymous usage analytics (boolean)' },
  { key: 'telemetry.endpoint', description: 'Telemetry collection endpoint URL' },
  { key: 'telemetry.audit', description: 'Log every telemetry event locally (boolean)' },
] as const;

export function formatConfigKeys(): string {
  const width = Math.max(...CONFIG_KEYS.map(k => k.key.length));
  return CONFIG_KEYS.map(({ key, description }) => `  ${key.padEnd(width)}  ${description}`).join('\n');
}
