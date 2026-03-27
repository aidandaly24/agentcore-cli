import { hasIamAuth, wireGatewayToAgent } from '../../../operations/mcp/wire-gateway';
import { ErrorPrompt } from '../../components';
import {
  useAvailableAgents,
  useCreateGateway,
  useExistingGateways,
  useExistingPolicyEngines,
  useUnassignedTargets,
} from '../../hooks/useCreateMcp';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddGatewayScreen } from './AddGatewayScreen';
import { WireAgentsScreen } from './WireAgentsScreen';
import type { AddGatewayConfig } from './types';
import { Box, Text } from 'ink';
import { useCallback, useEffect, useState } from 'react';

interface WireResult {
  agentName: string;
  success: boolean;
  framework?: string;
  error?: string;
}

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'wire-agents'; gatewayName: string }
  | {
      name: 'create-success';
      gatewayName: string;
      wireResults?: WireResult[];
      loading?: boolean;
      loadingMessage?: string;
    }
  | { name: 'error'; message: string };

interface AddGatewayFlowProps {
  /** Whether running in interactive TUI mode */
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  /** Called when user selects dev from success screen to run agent locally */
  onDev?: () => void;
  /** Called when user selects deploy from success screen */
  onDeploy?: () => void;
}

export function AddGatewayFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddGatewayFlowProps) {
  const { createGateway, reset: resetCreate } = useCreateGateway();
  const { gateways: existingGateways, refresh: refreshGateways } = useExistingGateways();
  const { targets: unassignedTargets } = useUnassignedTargets();
  const { engines: existingPolicyEngines } = useExistingPolicyEngines();
  const { agents } = useAvailableAgents();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  // In non-interactive mode, exit after success (but not while loading)
  useEffect(() => {
    if (!isInteractive) {
      if (flow.name === 'create-success' && !flow.loading) {
        onExit();
      }
    }
  }, [isInteractive, flow, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddGatewayConfig) => {
      setFlow({
        name: 'create-success',
        gatewayName: config.name,
        loading: true,
        loadingMessage: 'Creating gateway...',
      });
      void createGateway(config).then(result => {
        if (result.ok) {
          // Offer to wire agents if any exist (regardless of interactive mode)
          if (agents.length > 0) {
            setFlow({ name: 'wire-agents', gatewayName: result.result.name });
          } else {
            setFlow({ name: 'create-success', gatewayName: result.result.name });
          }
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createGateway, agents.length]
  );

  const handleWireConfirm = useCallback((gatewayName: string, selectedAgents: string[]) => {
    setFlow({
      name: 'create-success',
      gatewayName,
      loading: true,
      loadingMessage: 'Wiring gateway into agents...',
    });
    void (async () => {
      const useIam = await hasIamAuth();
      const results: WireResult[] = [];
      for (const agentName of selectedAgents) {
        const result = await wireGatewayToAgent(agentName, useIam);
        results.push({
          agentName,
          success: result.success,
          framework: result.framework,
          error: result.error,
        });
      }
      setFlow({ name: 'create-success', gatewayName, wireResults: results });
    })();
  }, []);

  // Build wire results summary for the success screen
  const wireSummary =
    flow.name === 'create-success' && flow.wireResults && flow.wireResults.length > 0 ? (
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Wired agents:</Text>
        {flow.wireResults.map(r => (
          <Box key={r.agentName}>
            {r.success ? (
              <Text>
                <Text color="green"> ✓ {r.agentName}</Text>
                {r.framework && <Text dimColor> ({r.framework})</Text>}
              </Text>
            ) : (
              <Text color="red">
                {' '}
                ✗ {r.agentName}: {r.error}
              </Text>
            )}
          </Box>
        ))}
      </Box>
    ) : undefined;

  // Create wizard
  if (flow.name === 'create-wizard') {
    return (
      <AddGatewayScreen
        existingGateways={existingGateways}
        unassignedTargets={unassignedTargets}
        existingPolicyEngines={existingPolicyEngines}
        onComplete={handleCreateComplete}
        onExit={onBack}
      />
    );
  }

  // Wire agents step
  if (flow.name === 'wire-agents') {
    return (
      <WireAgentsScreen
        gatewayName={flow.gatewayName}
        agents={agents}
        onConfirm={selectedAgents => handleWireConfirm(flow.gatewayName, selectedAgents)}
        onSkip={() => setFlow({ name: 'create-success', gatewayName: flow.gatewayName })}
      />
    );
  }

  // Create success
  if (flow.name === 'create-success') {
    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added gateway: ${flow.gatewayName}`}
        detail="Gateway defined in `agentcore/agentcore.json`. Next: Use 'add gateway-target' to route targets through this gateway."
        summary={wireSummary}
        loading={flow.loading}
        loadingMessage={flow.loadingMessage}
        showDevOption={true}
        onAddAnother={() => {
          void refreshGateways().then(() => onBack());
        }}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  // Error
  return (
    <ErrorPrompt
      message="Failed to add gateway"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
