import type { InterceptorAdvancedSettingId } from '../types';
import { computeInterceptorSteps } from '../useAddInterceptorWizard';
import type { ComputeInterceptorStepsInput } from '../useAddInterceptorWizard';
import { describe, expect, it } from 'vitest';

function makeInput(overrides: Partial<ComputeInterceptorStepsInput> = {}): ComputeInterceptorStepsInput {
  return {
    mode: 'managed',
    advancedSettings: new Set<InterceptorAdvancedSettingId>(),
    ...overrides,
  };
}

describe('computeInterceptorSteps - base transitions', () => {
  it('managed with no advanced settings has the canonical managed steps', () => {
    const steps = computeInterceptorSteps(makeInput());
    expect(steps).toEqual([
      'name',
      'gateway',
      'interception-points',
      'mode',
      'template',
      'runtime',
      'advanced',
      'confirm',
    ]);
  });

  it('external mode skips template/runtime/advanced and asks for lambda-arn', () => {
    const steps = computeInterceptorSteps(makeInput({ mode: 'external' }));
    expect(steps).toEqual(['name', 'gateway', 'interception-points', 'mode', 'lambda-arn', 'confirm']);
  });

  it('external mode ignores advanced settings entirely', () => {
    const steps = computeInterceptorSteps(
      makeInput({
        mode: 'external',
        advancedSettings: new Set<InterceptorAdvancedSettingId>([
          'timeout',
          'additionalPolicies',
          'passRequestHeaders',
        ]),
      })
    );
    expect(steps).toEqual(['name', 'gateway', 'interception-points', 'mode', 'lambda-arn', 'confirm']);
    expect(steps).not.toContain('timeout');
    expect(steps).not.toContain('additionalPolicies');
    expect(steps).not.toContain('passRequestHeaders');
  });
});

describe('computeInterceptorSteps - advanced sub-step injection', () => {
  it('timeout-only selection injects timeout right after advanced', () => {
    const steps = computeInterceptorSteps(
      makeInput({ advancedSettings: new Set<InterceptorAdvancedSettingId>(['timeout']) })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'timeout', 'confirm']);
  });

  it('additionalPolicies-only selection injects additionalPolicies after advanced', () => {
    const steps = computeInterceptorSteps(
      makeInput({ advancedSettings: new Set<InterceptorAdvancedSettingId>(['additionalPolicies']) })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'additionalPolicies', 'confirm']);
  });

  it('passRequestHeaders-only selection injects passRequestHeaders after advanced', () => {
    const steps = computeInterceptorSteps(
      makeInput({ advancedSettings: new Set<InterceptorAdvancedSettingId>(['passRequestHeaders']) })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'passRequestHeaders', 'confirm']);
  });

  it('all advanced settings inject sub-steps in canonical order', () => {
    const steps = computeInterceptorSteps(
      makeInput({
        advancedSettings: new Set<InterceptorAdvancedSettingId>([
          'timeout',
          'additionalPolicies',
          'passRequestHeaders',
        ]),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'timeout', 'additionalPolicies', 'passRequestHeaders', 'confirm']);
  });

  it('sub-step order is stable regardless of Set insertion order', () => {
    const steps = computeInterceptorSteps(
      makeInput({
        advancedSettings: new Set<InterceptorAdvancedSettingId>(['passRequestHeaders', 'timeout']),
      })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'timeout', 'passRequestHeaders', 'confirm']);
  });

  it('timeout + additionalPolicies injects both, in order', () => {
    const steps = computeInterceptorSteps(
      makeInput({ advancedSettings: new Set<InterceptorAdvancedSettingId>(['timeout', 'additionalPolicies']) })
    );
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'timeout', 'additionalPolicies', 'confirm']);
  });
});

describe('computeInterceptorSteps - skip-all', () => {
  it('empty advanced set leaves managed steps untouched (advanced → confirm)', () => {
    const steps = computeInterceptorSteps(makeInput());
    const advIdx = steps.indexOf('advanced');
    expect(steps.slice(advIdx)).toEqual(['advanced', 'confirm']);
    expect(steps).not.toContain('timeout');
    expect(steps).not.toContain('additionalPolicies');
    expect(steps).not.toContain('passRequestHeaders');
  });

  it('mode is honored over advanced settings when switching to external', () => {
    const managedSteps = computeInterceptorSteps(
      makeInput({ advancedSettings: new Set<InterceptorAdvancedSettingId>(['timeout']) })
    );
    expect(managedSteps).toContain('timeout');
    const externalSteps = computeInterceptorSteps(
      makeInput({ mode: 'external', advancedSettings: new Set<InterceptorAdvancedSettingId>(['timeout']) })
    );
    expect(externalSteps).not.toContain('timeout');
  });
});
