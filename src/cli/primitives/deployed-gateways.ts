import type { GatewayDeployedState, TargetDeployedState } from '../../schema';

/**
 * Resolve every deployed gateway on a target, regardless of where it was stored.
 *
 * Deployed state keeps gateways in two locations: MCP gateways under
 * `resources.mcp.gateways` and HTTP gateways (`protocolType: "None"`) under
 * `resources.gateways` (see `buildDeployedState` in cloudformation/outputs.ts).
 * A `??` fallback is wrong here because a project can populate BOTH maps at once,
 * in which case `??` returns only the MCP map and HTTP gateways disappear. Merging
 * is the only correct resolution (mirrors status/action.ts).
 */
export function mergeDeployedGateways(target: TargetDeployedState): Record<string, GatewayDeployedState> {
  return { ...(target.resources?.mcp?.gateways ?? {}), ...(target.resources?.gateways ?? {}) };
}
