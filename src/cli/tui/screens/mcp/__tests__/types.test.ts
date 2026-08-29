import {
  AUTHORIZER_TYPE_OPTIONS,
  ENTER_KB_ID_MANUALLY,
  PYTHON_VERSION_OPTIONS,
  SKIP_FOR_NOW,
  TARGET_TYPE_OPTIONS,
} from '../types.js';
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

  it('TARGET_TYPE_OPTIONS exposes a connector (Knowledge Base) entry', () => {
    const connector = TARGET_TYPE_OPTIONS.find((opt: { id: string }) => opt.id === 'connector');
    expect(connector).toBeDefined();
    expect(connector?.title).toBe('Knowledge Base');
  });

  it('ENTER_KB_ID_MANUALLY is a stable sentinel id', () => {
    // Sentinel for the "Enter an existing KB ID manually..." picker entry —
    // the screen branches on this exact id when the user picks the manual path.
    expect(ENTER_KB_ID_MANUALLY).toBe('__enter_kb_id__');
  });

  it('PYTHON_VERSION_OPTIONS defaults to a universally-available runtime, not PYTHON_3_14', () => {
    // 3.14 is not yet GA in every region, so it must not be the first/highlighted pick.
    expect(PYTHON_VERSION_OPTIONS[0]?.id).toBe('PYTHON_3_13');
    expect(PYTHON_VERSION_OPTIONS[0]?.id).not.toBe('PYTHON_3_14');
    // 3.14 stays selectable for users in supported regions.
    expect(PYTHON_VERSION_OPTIONS.some(opt => opt.id === 'PYTHON_3_14')).toBe(true);
  });
});
