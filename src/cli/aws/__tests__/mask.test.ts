import { accountIdFromArn, maskAccountId } from '../mask';
import { describe, expect, it } from 'vitest';

describe('maskAccountId', () => {
  it('masks a 12-digit account ID in a Lambda ARN', () => {
    expect(maskAccountId('arn:aws:lambda:us-east-1:111111111111:function:foo')).toBe(
      'arn:aws:lambda:us-east-1:****1111:function:foo'
    );
  });

  it('preserves the last 4 digits', () => {
    expect(maskAccountId('arn:aws:lambda:us-east-1:603141041947:function:foo')).toBe(
      'arn:aws:lambda:us-east-1:****1947:function:foo'
    );
  });

  it('handles non-aws partitions', () => {
    expect(maskAccountId('arn:aws-us-gov:lambda:us-gov-west-1:222222222222:function:bar')).toBe(
      'arn:aws-us-gov:lambda:us-gov-west-1:****2222:function:bar'
    );
  });

  it('masks multiple ARNs in one string', () => {
    const input =
      'gateway: arn:aws:lambda:us-east-1:111111111111:function:a\n  ' +
      'lambda:  arn:aws:lambda:us-east-1:222222222222:function:b';
    expect(maskAccountId(input)).toContain('****1111');
    expect(maskAccountId(input)).toContain('****2222');
  });

  it('passes through non-ARN strings unchanged', () => {
    expect(maskAccountId('foo bar baz')).toBe('foo bar baz');
  });

  it('does not mask numbers shorter than 12 digits', () => {
    expect(maskAccountId('port 8080 timeout 30')).toBe('port 8080 timeout 30');
  });

  it('is idempotent on already-masked output', () => {
    const once = maskAccountId('arn:aws:lambda:us-east-1:111111111111:function:foo');
    expect(maskAccountId(once)).toBe(once);
  });

  it('handles empty input', () => {
    expect(maskAccountId('')).toBe('');
  });
});

describe('accountIdFromArn', () => {
  it('extracts the account ID from a Lambda ARN', () => {
    expect(accountIdFromArn('arn:aws:lambda:us-east-1:111111111111:function:foo')).toBe('111111111111');
  });

  it('returns undefined for masked ARNs', () => {
    expect(accountIdFromArn('arn:aws:lambda:us-east-1:****1111:function:foo')).toBeUndefined();
  });

  it('returns undefined for non-ARN strings', () => {
    expect(accountIdFromArn('not-an-arn')).toBeUndefined();
  });
});
