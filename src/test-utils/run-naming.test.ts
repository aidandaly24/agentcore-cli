import { uniqueRunName, uniqueRunSuffix } from './run-naming.js';
import { describe, expect, it, vi } from 'vitest';

describe('uniqueRunSuffix / uniqueRunName', () => {
  it('produces an 8-digit run suffix', () => {
    expect(uniqueRunSuffix()).toMatch(/^\d{8}$/);
  });

  it('derives a per-run-unique payment credential-provider name (regression for #1559)', () => {
    // PaymentConnectorPrimitive builds the credential name as `${manager}-${connector}-cdp`
    // (PaymentConnectorPrimitive.ts). Derive it the same way from the e2e test's chosen names
    // and assert it carries a per-run suffix instead of the static 'E2ePayMgr-E2ePayConn-cdp'.
    const deriveCredentialName = (suffix: string): string => {
      const manager = uniqueRunName('E2ePayMgr', suffix);
      const connector = uniqueRunName('E2ePayConn', suffix);
      return `${manager}-${connector}-cdp`;
    };

    vi.spyOn(Date, 'now').mockReturnValue(112233445566);
    const first = deriveCredentialName(uniqueRunSuffix());
    vi.spyOn(Date, 'now').mockReturnValue(112233449999);
    const second = deriveCredentialName(uniqueRunSuffix());
    vi.restoreAllMocks();

    expect(first).toMatch(/^E2ePayMgr\d{8}-E2ePayConn\d{8}-cdp$/);
    expect(first).not.toBe('E2ePayMgr-E2ePayConn-cdp');
    expect(first).not.toBe(second);
  });
});
