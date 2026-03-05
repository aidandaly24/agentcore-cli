import { AUTHORIZER_TYPE_OPTIONS, SKIP_FOR_NOW, TARGET_TYPE_OPTIONS } from '../types.js';
import { describe, expect, it } from 'vitest';

describe('MCP types constants', () => {
  it('AUTHORIZER_TYPE_OPTIONS: AWS_IAM is first option', () => {
    expect(AUTHORIZER_TYPE_OPTIONS[0]?.id).toBe('AWS_IAM');
  });

  it('SKIP_FOR_NOW equals skip-for-now', () => {
    expect(SKIP_FOR_NOW).toBe('skip-for-now');
  });

  it('TARGET_TYPE_OPTIONS has mcpServer entry', () => {
    const mcpServer = TARGET_TYPE_OPTIONS.find((opt: { id: string }) => opt.id === 'mcpServer');
    expect(mcpServer).toBeDefined();
  });
});
