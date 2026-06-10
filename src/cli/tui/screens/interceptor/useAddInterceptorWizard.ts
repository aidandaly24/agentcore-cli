import { APP_DIR } from '../../../../lib';
import type { InterceptionPoint, InterceptorRuntime, InterceptorTemplate } from '../../../../schema';
import type {
  AddInterceptorConfig,
  AddInterceptorStep,
  InterceptorAdvancedSettingId,
  InterceptorModeId,
} from './types';
import {
  DEFAULT_INTERCEPTOR_RUNTIME,
  DEFAULT_INTERCEPTOR_TEMPLATE,
  DEFAULT_INTERCEPTOR_TIMEOUT,
  entrypointForRuntime,
} from './types';
import { useCallback, useMemo, useState } from 'react';

const BASE_STEPS: AddInterceptorStep[] = ['name', 'gateway', 'interception-points', 'mode'];
const MANAGED_TAIL: AddInterceptorStep[] = ['template', 'runtime', 'advanced', 'confirm'];
const EXTERNAL_TAIL: AddInterceptorStep[] = ['lambda-arn', 'confirm'];

export interface ComputeInterceptorStepsInput {
  mode: InterceptorModeId;
  advancedSettings: Set<InterceptorAdvancedSettingId>;
}

/** Pure function to compute interceptor wizard steps from config. Exported for testing. */
export function computeInterceptorSteps(input: ComputeInterceptorStepsInput): AddInterceptorStep[] {
  if (input.mode === 'external') {
    return [...BASE_STEPS, ...EXTERNAL_TAIL];
  }
  let steps = [...BASE_STEPS, ...MANAGED_TAIL];
  if (input.advancedSettings.size > 0) {
    const advancedIndex = steps.indexOf('advanced');
    const afterAdvanced = advancedIndex + 1;
    const subSteps: AddInterceptorStep[] = [];
    if (input.advancedSettings.has('timeout')) {
      subSteps.push('timeout');
    }
    if (input.advancedSettings.has('additionalPolicies')) {
      subSteps.push('additionalPolicies');
    }
    if (input.advancedSettings.has('passRequestHeaders')) {
      subSteps.push('passRequestHeaders');
    }
    steps = [...steps.slice(0, afterAdvanced), ...subSteps, ...steps.slice(afterAdvanced)];
  }
  return steps;
}

interface InterceptorWizardState {
  name: string;
  gatewayName: string;
  interceptionPoints: InterceptionPoint[];
  template: InterceptorTemplate;
  runtime: InterceptorRuntime;
  timeoutSeconds: number;
  additionalPolicies: string[];
  passRequestHeaders: boolean;
  lambdaArn: string;
}

function getDefaultState(): InterceptorWizardState {
  return {
    name: '',
    gatewayName: '',
    interceptionPoints: [],
    template: DEFAULT_INTERCEPTOR_TEMPLATE,
    runtime: DEFAULT_INTERCEPTOR_RUNTIME,
    timeoutSeconds: DEFAULT_INTERCEPTOR_TIMEOUT,
    additionalPolicies: [],
    passRequestHeaders: true,
    lambdaArn: '',
  };
}

export function useAddInterceptorWizard(existingGateways: string[] = []) {
  const [state, setState] = useState<InterceptorWizardState>(getDefaultState);
  const [mode, setModeState] = useState<InterceptorModeId>('managed');
  const [advancedSettings, setAdvancedSettings] = useState<Set<InterceptorAdvancedSettingId>>(new Set());
  const [step, setStep] = useState<AddInterceptorStep>('name');

  const steps = useMemo(() => computeInterceptorSteps({ mode, advancedSettings }), [mode, advancedSettings]);
  const currentIndex = steps.indexOf(step);

  const goToNextStep = useCallback(
    (afterStep: AddInterceptorStep) => {
      const idx = steps.indexOf(afterStep);
      const next = idx >= 0 ? steps[idx + 1] : undefined;
      if (next) setStep(next);
    },
    [steps]
  );

  const goBack = useCallback(() => {
    const prevStep = steps[currentIndex - 1];
    if (prevStep) setStep(prevStep);
  }, [currentIndex, steps]);

  const config: AddInterceptorConfig = useMemo(() => {
    const base = {
      name: state.name,
      gatewayName: state.gatewayName,
      interceptionPoints: state.interceptionPoints,
      passRequestHeaders: state.passRequestHeaders,
    };
    if (mode === 'external') {
      return { ...base, config: { external: { lambdaArn: state.lambdaArn } } };
    }
    return {
      ...base,
      config: {
        managed: {
          codeLocation: `${APP_DIR}/${state.name}/`,
          entrypoint: entrypointForRuntime(state.runtime),
          timeoutSeconds: state.timeoutSeconds,
          runtime: state.runtime,
          ...(state.additionalPolicies.length > 0 && { additionalPolicies: state.additionalPolicies }),
        },
      },
    };
  }, [mode, state]);

  const setName = useCallback(
    (name: string) => {
      setState(s => ({ ...s, name }));
      goToNextStep('name');
    },
    [goToNextStep]
  );

  const setGateway = useCallback(
    (gatewayName: string) => {
      setState(s => ({ ...s, gatewayName }));
      goToNextStep('gateway');
    },
    [goToNextStep]
  );

  const setInterceptionPoints = useCallback(
    (interceptionPoints: InterceptionPoint[]) => {
      setState(s => ({ ...s, interceptionPoints }));
      goToNextStep('interception-points');
    },
    [goToNextStep]
  );

  const setMode = useCallback((nextMode: InterceptorModeId) => {
    setModeState(nextMode);
    // Cannot use goToNextStep() here — mode is changing, which triggers
    // useMemo to recompute steps, but goToNextStep captures the OLD steps via
    // closure. Must explicitly set the first mode-specific step.
    setStep(nextMode === 'external' ? 'lambda-arn' : 'template');
  }, []);

  const setTemplate = useCallback(
    (template: InterceptorTemplate) => {
      setState(s => ({ ...s, template }));
      goToNextStep('template');
    },
    [goToNextStep]
  );

  const setRuntime = useCallback(
    (runtime: InterceptorRuntime) => {
      setState(s => ({ ...s, runtime }));
      goToNextStep('runtime');
    },
    [goToNextStep]
  );

  const setAdvanced = useCallback((selected: Set<InterceptorAdvancedSettingId>) => {
    setAdvancedSettings(selected);
    if (!selected.has('timeout')) {
      setState(s => ({ ...s, timeoutSeconds: DEFAULT_INTERCEPTOR_TIMEOUT }));
    }
    if (!selected.has('additionalPolicies')) {
      setState(s => ({ ...s, additionalPolicies: [] }));
    }
    if (!selected.has('passRequestHeaders')) {
      setState(s => ({ ...s, passRequestHeaders: true }));
    }
    // steps memo hasn't updated yet — navigate to the first selected sub-step
    // (or confirm when none selected) explicitly to dodge the closure gotcha.
    if (selected.has('timeout')) {
      setStep('timeout');
    } else if (selected.has('additionalPolicies')) {
      setStep('additionalPolicies');
    } else if (selected.has('passRequestHeaders')) {
      setStep('passRequestHeaders');
    } else {
      setStep('confirm');
    }
  }, []);

  const setTimeout = useCallback(
    (timeoutSeconds: number) => {
      setState(s => ({ ...s, timeoutSeconds }));
      goToNextStep('timeout');
    },
    [goToNextStep]
  );

  const setAdditionalPolicies = useCallback(
    (additionalPolicies: string[]) => {
      setState(s => ({ ...s, additionalPolicies }));
      goToNextStep('additionalPolicies');
    },
    [goToNextStep]
  );

  const setPassRequestHeaders = useCallback(
    (passRequestHeaders: boolean) => {
      setState(s => ({ ...s, passRequestHeaders }));
      goToNextStep('passRequestHeaders');
    },
    [goToNextStep]
  );

  const setLambdaArn = useCallback(
    (lambdaArn: string) => {
      setState(s => ({ ...s, lambdaArn }));
      goToNextStep('lambda-arn');
    },
    [goToNextStep]
  );

  const reset = useCallback(() => {
    setState(getDefaultState());
    setModeState('managed');
    setAdvancedSettings(new Set());
    setStep('name');
  }, []);

  return {
    config,
    step,
    steps,
    currentIndex,
    mode,
    advancedSettings,
    state,
    existingGateways,
    goBack,
    setName,
    setGateway,
    setInterceptionPoints,
    setMode,
    setTemplate,
    setRuntime,
    setAdvanced,
    setTimeout,
    setAdditionalPolicies,
    setPassRequestHeaders,
    setLambdaArn,
    reset,
  };
}
