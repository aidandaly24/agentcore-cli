import { handleValidate } from '../action.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  mockReadProjectSpec,
  mockReadAWSDeploymentTargets,
  mockReadDeployedState,
  mockReadMcpSpec,
  mockReadMcpDefs,
  mockConfigExists,
  mockFindConfigRoot,
} = vi.hoisted(() => ({
  mockReadProjectSpec: vi.fn(),
  mockReadAWSDeploymentTargets: vi.fn(),
  mockReadDeployedState: vi.fn(),
  mockReadMcpSpec: vi.fn(),
  mockReadMcpDefs: vi.fn(),
  mockConfigExists: vi.fn(),
  mockFindConfigRoot: vi.fn(),
}));

vi.mock('../../../../lib/index.js', () => {
  class NoProjectError extends Error {
    constructor(msg?: string) {
      super(msg ?? 'No agentcore project found');
      this.name = 'NoProjectError';
    }
  }

  class ConfigValidationError extends Error {}
  class ConfigParseError extends Error {
    constructor(
      public readonly filePath: string,
      public override readonly cause: unknown
    ) {
      super(`Parse error at ${filePath}`);
    }
  }
  class ConfigReadError extends Error {
    constructor(
      public readonly filePath: string,
      public override readonly cause: unknown
    ) {
      super(`Read error at ${filePath}`);
    }
  }
  class ConfigNotFoundError extends Error {
    constructor(
      public readonly filePath: string,
      public readonly fileType: string
    ) {
      super(`${fileType} not found at ${filePath}`);
    }
  }

  return {
    ConfigIO: class {
      readProjectSpec = mockReadProjectSpec;
      readAWSDeploymentTargets = mockReadAWSDeploymentTargets;
      readDeployedState = mockReadDeployedState;
      readMcpSpec = mockReadMcpSpec;
      readMcpDefs = mockReadMcpDefs;
      configExists = mockConfigExists;
    },
    ConfigValidationError,
    ConfigParseError,
    ConfigReadError,
    ConfigNotFoundError,
    NoProjectError,
    findConfigRoot: mockFindConfigRoot,
  };
});

describe('handleValidate', () => {
  afterEach(() => vi.clearAllMocks());

  it('returns error when no project found', async () => {
    mockFindConfigRoot.mockReturnValue(null);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('No agentcore project found');
    expect(result.results).toEqual([]);
  });

  it('returns success when all configs are valid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(5);
    expect(result.results[0]).toEqual({ file: 'agentcore.json', success: true });
    expect(result.results[1]).toEqual({ file: 'aws-targets.json', success: true });
    // Optional files skipped
    expect(result.results[2]).toEqual({ file: 'mcp.json', success: true, skipped: true });
    expect(result.results[3]).toEqual({ file: 'mcp-defs.json', success: true, skipped: true });
    expect(result.results[4]).toEqual({ file: '.cli/state.json', success: true, skipped: true });
  });

  it('returns error when project spec fails', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockRejectedValue(new Error('invalid project'));
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid project');
    // Should still report results for all files
    expect(result.results).toHaveLength(5);
    expect(result.results[0]?.success).toBe(false);
  });

  it('returns error when AWS targets fails', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockRejectedValue(new Error('bad targets'));
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('bad targets');
  });

  it('validates state file when it exists', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockImplementation((type: string) => type === 'state');
    mockReadDeployedState.mockResolvedValue({ targets: {} });

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(mockReadDeployedState).toHaveBeenCalled();
  });

  it('returns error when state file is invalid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockImplementation((type: string) => type === 'state');
    mockReadDeployedState.mockRejectedValue(new Error('bad state'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('bad state');
  });

  it('uses custom directory when provided', async () => {
    mockFindConfigRoot.mockReturnValue('/custom/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({ directory: '/custom' });

    expect(result.success).toBe(true);
    expect(mockFindConfigRoot).toHaveBeenCalledWith('/custom');
  });

  it('formats ConfigValidationError with its message', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigValidationError } = await import('../../../../lib/index.js');
    const err = new Error('field "name" is required');
    Object.setPrototypeOf(err, ConfigValidationError.prototype);
    mockReadProjectSpec.mockRejectedValue(err);
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('field "name" is required');
  });

  it('formats ConfigParseError with cause', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigParseError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new ConfigParseError('agentcore.json', new Error('Unexpected token')));
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid JSON in agentcore.json');
    expect(result.error).toContain('Unexpected token');
  });

  it('formats ConfigReadError with cause', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigReadError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(
      new ConfigReadError('agentcore.json', new Error('EACCES: permission denied'))
    );
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to read agentcore.json');
    expect(result.error).toContain('EACCES');
  });

  it('formats ConfigNotFoundError with file name', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    const { ConfigNotFoundError } = await import('../../../../lib/index.js');
    mockReadProjectSpec.mockRejectedValue(new ConfigNotFoundError('/path/agentcore.json', 'project'));
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('Required file not found: agentcore.json');
  });

  it('formats non-Error values as strings', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockRejectedValue('string error');
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toBe('string error');
  });

  it('validates mcp.json when it exists', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockImplementation((type: string) => type === 'mcp');
    mockReadMcpSpec.mockResolvedValue({ mcpServers: {} });

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(mockReadMcpSpec).toHaveBeenCalled();
    const mcpResult = result.results.find(r => r.file === 'mcp.json');
    expect(mcpResult).toEqual({ file: 'mcp.json', success: true });
  });

  it('returns error when mcp.json is invalid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockImplementation((type: string) => type === 'mcp');
    mockReadMcpSpec.mockRejectedValue(new Error('invalid mcp config'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid mcp config');
    const mcpResult = result.results.find(r => r.file === 'mcp.json');
    expect(mcpResult?.success).toBe(false);
    expect(mcpResult?.error).toContain('invalid mcp config');
  });

  it('skips mcp.json when not present', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(mockReadMcpSpec).not.toHaveBeenCalled();
    const mcpResult = result.results.find(r => r.file === 'mcp.json');
    expect(mcpResult).toEqual({ file: 'mcp.json', success: true, skipped: true });
  });

  it('validates mcp-defs.json when it exists', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockImplementation((type: string) => type === 'mcpDefs');
    mockReadMcpDefs.mockResolvedValue({ tools: [] });

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(mockReadMcpDefs).toHaveBeenCalled();
    const mcpDefsResult = result.results.find(r => r.file === 'mcp-defs.json');
    expect(mcpDefsResult).toEqual({ file: 'mcp-defs.json', success: true });
  });

  it('returns error when mcp-defs.json is invalid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockImplementation((type: string) => type === 'mcpDefs');
    mockReadMcpDefs.mockRejectedValue(new Error('invalid mcp definitions'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.error).toContain('invalid mcp definitions');
    const mcpDefsResult = result.results.find(r => r.file === 'mcp-defs.json');
    expect(mcpDefsResult?.success).toBe(false);
    expect(mcpDefsResult?.error).toContain('invalid mcp definitions');
  });

  it('skips mcp-defs.json when not present', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(false);

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(mockReadMcpDefs).not.toHaveBeenCalled();
    const mcpDefsResult = result.results.find(r => r.file === 'mcp-defs.json');
    expect(mcpDefsResult).toEqual({ file: 'mcp-defs.json', success: true, skipped: true });
  });

  it('reports all errors instead of stopping on first failure', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockRejectedValue(new Error('bad project'));
    mockReadAWSDeploymentTargets.mockRejectedValue(new Error('bad targets'));
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockRejectedValue(new Error('bad mcp'));
    mockReadMcpDefs.mockRejectedValue(new Error('bad mcp defs'));
    mockReadDeployedState.mockRejectedValue(new Error('bad state'));

    const result = await handleValidate({});

    expect(result.success).toBe(false);
    expect(result.results).toHaveLength(5);
    // All files should have been validated (not stopped on first)
    expect(result.results.every(r => !r.success)).toBe(true);
    expect(result.error).toContain('bad project');
    expect(result.error).toContain('bad targets');
    expect(result.error).toContain('bad mcp');
    expect(result.error).toContain('bad mcp defs');
    expect(result.error).toContain('bad state');
  });

  it('validates all 5 files when all exist and are valid', async () => {
    mockFindConfigRoot.mockReturnValue('/project/agentcore');
    mockReadProjectSpec.mockResolvedValue({ name: 'Test', agents: [] });
    mockReadAWSDeploymentTargets.mockResolvedValue([]);
    mockConfigExists.mockReturnValue(true);
    mockReadMcpSpec.mockResolvedValue({ mcpServers: {} });
    mockReadMcpDefs.mockResolvedValue({ tools: [] });
    mockReadDeployedState.mockResolvedValue({ targets: {} });

    const result = await handleValidate({});

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(5);
    expect(result.results.every(r => r.success)).toBe(true);
    expect(mockReadProjectSpec).toHaveBeenCalled();
    expect(mockReadAWSDeploymentTargets).toHaveBeenCalled();
    expect(mockReadMcpSpec).toHaveBeenCalled();
    expect(mockReadMcpDefs).toHaveBeenCalled();
    expect(mockReadDeployedState).toHaveBeenCalled();
  });
});
