import { IDENTITY_STEP_LABELS, VENDOR_OPTIONS } from '../types';
import type { AddIdentityStep } from '../types';
import { describe, expect, it } from 'vitest';

describe('VENDOR_OPTIONS constants', () => {
  it('has 16 entries (7 Named + some Included + Custom)', () => {
    expect(VENDOR_OPTIONS).toHaveLength(16);
  });

  it('last entry is CustomOauth2', () => {
    const lastOption = VENDOR_OPTIONS[VENDOR_OPTIONS.length - 1];
    expect(lastOption?.id).toBe('CustomOauth2');
  });

  it('ids include all 7 Named providers', () => {
    const ids = VENDOR_OPTIONS.map(v => v.id);
    expect(ids).toContain('GoogleOauth2');
    expect(ids).toContain('GithubOauth2');
    expect(ids).toContain('SlackOauth2');
    expect(ids).toContain('SalesforceOauth2');
    expect(ids).toContain('MicrosoftOauth2');
    expect(ids).toContain('AtlassianOauth2');
    expect(ids).toContain('LinkedinOauth2');
  });
});

describe('IDENTITY_STEP_LABELS constants', () => {
  it('all keys match AddIdentityStep union values', () => {
    const expectedSteps: AddIdentityStep[] = [
      'type',
      'name',
      'vendor',
      'apiKey',
      'discoveryUrl',
      'tenantId',
      'clientId',
      'clientSecret',
      'scopes',
      'confirm',
    ];
    for (const step of expectedSteps) {
      expect(IDENTITY_STEP_LABELS).toHaveProperty(step);
    }
    expect(Object.keys(IDENTITY_STEP_LABELS)).toHaveLength(expectedSteps.length);
  });
});
