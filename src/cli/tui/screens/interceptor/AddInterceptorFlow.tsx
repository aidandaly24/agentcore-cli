import type { InterceptorTemplate } from '../../../../schema';
import { ErrorPrompt } from '../../components';
import { useExistingGateways } from '../../hooks';
import { useCreateInterceptor, useExistingInterceptorNames } from '../../hooks/useCreateInterceptor';
import { AddSuccessScreen } from '../add/AddSuccessScreen';
import { AddInterceptorScreen } from './AddInterceptorScreen';
import type { AddInterceptorConfig } from './types';
import React, { useCallback, useEffect, useState } from 'react';

type FlowState =
  | { name: 'create-wizard' }
  | { name: 'create-success'; interceptorName: string; codePath?: string }
  | { name: 'error'; message: string };

interface AddInterceptorFlowProps {
  isInteractive?: boolean;
  onExit: () => void;
  onBack: () => void;
  onDev?: () => void;
  onDeploy?: () => void;
}

export function AddInterceptorFlow({ isInteractive = true, onExit, onBack, onDev, onDeploy }: AddInterceptorFlowProps) {
  const { createInterceptor, reset: resetCreate } = useCreateInterceptor();
  const { names: existingNames } = useExistingInterceptorNames();
  const { gateways } = useExistingGateways();
  const [flow, setFlow] = useState<FlowState>({ name: 'create-wizard' });

  useEffect(() => {
    if (!isInteractive && flow.name === 'create-success') {
      onExit();
    }
  }, [isInteractive, flow.name, onExit]);

  const handleCreateComplete = useCallback(
    (config: AddInterceptorConfig, template: InterceptorTemplate) => {
      void createInterceptor({ config, template }).then(result => {
        if (result.ok) {
          setFlow({ name: 'create-success', interceptorName: result.interceptorName, codePath: result.codePath });
          return;
        }
        setFlow({ name: 'error', message: result.error });
      });
    },
    [createInterceptor]
  );

  if (flow.name === 'create-wizard') {
    return (
      <AddInterceptorScreen
        existingInterceptorNames={existingNames}
        existingGateways={gateways}
        onComplete={handleCreateComplete}
        onExit={onBack}
      />
    );
  }

  if (flow.name === 'create-success') {
    const detail = flow.codePath
      ? `Created interceptor "${flow.interceptorName}" (managed)\n  Code: ${flow.codePath}\n\n  Next: Edit the handler, then run \`agentcore deploy\`.`
      : `Added interceptor "${flow.interceptorName}" (external)\n  Note: external Lambdas are trusted to honor the AgentCore interceptor envelope (interceptorOutputVersion 1.0).`;

    return (
      <AddSuccessScreen
        isInteractive={isInteractive}
        message={`Added interceptor: ${flow.interceptorName}`}
        detail={detail}
        onAddAnother={onBack}
        onDev={onDev}
        onDeploy={onDeploy}
        onExit={onExit}
      />
    );
  }

  return (
    <ErrorPrompt
      message="Failed to add interceptor"
      detail={flow.message}
      onBack={() => {
        resetCreate();
        setFlow({ name: 'create-wizard' });
      }}
      onExit={onExit}
    />
  );
}
