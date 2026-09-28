import type { AgentEnvSpec, BuildType, ModelProvider, SDKFramework, TargetLanguage } from '../../schema';
import { BMA_TEMPLATE_PROFILE } from './bmaProfile';

/**
 * What a framework template needs from the CLI. The commands, the wizard, and the schema mapper
 * read this profile, so they need no check for a specific framework.
 */
export interface TemplateProfile {
  /** Options that the template needs. `create` and `add` fill them in and reject other values. */
  requiredOptions?: { memory?: string; build?: BuildType; language?: TargetLanguage };
  /** Options that `create` and `add` fill in when the user does not give them. */
  defaultOptions?: { modelProvider?: ModelProvider };
  /** The main file under the agent directory. The default is `main.py`. */
  entrypoint?: string;
  /** `add agent` accepts only `--type create`. */
  createOnly?: boolean;
  /** False when the runtime runs no model, so the CLI does not ask for a model or show one. */
  usesModel?: boolean;
  /** False when the image installs the Python dependencies, so the CLI sets up no local venv. */
  setupPythonVenv?: boolean;
  /** Runtime settings that the template needs. User-supplied values win. */
  runtime?: TemplateRuntimeProfile;
}

export interface TemplateRuntimeProfile {
  /** The Dockerfile path under codeLocation. */
  dockerfile: string;
  idleRuntimeSessionTimeout: number;
  maxLifetime: number;
  /** Policy files under codeLocation, or managed policy ARNs, for the execution role. */
  additionalPolicies?: string[];
  /** Tags on the runtime. */
  tags?: NonNullable<AgentEnvSpec['tags']>;
}

const TEMPLATE_PROFILES: Partial<Record<SDKFramework, TemplateProfile>> = {
  BedrockManagedAgents: BMA_TEMPLATE_PROFILE,
};

export function getTemplateProfile(framework: string | undefined): TemplateProfile | undefined {
  if (!framework || !Object.hasOwn(TEMPLATE_PROFILES, framework)) return undefined;
  return TEMPLATE_PROFILES[framework as SDKFramework];
}

export function templateUsesModel(framework: string | undefined): boolean {
  return getTemplateProfile(framework)?.usesModel !== false;
}

export function templateNeedsPythonVenv(framework: string | undefined): boolean {
  return getTemplateProfile(framework)?.setupPythonVenv !== false;
}

interface TemplateOptions {
  type?: string;
  modelProvider?: string;
  memory?: string;
  language?: string;
  build?: string;
}

/** Fill in the options that the framework template needs or defaults. User-supplied values win. */
export function applyTemplateOptionDefaults(framework: string | undefined, options: TemplateOptions): void {
  const profile = getTemplateProfile(framework);
  if (!profile) return;
  options.modelProvider ??= profile.defaultOptions?.modelProvider;
  options.language ??= profile.requiredOptions?.language;
  options.memory ??= profile.requiredOptions?.memory;
  options.build ??= profile.requiredOptions?.build;
}

/** Returns an error message if an option conflicts with the framework template. */
export function validateTemplateOptions(framework: string | undefined, options: TemplateOptions): string | undefined {
  const profile = getTemplateProfile(framework);
  if (!profile) return undefined;
  if (profile.createOnly && options.type && options.type !== 'create') {
    return `${framework} supports only --type create`;
  }
  const required = profile.requiredOptions ?? {};
  for (const flag of ['memory', 'build', 'language'] as const) {
    const value = required[flag];
    if (value !== undefined && options[flag] !== undefined && options[flag] !== value) {
      return `${framework} supports only --${flag} ${value}`;
    }
  }
  return undefined;
}
