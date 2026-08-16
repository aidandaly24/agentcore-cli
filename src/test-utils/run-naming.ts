/**
 * Per-run naming helpers for e2e tests.
 *
 * Some AWS resources (e.g. payment credential providers) are unique only per
 * account+region with no project/run scoping. Tests must therefore derive
 * resource names with a per-run suffix so a leftover resource from a crashed
 * prior run or a concurrent CI pipeline sharing the account does not collide.
 */

/**
 * Returns an 8-character run suffix derived from the current time. Two calls
 * made on different runs (or > ~100ms apart) produce different values.
 */
export function uniqueRunSuffix(): string {
  return String(Date.now()).slice(-8);
}

/**
 * Returns `base` with a per-run unique suffix appended, e.g.
 * `uniqueRunName('E2ePayMgr')` -> `E2ePayMgr12345678`.
 */
export function uniqueRunName(base: string, suffix: string = uniqueRunSuffix()): string {
  return `${base}${suffix}`;
}
