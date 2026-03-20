import {
  ConfigIO,
  ConfigNotFoundError,
  ConfigParseError,
  ConfigReadError,
  ConfigValidationError,
  NoProjectError,
  findConfigRoot,
} from '../../../lib';

export interface ValidateOptions {
  directory?: string;
}

export interface ValidateFileResult {
  file: string;
  success: boolean;
  skipped?: boolean;
  error?: string;
}

export interface ValidateResult {
  success: boolean;
  error?: string;
  results: ValidateFileResult[];
}

/**
 * Schema files validated by the validate command.
 * Required files must exist; optional files are skipped when absent.
 */
const SCHEMA_FILES = [
  { key: 'project', label: 'agentcore.json', required: true },
  { key: 'targets', label: 'aws-targets.json', required: true },
  { key: 'mcp', label: 'mcp.json', required: false },
  { key: 'mcpDefs', label: 'mcp-defs.json', required: false },
  { key: 'state', label: '.cli/state.json', required: false },
] as const;

/**
 * Validates all AgentCore schema files in the project.
 * Returns per-file results so both CLI and TUI can report granular status.
 * All files are validated even if earlier ones fail.
 */
export async function handleValidate(options: ValidateOptions): Promise<ValidateResult> {
  const baseDir = options.directory ?? process.cwd();

  // Check if project exists
  const configRoot = findConfigRoot(baseDir);
  if (!configRoot) {
    return {
      success: false,
      error: new NoProjectError().message,
      results: [],
    };
  }

  const configIO = new ConfigIO({ baseDir: configRoot });
  const results: ValidateFileResult[] = [];

  for (const file of SCHEMA_FILES) {
    // For optional files, skip if not present
    if (!file.required) {
      if (!configIO.configExists(file.key)) {
        results.push({ file: file.label, success: true, skipped: true });
        continue;
      }
    }

    try {
      if (file.key === 'project') {
        await configIO.readProjectSpec();
      } else if (file.key === 'targets') {
        await configIO.readAWSDeploymentTargets();
      } else if (file.key === 'mcp') {
        await configIO.readMcpSpec();
      } else if (file.key === 'mcpDefs') {
        await configIO.readMcpDefs();
      } else if (file.key === 'state') {
        await configIO.readDeployedState();
      }
      results.push({ file: file.label, success: true });
    } catch (err) {
      results.push({ file: file.label, success: false, error: formatError(err, file.label) });
    }
  }

  const errors = results.filter(r => !r.success);
  const hasErrors = errors.length > 0;

  return {
    success: !hasErrors,
    error: hasErrors ? errors.map(r => r.error).join('\n') : undefined,
    results,
  };
}

function formatError(err: unknown, fileName: string): string {
  if (err instanceof ConfigValidationError) {
    return err.message;
  }
  if (err instanceof ConfigParseError) {
    return `Invalid JSON in ${fileName}: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`;
  }
  if (err instanceof ConfigReadError) {
    return `Failed to read ${fileName}: ${err.cause instanceof Error ? err.cause.message : String(err.cause)}`;
  }
  if (err instanceof ConfigNotFoundError) {
    return `Required file not found: ${fileName}`;
  }
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
