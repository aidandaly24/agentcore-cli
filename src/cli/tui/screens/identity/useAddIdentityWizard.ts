import { isIncludedProvider, vendorRequiresDiscoveryUrl } from '../../../../schema';
import type { CredentialType } from '../../../../schema';
import type { AddIdentityConfig, AddIdentityStep } from './types';
import { useCallback, useMemo, useState } from 'react';

function getSteps(identityType: CredentialType, vendor: string | undefined, skipTypeStep: boolean): AddIdentityStep[] {
  if (identityType !== 'OAuthCredentialProvider') {
    const steps: AddIdentityStep[] = ['type', 'name', 'apiKey', 'confirm'];
    return skipTypeStep ? steps.filter(s => s !== 'type') : steps;
  }

  const steps: AddIdentityStep[] = ['type', 'name', 'vendor'];

  // discoveryUrl only for Custom/unknown vendors
  const resolvedVendor = vendor ?? 'CustomOauth2';
  if (vendorRequiresDiscoveryUrl(resolvedVendor)) {
    steps.push('discoveryUrl');
  }

  // tenantId only for Microsoft Entra ID
  if (resolvedVendor === 'MicrosoftOauth2') {
    steps.push('tenantId');
  }

  // issuer, authorizationEndpoint, tokenEndpoint required for Included providers
  if (isIncludedProvider(resolvedVendor)) {
    steps.push('issuer', 'authorizationEndpoint', 'tokenEndpoint');
  }

  steps.push('clientId', 'clientSecret', 'scopes', 'confirm');

  return skipTypeStep ? steps.filter(s => s !== 'type') : steps;
}

function getDefaultConfig(initialType?: CredentialType): AddIdentityConfig {
  return {
    identityType: initialType ?? 'ApiKeyCredentialProvider',
    name: '',
    apiKey: '',
  };
}

export function useAddIdentityWizard(initialType?: CredentialType) {
  const hasInitialType = initialType !== undefined;
  const [config, setConfig] = useState<AddIdentityConfig>(() => getDefaultConfig(initialType));
  const [step, setStep] = useState<AddIdentityStep>(hasInitialType ? 'name' : 'type');

  const steps = useMemo(
    () => getSteps(config.identityType, config.vendor, hasInitialType),
    [config.identityType, config.vendor, hasInitialType]
  );
  const currentIndex = steps.indexOf(step);

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const advanceFrom = useCallback(
    (currentStep: AddIdentityStep) => {
      const currentSteps = getSteps(config.identityType, config.vendor, hasInitialType);
      const idx = currentSteps.indexOf(currentStep);
      const next = currentSteps[idx + 1];
      if (next) setStep(next);
    },
    [config.identityType, config.vendor, hasInitialType]
  );

  const setIdentityType = useCallback((identityType: CredentialType) => {
    setConfig(c => ({
      ...c,
      identityType,
      apiKey: '',
      vendor: undefined,
      discoveryUrl: undefined,
      tenantId: undefined,
      issuer: undefined,
      authorizationEndpoint: undefined,
      tokenEndpoint: undefined,
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

  const setVendor = useCallback(
    (vendor: string) => {
      setConfig(c => ({
        ...c,
        vendor,
        // Reset vendor-specific fields when vendor changes
        discoveryUrl: undefined,
        tenantId: undefined,
        issuer: undefined,
        authorizationEndpoint: undefined,
        tokenEndpoint: undefined,
      }));
      // Recompute steps with new vendor and advance
      const newSteps = getSteps(config.identityType, vendor, hasInitialType);
      const vendorIdx = newSteps.indexOf('vendor');
      const next = newSteps[vendorIdx + 1];
      if (next) setStep(next);
    },
    [config.identityType, hasInitialType]
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

  const setTenantId = useCallback(
    (tenantId: string) => {
      setConfig(c => ({ ...c, tenantId: tenantId || undefined }));
      advanceFrom('tenantId');
    },
    [advanceFrom]
  );

  const setIssuer = useCallback(
    (issuer: string) => {
      setConfig(c => ({ ...c, issuer }));
      advanceFrom('issuer');
    },
    [advanceFrom]
  );

  const setAuthorizationEndpoint = useCallback(
    (authorizationEndpoint: string) => {
      setConfig(c => ({ ...c, authorizationEndpoint }));
      advanceFrom('authorizationEndpoint');
    },
    [advanceFrom]
  );

  const setTokenEndpoint = useCallback(
    (tokenEndpoint: string) => {
      setConfig(c => ({ ...c, tokenEndpoint }));
      advanceFrom('tokenEndpoint');
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
    setConfig(getDefaultConfig(initialType));
    setStep(hasInitialType ? 'name' : 'type');
  }, [initialType, hasInitialType]);

  return {
    config,
    step,
    steps,
    currentIndex,
    goBack,
    setIdentityType,
    setName,
    setVendor,
    setApiKey,
    setDiscoveryUrl,
    setTenantId,
    setIssuer,
    setAuthorizationEndpoint,
    setTokenEndpoint,
    setClientId,
    setClientSecret,
    setScopes,
    reset,
  };
}
