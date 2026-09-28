import type { TemplateProfile } from './profiles';

/**
 * Mantle runs Codex and calls into the runtime, so the runtime runs no model or memory. The image
 * installs its Python dependencies at build time. The runtime has no session storage, so the same
 * settings work on microVM and on a capacity provider.
 */
export const BMA_TEMPLATE_PROFILE: TemplateProfile = {
  requiredOptions: { memory: 'none', build: 'Container', language: 'Python' },
  defaultOptions: { modelProvider: 'Bedrock' },
  entrypoint: 'lifecycle/server.py',
  createOnly: true,
  usesModel: false,
  setupPythonVenv: false,
  runtime: {
    dockerfile: 'Dockerfile',
    idleRuntimeSessionTimeout: 1800,
    maxLifetime: 28800,
    additionalPolicies: ['bma-acr-policy.json'],
    tags: { 'agentcore:template': 'BedrockManagedAgents' },
  },
};
