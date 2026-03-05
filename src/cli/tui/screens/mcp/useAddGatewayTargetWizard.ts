import { APP_DIR, MCP_APP_SUBDIR } from '../../../../lib';
import type { GatewayTargetType, ToolDefinition } from '../../../../schema';
import type { AddGatewayTargetConfig, AddGatewayTargetStep } from './types';
import { useCallback, useMemo, useState } from 'react';

function deriveToolDefinition(name: string): ToolDefinition {
  return {
    name,
    description: `Tool for ${name}`,
    inputSchema: { type: 'object' },
  };
}

function getDefaultConfig(): AddGatewayTargetConfig {
  return {
    name: '',
    description: '',
    sourcePath: '',
    language: 'Python',
    host: 'Lambda',
    toolDefinition: deriveToolDefinition(''),
  };
}

export function useAddGatewayTargetWizard(existingGateways: string[] = []) {
  const [config, setConfig] = useState<AddGatewayTargetConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddGatewayTargetStep>('name');

  // Dynamic steps — recomputes when targetType changes
  const steps = useMemo<AddGatewayTargetStep[]>(() => {
    const baseSteps: AddGatewayTargetStep[] = ['name', 'target-type'];
    if (config.targetType) {
      switch (config.targetType) {
        case 'mcpServer':
        default:
          baseSteps.push('endpoint', 'gateway', 'outbound-auth');
          break;
      }
      baseSteps.push('confirm');
    }
    return baseSteps;
  }, [config.targetType]);

  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const setName = useCallback((name: string) => {
    setConfig(c => ({
      ...c,
      name,
      description: `Tool for ${name}`,
      sourcePath: `${APP_DIR}/${MCP_APP_SUBDIR}/${name}`,
      toolDefinition: deriveToolDefinition(name),
    }));
    setStep('target-type');
  }, []);

  const setTargetType = useCallback((targetType: GatewayTargetType) => {
    setConfig(c => ({ ...c, targetType }));
    setStep('endpoint');
  }, []);

  const setEndpoint = useCallback((endpoint: string) => {
    setConfig(c => ({
      ...c,
      endpoint,
    }));
    setStep('gateway');
  }, []);

  const setGateway = useCallback((gateway: string) => {
    setConfig(c => ({ ...c, gateway }));
    setStep('outbound-auth');
  }, []);

  const setOutboundAuth = useCallback(
    (outboundAuth: { type: 'OAUTH' | 'API_KEY' | 'NONE'; credentialName?: string }) => {
      setConfig(c => ({
        ...c,
        outboundAuth,
      }));
      setStep('confirm');
    },
    []
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('name');
  }, []);

  return {
    config,
    step,
    steps,
    currentIndex,
    existingGateways,
    goBack,
    setName,
    setTargetType,
    setEndpoint,
    setGateway,
    setOutboundAuth,
    reset,
  };
}
