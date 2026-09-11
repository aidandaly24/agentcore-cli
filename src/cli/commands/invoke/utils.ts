import {
  AgentEnvironment,
  AgentProtocol,
  AuthType,
  EndpointSource,
  standardize,
} from '../../telemetry/schemas/common-shapes.js';

function isHarnessInvoke(options: {
  harnessName?: string;
  harnessArn?: string;
  harnessCount: number;
  runtimeCount: number;
}): boolean {
  if (options.harnessName || options.harnessArn) return true;
  if (options.harnessCount > 0 && options.runtimeCount === 0) return true;
  return false;
}

/**
 * Classify where the resolved invoke endpoint qualifier came from for telemetry:
 * the explicit --endpoint flag, the AGENTCORE_RUNTIME_ENDPOINT env var, or the
 * implicit DEFAULT endpoint when neither is set.
 */
export function computeEndpointSource(flagEndpoint?: string): 'flag' | 'env' | 'default' {
  if (flagEndpoint) return 'flag';
  if (process.env.AGENTCORE_RUNTIME_ENDPOINT) return 'env';
  return 'default';
}

export function computeInvokeAttrs(options: {
  harnessName?: string;
  harnessArn?: string;
  harnessCount: number;
  runtimeCount: number;
  stream: boolean;
  hasSessionId: boolean;
  bearerToken?: string;
  agentProtocol?: string;
  endpointSource?: 'flag' | 'env' | 'default';
}) {
  const isHarness = isHarnessInvoke(options);
  return {
    agent_environment: standardize(AgentEnvironment, isHarness ? 'harness' : 'runtime'),
    has_stream: options.stream,
    has_session_id: options.hasSessionId,
    auth_type: standardize(AuthType, options.bearerToken ? 'bearer_token' : 'sigv4'),
    agent_protocol: isHarness ? undefined : standardize(AgentProtocol, options.agentProtocol ?? 'http'),
    endpoint_source: standardize(EndpointSource, options.endpointSource ?? 'default'),
  };
}
