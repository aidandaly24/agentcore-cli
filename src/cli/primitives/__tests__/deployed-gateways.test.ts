import type { TargetDeployedState } from '../../../schema';
import { mergeDeployedGateways } from '../deployed-gateways';
import { describe, expect, it } from 'vitest';

const mcpGw = { gatewayId: 'mcp-id', gatewayArn: 'arn:mcp' };
const httpGw = { gatewayId: 'http-id', gatewayArn: 'arn:http' };

describe('mergeDeployedGateways', () => {
  it('returns MCP gateways stored under resources.mcp.gateways', () => {
    const target: TargetDeployedState = { resources: { mcp: { gateways: { 'mcp-gw': mcpGw } } } };
    expect(mergeDeployedGateways(target)).toEqual({ 'mcp-gw': mcpGw });
  });

  it('returns HTTP gateways stored under resources.gateways', () => {
    const target: TargetDeployedState = { resources: { gateways: { 'http-gw': httpGw } } };
    expect(mergeDeployedGateways(target)).toEqual({ 'http-gw': httpGw });
  });

  it('merges both locations when MCP and HTTP gateways coexist', () => {
    const target: TargetDeployedState = {
      resources: { mcp: { gateways: { 'mcp-gw': mcpGw } }, gateways: { 'http-gw': httpGw } },
    };
    expect(mergeDeployedGateways(target)).toEqual({ 'mcp-gw': mcpGw, 'http-gw': httpGw });
  });

  it('returns an empty record when no gateways are deployed', () => {
    expect(mergeDeployedGateways({ resources: {} })).toEqual({});
    expect(mergeDeployedGateways({})).toEqual({});
  });
});
