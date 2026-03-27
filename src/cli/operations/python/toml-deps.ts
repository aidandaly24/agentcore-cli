import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Extract the package name from a PEP 508 dependency string.
 * e.g., "mcp >= 1.19.0" -> "mcp", "strands-agents>=1.13.0" -> "strands-agents"
 */
function extractPackageName(dep: string): string {
  const match = dep.split(/[><=!~\s[]/)[0];
  return (match ?? dep).trim().toLowerCase();
}

export async function addPythonDependencies(
  agentDir: string,
  deps: string[]
): Promise<{ success: boolean; error?: string }> {
  const tomlPath = join(agentDir, 'pyproject.toml');

  let content: string;
  try {
    content = await readFile(tomlPath, 'utf-8');
  } catch {
    return { success: false, error: `Could not read ${tomlPath}` };
  }

  const depsRegex = /(dependencies\s*=\s*\[)([\s\S]*?)(\])/;
  const match = depsRegex.exec(content);

  if (!match) {
    return { success: false, error: 'Could not find dependencies array in pyproject.toml' };
  }

  const existingBlock = match[2] ?? '';

  const existingNames = new Set(
    existingBlock
      .split('\n')
      .map(line => line.replace(/,?\s*$/, '').trim())
      .filter(line => line.startsWith('"') || line.startsWith("'"))
      .map(line => line.replace(/^["']|["']$/g, ''))
      .map(extractPackageName)
  );

  const newDeps = deps.filter(dep => !existingNames.has(extractPackageName(dep)));

  if (newDeps.length === 0) {
    return { success: true };
  }

  const indentMatch = /^(\s+)"/m.exec(existingBlock);
  const indent = indentMatch?.[1] ?? '    ';

  const newLines = newDeps.map(dep => `${indent}"${dep}",`).join('\n');

  const trimmedBlock = existingBlock.trimEnd();
  const needsComma = trimmedBlock.length > 0 && !trimmedBlock.endsWith(',');
  const separator = needsComma ? ',\n' : '\n';

  const updatedBlock = trimmedBlock + separator + newLines + '\n';
  const updatedContent = content.replace(depsRegex, `$1${updatedBlock}$3`);

  try {
    await writeFile(tomlPath, updatedContent, 'utf-8');
  } catch {
    return { success: false, error: `Could not write ${tomlPath}` };
  }

  return { success: true };
}
