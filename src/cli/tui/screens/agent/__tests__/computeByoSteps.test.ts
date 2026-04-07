import type { AdvancedSettingId } from '../../generate/types';
import { computeByoSteps } from '../AddAgentScreen';
import type { ComputeByoStepsInput } from '../AddAgentScreen';
import { describe, expect, it } from 'vitest';

function makeInput(overrides: Partial<ComputeByoStepsInput> = {}): ComputeByoStepsInput {
  return {
    modelProvider: 'Bedrock',
    buildType: 'CodeZip',
    networkMode: 'PUBLIC',
    authorizerType: 'AWS_IAM',
    advancedSettings: new Set<AdvancedSettingId>(),
    ...overrides,
  };
}

describe('computeByoSteps', () => {
  describe('base steps', () => {
    it('Bedrock provider excludes apiKey', () => {
      const steps = computeByoSteps(makeInput({ modelProvider: 'Bedrock' }));
      expect(steps).not.toContain('apiKey');
      expect(steps).toEqual(['codeLocation', 'buildType', 'modelProvider', 'advanced', 'confirm']);
    });

    it('non-Bedrock provider includes apiKey', () => {
      const steps = computeByoSteps(makeInput({ modelProvider: 'OpenAI' }));
      expect(steps).toContain('apiKey');
      expect(steps).toEqual(['codeLocation', 'buildType', 'modelProvider', 'apiKey', 'advanced', 'confirm']);
    });
  });

  describe('dockerfile advanced setting', () => {
    it('Container build with dockerfile selected includes dockerfile step', () => {
      const steps = computeByoSteps(
        makeInput({
          buildType: 'Container',
          advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
        })
      );
      expect(steps).toContain('dockerfile');
      const advIdx = steps.indexOf('advanced');
      expect(steps[advIdx + 1]).toBe('dockerfile');
    });

    it('CodeZip build with dockerfile selected does NOT include dockerfile step', () => {
      const steps = computeByoSteps(
        makeInput({
          buildType: 'CodeZip',
          advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
        })
      );
      expect(steps).not.toContain('dockerfile');
    });

    it('dockerfile-only selection on Container has steps: advanced, dockerfile, confirm', () => {
      const steps = computeByoSteps(
        makeInput({
          buildType: 'Container',
          advancedSettings: new Set<AdvancedSettingId>(['dockerfile']),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'dockerfile', 'confirm']);
    });
  });

  describe('network advanced setting', () => {
    it('network selected adds networkMode', () => {
      const steps = computeByoSteps(
        makeInput({
          advancedSettings: new Set<AdvancedSettingId>(['network']),
        })
      );
      expect(steps).toContain('networkMode');
      expect(steps).not.toContain('subnets');
    });

    it('network + VPC adds subnets and securityGroups', () => {
      const steps = computeByoSteps(
        makeInput({
          networkMode: 'VPC',
          advancedSettings: new Set<AdvancedSettingId>(['network']),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'networkMode', 'subnets', 'securityGroups', 'confirm']);
    });
  });

  describe('partial advanced selections', () => {
    it('headers-only adds requestHeaderAllowlist', () => {
      const steps = computeByoSteps(
        makeInput({
          advancedSettings: new Set<AdvancedSettingId>(['headers']),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'requestHeaderAllowlist', 'confirm']);
    });

    it('auth-only adds authorizerType', () => {
      const steps = computeByoSteps(
        makeInput({
          advancedSettings: new Set<AdvancedSettingId>(['auth']),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'authorizerType', 'confirm']);
    });

    it('lifecycle-only adds idleTimeout and maxLifetime', () => {
      const steps = computeByoSteps(
        makeInput({
          advancedSettings: new Set<AdvancedSettingId>(['lifecycle']),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'idleTimeout', 'maxLifetime', 'confirm']);
    });

    it('dockerfile + lifecycle on Container includes both groups', () => {
      const steps = computeByoSteps(
        makeInput({
          buildType: 'Container',
          advancedSettings: new Set<AdvancedSettingId>(['dockerfile', 'lifecycle']),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'dockerfile', 'idleTimeout', 'maxLifetime', 'confirm']);
      expect(steps).not.toContain('networkMode');
    });
  });

  describe('full selection', () => {
    it('all settings on Container + VPC produces complete sub-step list', () => {
      const steps = computeByoSteps(
        makeInput({
          buildType: 'Container',
          networkMode: 'VPC',
          advancedSettings: new Set<AdvancedSettingId>(['dockerfile', 'network', 'headers', 'auth', 'lifecycle']),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual([
        'advanced',
        'dockerfile',
        'networkMode',
        'subnets',
        'securityGroups',
        'requestHeaderAllowlist',
        'authorizerType',
        'idleTimeout',
        'maxLifetime',
        'confirm',
      ]);
    });
  });

  describe('empty selection', () => {
    it('no advanced settings means no sub-steps', () => {
      const steps = computeByoSteps(
        makeInput({
          advancedSettings: new Set<AdvancedSettingId>(),
        })
      );
      const advIdx = steps.indexOf('advanced');
      expect(steps.slice(advIdx)).toEqual(['advanced', 'confirm']);
    });
  });

  describe('CUSTOM_JWT injects jwtConfig', () => {
    it('CUSTOM_JWT with auth selected adds jwtConfig after authorizerType', () => {
      const steps = computeByoSteps(
        makeInput({
          authorizerType: 'CUSTOM_JWT',
          advancedSettings: new Set<AdvancedSettingId>(['auth']),
        })
      );
      const authIdx = steps.indexOf('authorizerType');
      expect(steps[authIdx + 1]).toBe('jwtConfig');
    });

    it('CUSTOM_JWT without auth selected does not add jwtConfig', () => {
      const steps = computeByoSteps(
        makeInput({
          authorizerType: 'CUSTOM_JWT',
          advancedSettings: new Set<AdvancedSettingId>(),
        })
      );
      expect(steps).not.toContain('jwtConfig');
      expect(steps).not.toContain('authorizerType');
    });
  });
});
