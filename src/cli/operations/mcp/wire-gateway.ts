import { APP_DIR, ConfigIO, findProjectRoot } from '../../../lib';
import type { SDKFramework } from '../../../schema';
import { getTemplatePath } from '../../templates/templateRoot';
import { addPythonDependencies } from '../python/toml-deps';
import { existsSync, readFileSync } from 'fs';
import { copyFile, mkdir } from 'fs/promises';
import { join } from 'path';

const FRAMEWORK_TEMPLATE_MAP: Record<string, string> = {
  Strands: 'strands',
  LangChain_LangGraph: 'langchain',
  GoogleADK: 'googleadk',
  OpenAIAgents: 'openaiagents',
};

const FRAMEWORK_DETECTION_MAP: Record<string, SDKFramework> = {
  'strands-agents': 'Strands',
  langchain: 'LangChain_LangGraph',
  'google-adk': 'GoogleADK',
  'openai-agents': 'OpenAIAgents',
};

const WIRING_INSTRUCTIONS: Record<string, string> = {
  Strands: `  Add to your main.py:

    from capabilities.gateway import get_gateway_tools

    # In your tools setup:
    tools.extend(get_gateway_tools())`,

  LangChain_LangGraph: `  Add to your main.py:

    from capabilities.gateway import get_gateway_mcp_client

    # In your async handler:
    mcp_client = get_gateway_mcp_client()
    if mcp_client:
        async with mcp_client:
            tools = mcp_client.get_tools()`,

  GoogleADK: `  Add to your main.py:

    from capabilities.gateway import get_gateway_toolsets

    # In your agent setup:
    toolsets = get_gateway_toolsets()`,

  OpenAIAgents: `  Add to your main.py:

    from capabilities.gateway import get_gateway_mcp_servers

    # In your Agent definition:
    agent = Agent(name="my-agent", mcp_servers=get_gateway_mcp_servers(), ...)`,

  generic: `  Add to your main.py:

    from capabilities.gateway import initialize, get_gateway_tools

    # In your async setup:
    await initialize()
    tools = await get_gateway_tools()`,
};

/**
 * Detect the SDK framework of an agent by inspecting its pyproject.toml dependencies.
 * Returns the SDKFramework string or undefined if not detected.
 */
export function detectAgentFramework(agentDir: string): SDKFramework | undefined {
  const tomlPath = join(agentDir, 'pyproject.toml');
  if (!existsSync(tomlPath)) {
    return undefined;
  }

  const content = readFileSync(tomlPath, 'utf-8');
  const contentLower = content.toLowerCase();

  for (const [marker, framework] of Object.entries(FRAMEWORK_DETECTION_MAP)) {
    if (contentLower.includes(marker)) {
      return framework;
    }
  }

  return undefined;
}

function getGatewayTemplatePath(framework: SDKFramework | undefined): string {
  const suffix = framework ? (FRAMEWORK_TEMPLATE_MAP[framework] ?? 'generic') : 'generic';
  return getTemplatePath('python', 'capabilities', `gateway.${suffix}.py`);
}

function getGatewayDependencies(framework: SDKFramework | undefined, hasIamGateway: boolean): string[] {
  const deps: string[] = [];

  // Strands doesn't need raw mcp dep (MCPClient handles it internally)
  if (framework !== 'Strands') {
    deps.push('mcp >= 1.19.0');
  }

  if (hasIamGateway) {
    deps.push('mcp-proxy-for-aws >= 1.1.0');
  }

  return deps;
}

export interface WireGatewayResult {
  success: boolean;
  error?: string;
  framework?: string;
  filesCreated?: string[];
}

/**
 * Wire a gateway capability into an existing agent by generating capabilities/gateway.py
 * and updating pyproject.toml.
 *
 * @param agentName - Name of the agent to wire
 * @param hasIamGateway - Whether any gateway in the project uses AWS_IAM auth
 */
export async function wireGatewayToAgent(agentName: string, hasIamGateway: boolean): Promise<WireGatewayResult> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    return { success: false, error: 'No agentcore project found.' };
  }

  const agentDir = join(projectRoot, APP_DIR, agentName);
  if (!existsSync(agentDir)) {
    return { success: false, error: `Agent directory not found: ${agentDir}` };
  }

  // Check if already wired
  const gatewayPath = join(agentDir, 'capabilities', 'gateway.py');
  if (existsSync(gatewayPath)) {
    return { success: true, error: 'capabilities/gateway.py already exists — no changes needed.' };
  }

  const framework = detectAgentFramework(agentDir);
  const templatePath = getGatewayTemplatePath(framework);

  if (!existsSync(templatePath)) {
    return { success: false, error: `Gateway template not found: ${templatePath}` };
  }

  const capabilitiesDir = join(agentDir, 'capabilities');
  await mkdir(capabilitiesDir, { recursive: true });
  await copyFile(templatePath, gatewayPath);

  const filesCreated = [`${APP_DIR}/${agentName}/capabilities/gateway.py`];

  const deps = getGatewayDependencies(framework, hasIamGateway);
  if (deps.length > 0) {
    const depResult = await addPythonDependencies(agentDir, deps);
    if (!depResult.success) {
      // Non-fatal: gateway.py was created, deps just need manual addition
      console.warn(`Warning: Could not update pyproject.toml: ${depResult.error}`);
      console.warn('Please add these dependencies manually:', deps.join(', '));
    }
  }

  return {
    success: true,
    framework: framework ?? 'generic',
    filesCreated,
  };
}

/**
 * Get the wiring instructions for an agent's framework.
 */
export function getWiringInstructions(framework: string): string {
  return WIRING_INSTRUCTIONS[framework] ?? WIRING_INSTRUCTIONS.generic!;
}

/**
 * Get all agent names from the project spec.
 */
export async function getAgentNames(): Promise<string[]> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.agents.map(a => a.name);
  } catch {
    return [];
  }
}

/**
 * Check if any gateway in the project uses AWS_IAM auth.
 */
export async function hasIamAuth(): Promise<boolean> {
  try {
    const configIO = new ConfigIO();
    const project = await configIO.readProjectSpec();
    return project.agentCoreGateways.some(g => g.authorizerType === 'AWS_IAM');
  } catch {
    return false;
  }
}
