import { APP_DIR } from '../../lib';
import { copyAndRenderDir } from './render';
import type { AgentRenderConfig } from './types';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import * as path from 'node:path';

export interface RendererContext {
  outputDir: string;
}

type TemplateData = AgentRenderConfig &
  RendererContext & {
    projectName: string;
    Name: string;
    hasMcp: boolean;
  };

export abstract class BaseRenderer {
  protected readonly config: AgentRenderConfig;
  protected readonly sdkName: string;
  protected readonly baseTemplateDir: string;
  protected readonly protocolMode: string;

  protected constructor(config: AgentRenderConfig, sdkName: string, baseTemplateDir: string, protocolMode?: string) {
    this.config = config;
    this.sdkName = sdkName;
    this.baseTemplateDir = baseTemplateDir;
    this.protocolMode = (protocolMode ?? config.protocol ?? 'HTTP').toLowerCase();
  }

  protected shouldRenderMemory(): boolean {
    return this.config.hasMemory;
  }

  /** Map sdkName to the gateway template file suffix. */
  private static readonly SDK_GATEWAY_TEMPLATE_MAP: Record<string, string> = {
    strands: 'strands',
    langchain_langgraph: 'langchain',
    googleadk: 'googleadk',
    openaiagents: 'openaiagents',
  };

  /**
   * Get the path to the framework-specific gateway template asset.
   * Falls back to generic if no framework-specific template exists.
   */
  protected getGatewayTemplatePath(): string | undefined {
    const suffix = BaseRenderer.SDK_GATEWAY_TEMPLATE_MAP[this.sdkName] ?? 'generic';
    const templatePath = path.join(this.baseTemplateDir, 'python', 'capabilities', `gateway.${suffix}.py`);
    return existsSync(templatePath) ? templatePath : undefined;
  }

  protected getTemplateDir(): string {
    const language = this.config.targetLanguage.toLowerCase();
    return path.join(this.baseTemplateDir, language, this.protocolMode, this.sdkName);
  }

  async render(context: RendererContext): Promise<void> {
    const templateDir = this.getTemplateDir();
    const projectName = this.config.name;
    // Agents are placed in app/<agentName>/ directory
    const projectDir = path.join(context.outputDir, APP_DIR, projectName);

    const templateData: TemplateData = {
      ...this.config,
      ...context,
      projectName,
      Name: projectName,
      hasMcp: false, // MCP is configured separately
    };

    const baseDir = path.join(templateDir, 'base');
    await copyAndRenderDir(baseDir, projectDir, templateData);

    // Always generate capabilities/gateway.py — runtime env-var discovery
    // handles the no-gateways case (returns empty tool list).
    const gatewayTemplatePath = this.getGatewayTemplatePath();
    if (gatewayTemplatePath) {
      const capabilitiesDir = path.join(projectDir, 'capabilities');
      await mkdir(capabilitiesDir, { recursive: true });
      await copyFile(gatewayTemplatePath, path.join(capabilitiesDir, 'gateway.py'));
    }

    if (this.shouldRenderMemory()) {
      const memoryCapabilityDir = path.join(templateDir, 'capabilities', 'memory');
      if (existsSync(memoryCapabilityDir)) {
        const memoryTargetDir = path.join(projectDir, 'memory');
        await copyAndRenderDir(memoryCapabilityDir, memoryTargetDir, templateData);
      }
    }

    if (this.config.buildType === 'Container') {
      const language = this.config.targetLanguage.toLowerCase();
      const containerTemplateDir = path.join(this.baseTemplateDir, 'container', language);

      if (existsSync(containerTemplateDir)) {
        await copyAndRenderDir(containerTemplateDir, projectDir, { ...templateData, entrypoint: 'main' });
      }
    }
  }
}
