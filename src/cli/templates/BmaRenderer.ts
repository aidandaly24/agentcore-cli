import { BaseRenderer } from './BaseRenderer';
import { TEMPLATE_ROOT } from './templateRoot';
import type { AgentRenderConfig } from './types';

/**
 * Bedrock Managed Agents (BMA) customer environment. The base template is the Mantle team's
 * control plane with fixes, its Dockerfile, and an OpenTelemetry dependency.
 */
export class BmaRenderer extends BaseRenderer {
  constructor(config: AgentRenderConfig) {
    super(config, 'bma', TEMPLATE_ROOT, 'http');
  }
}
