import type { CredentialType } from '../../../../schema';
import type { AddIdentityConfig, AddIdentityStep } from './types';
import { useCallback, useMemo, useState } from 'react';

function getSteps(identityType: CredentialType): AddIdentityStep[] {
  if (identityType === 'OAuthCredentialProvider') {
    return ['type', 'name', 'discoveryUrl', 'clientId', 'clientSecret', 'scopes', 'confirm'];
  }
  return ['type', 'name', 'apiKey', 'confirm'];
}

function getDefaultConfig(): AddIdentityConfig {
  return {
    identityType: 'ApiKeyCredentialProvider',
    name: '',
    apiKey: '',
  };
}

export function useAddIdentityWizard() {
  const [config, setConfig] = useState<AddIdentityConfig>(getDefaultConfig);
  const [step, setStep] = useState<AddIdentityStep>('type');

  const steps = useMemo(() => getSteps(config.identityType), [config.identityType]);
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const advanceFrom = useCallback(
    (currentStep: AddIdentityStep) => {
      const currentSteps = getSteps(config.identityType);
      const idx = currentSteps.indexOf(currentStep);
      const next = currentSteps[idx + 1];
      if (next) setStep(next);
    },
    [config.identityType]
  );

  const setIdentityType = useCallback((identityType: CredentialType) => {
    setConfig(c => ({
      ...c,
      identityType,
      apiKey: '',
      discoveryUrl: undefined,
      clientId: undefined,
      clientSecret: undefined,
      scopes: undefined,
    }));
    setStep('name');
  }, []);

  const setName = useCallback(
    (name: string) => {
      setConfig(c => ({ ...c, name }));
      advanceFrom('name');
    },
    [advanceFrom]
  );

  const setApiKey = useCallback(
    (apiKey: string) => {
      setConfig(c => ({ ...c, apiKey }));
      advanceFrom('apiKey');
    },
    [advanceFrom]
  );

  const setDiscoveryUrl = useCallback(
    (discoveryUrl: string) => {
      setConfig(c => ({ ...c, discoveryUrl }));
      advanceFrom('discoveryUrl');
    },
    [advanceFrom]
  );

  const setClientId = useCallback(
    (clientId: string) => {
      setConfig(c => ({ ...c, clientId }));
      advanceFrom('clientId');
    },
    [advanceFrom]
  );

  const setClientSecret = useCallback(
    (clientSecret: string) => {
      setConfig(c => ({ ...c, clientSecret }));
      advanceFrom('clientSecret');
    },
    [advanceFrom]
  );

  const setScopes = useCallback(
    (scopes: string) => {
      setConfig(c => ({ ...c, scopes: scopes || undefined }));
      advanceFrom('scopes');
    },
    [advanceFrom]
  );

  const reset = useCallback(() => {
    setConfig(getDefaultConfig());
    setStep('type');
  }, []);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setIdentityType,
    setName,
    setApiKey,
    setDiscoveryUrl,
    setClientId,
    setClientSecret,
    setScopes,
    reset,
  };
}