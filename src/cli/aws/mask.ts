/**
 * PII masking utility for AWS account IDs.
 *
 * Account IDs are sensitive — they uniquely identify the customer's AWS account
 * in any system that aggregates user-visible CLI output (logs, telemetry,
 * support tickets, screenshots). The masker rewrites any 12-digit account-ID
 * segment in an ARN to `****<last4>` so the rest of the ARN structure is
 * preserved while the account ID itself is obscured.
 *
 * Used by:
 *   - The cross-account interceptor preflight warning (preflight.ts)
 *   - logs/invoke interceptor external-mode remediation messages
 *     (interceptor-mode-check.ts)
 *
 * Idempotent on already-masked input.
 */

const ACCOUNT_ID_RE = /\b\d{12}\b/g;
// Recognize an already-masked account-ID-like segment (`****1234`) to keep the
// helper idempotent.
const MASKED_RE = /\*{4}\d{4}/;

/**
 * Replace any 12-digit account-ID segment with `****<last4>`.
 *
 * Handles ARNs (`arn:aws:lambda:us-east-1:111111111111:function:foo`),
 * multi-ARN strings, and bare 12-digit IDs. Non-12-digit numbers are left
 * alone (no false positives on resource IDs, port numbers, timeouts, etc.).
 */
export function maskAccountId(input: string): string {
  if (!input) return input;
  return input.replace(ACCOUNT_ID_RE, m => `****${m.slice(-4)}`);
}

/**
 * Extract the 12-digit account ID from an ARN. Returns `undefined` if the
 * input is not an ARN or already masked.
 */
export function accountIdFromArn(arn: string): string | undefined {
  if (MASKED_RE.test(arn)) return undefined;
  const m = /:(\d{12}):/.exec(arn);
  return m?.[1];
}
