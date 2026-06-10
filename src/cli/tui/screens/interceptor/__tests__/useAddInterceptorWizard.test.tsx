import type { InterceptionPoint, InterceptorRuntime, InterceptorTemplate } from '../../../../../schema';
import type { InterceptorAdvancedSettingId, InterceptorModeId } from '../types';
import { useAddInterceptorWizard } from '../useAddInterceptorWizard';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React, { act, useImperativeHandle } from 'react';
import { describe, expect, it } from 'vitest';

interface HarnessHandle {
  setName: (name: string) => void;
  setGateway: (gateway: string) => void;
  setInterceptionPoints: (points: InterceptionPoint[]) => void;
  setMode: (mode: InterceptorModeId) => void;
  setTemplate: (template: InterceptorTemplate) => void;
  setRuntime: (runtime: InterceptorRuntime) => void;
  setAdvanced: (settings: Set<InterceptorAdvancedSettingId>) => void;
  setTimeout: (seconds: number) => void;
  setAdditionalPolicies: (policies: string[]) => void;
  setPassRequestHeaders: (value: boolean) => void;
  setLambdaArn: (arn: string) => void;
  goBack: () => void;
}

const ImperativeHarness = React.forwardRef<HarnessHandle>((_props, ref) => {
  const wizard = useAddInterceptorWizard(['gw-a', 'gw-b']);
  useImperativeHandle(ref, () => ({
    setName: wizard.setName,
    setGateway: wizard.setGateway,
    setInterceptionPoints: wizard.setInterceptionPoints,
    setMode: wizard.setMode,
    setTemplate: wizard.setTemplate,
    setRuntime: wizard.setRuntime,
    setAdvanced: wizard.setAdvanced,
    setTimeout: wizard.setTimeout,
    setAdditionalPolicies: wizard.setAdditionalPolicies,
    setPassRequestHeaders: wizard.setPassRequestHeaders,
    setLambdaArn: wizard.setLambdaArn,
    goBack: wizard.goBack,
  }));
  return (
    <Text>
      step:{wizard.step}
      steps:{wizard.steps.join(',')}
      mode:{wizard.mode}
      config:{JSON.stringify(wizard.config)}
    </Text>
  );
});
ImperativeHarness.displayName = 'ImperativeHarness';

function frameOf(lastFrame: () => string | undefined): string {
  return lastFrame()!.replace(/\n/g, '');
}

describe('useAddInterceptorWizard', () => {
  describe('defaults', () => {
    it('starts on the name step in managed mode', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);
      expect(lastFrame()).toContain('step:name');
      expect(lastFrame()).toContain('mode:managed');
    });
  });

  describe('managed happy path', () => {
    it('advances name → gateway → interception-points → mode', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setName('myInt'));
      expect(lastFrame()).toContain('step:gateway');

      act(() => ref.current!.setGateway('gw-a'));
      expect(lastFrame()).toContain('step:interception-points');

      act(() => ref.current!.setInterceptionPoints(['REQUEST']));
      expect(lastFrame()).toContain('step:mode');
    });

    it('managed mode jumps to template (closure gotcha)', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setMode('managed'));
      expect(lastFrame()).toContain('step:template');
    });

    it('builds a managed config with codeLocation and python entrypoint by default', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setName('myInt'));
      act(() => ref.current!.setGateway('gw-a'));
      act(() => ref.current!.setInterceptionPoints(['REQUEST', 'RESPONSE']));
      act(() => ref.current!.setMode('managed'));
      act(() => ref.current!.setTemplate('tools-list-filter'));
      act(() => ref.current!.setRuntime('python3.12'));

      const frame = frameOf(lastFrame);
      expect(frame).toContain('"managed"');
      expect(frame).toContain('"codeLocation":"app/myInt/"');
      expect(frame).toContain('"entrypoint":"handler.lambda_handler"');
      expect(frame).toContain('"runtime":"python3.12"');
      expect(frame).toContain('"timeoutSeconds":30');
      expect(frame).toContain('"passRequestHeaders":true');
      expect(frame).toContain('"interceptionPoints":["REQUEST","RESPONSE"]');
    });

    it('nodejs runtime maps to the node entrypoint', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setName('myInt'));
      act(() => ref.current!.setMode('managed'));
      act(() => ref.current!.setRuntime('nodejs22.x'));

      const frame = frameOf(lastFrame);
      expect(frame).toContain('"entrypoint":"index.handler"');
      expect(frame).toContain('"runtime":"nodejs22.x"');
    });
  });

  describe('advanced sub-steps', () => {
    it('selecting advanced settings injects sub-steps and navigates to the first', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setMode('managed'));
      act(() => ref.current!.setTemplate('pass-through'));
      act(() => ref.current!.setRuntime('python3.12'));
      act(() => ref.current!.setAdvanced(new Set<InterceptorAdvancedSettingId>(['timeout', 'passRequestHeaders'])));

      expect(lastFrame()).toContain('step:timeout');
      const frame = frameOf(lastFrame);
      expect(frame).toContain(
        'steps:name,gateway,interception-points,mode,template,runtime,advanced,timeout,passRequestHeaders,confirm'
      );
    });

    it('empty advanced selection navigates straight to confirm', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setMode('managed'));
      act(() => ref.current!.setTemplate('pass-through'));
      act(() => ref.current!.setRuntime('python3.12'));
      act(() => ref.current!.setAdvanced(new Set<InterceptorAdvancedSettingId>()));

      expect(lastFrame()).toContain('step:confirm');
    });

    it('custom timeout and additionalPolicies flow into config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setName('myInt'));
      act(() => ref.current!.setMode('managed'));
      act(() => ref.current!.setTemplate('pass-through'));
      act(() => ref.current!.setRuntime('python3.12'));
      act(() => ref.current!.setAdvanced(new Set<InterceptorAdvancedSettingId>(['timeout', 'additionalPolicies'])));
      act(() => ref.current!.setTimeout(120));
      act(() => ref.current!.setAdditionalPolicies(['execution-role-policy.json', 'arn:aws:iam::aws:policy/ReadOnly']));

      const frame = frameOf(lastFrame);
      expect(frame).toContain('"timeoutSeconds":120');
      expect(frame).toContain('"additionalPolicies":["execution-role-policy.json","arn:aws:iam::aws:policy/ReadOnly"]');
    });

    it('passRequestHeaders no flows into config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setMode('managed'));
      act(() => ref.current!.setTemplate('pass-through'));
      act(() => ref.current!.setRuntime('python3.12'));
      act(() => ref.current!.setAdvanced(new Set<InterceptorAdvancedSettingId>(['passRequestHeaders'])));
      act(() => ref.current!.setPassRequestHeaders(false));

      expect(frameOf(lastFrame)).toContain('"passRequestHeaders":false');
    });

    it('deselecting an advanced setting resets it to default', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setMode('managed'));
      act(() => ref.current!.setTemplate('pass-through'));
      act(() => ref.current!.setRuntime('python3.12'));
      act(() => ref.current!.setAdvanced(new Set<InterceptorAdvancedSettingId>(['timeout'])));
      act(() => ref.current!.setTimeout(200));
      // Re-open advanced and clear the selection
      act(() => ref.current!.setAdvanced(new Set<InterceptorAdvancedSettingId>()));

      expect(frameOf(lastFrame)).toContain('"timeoutSeconds":30');
    });
  });

  describe('external mode', () => {
    it('external mode jumps to lambda-arn and builds external config', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setName('myInt'));
      act(() => ref.current!.setGateway('gw-a'));
      act(() => ref.current!.setInterceptionPoints(['REQUEST']));
      act(() => ref.current!.setMode('external'));
      expect(lastFrame()).toContain('step:lambda-arn');

      act(() => ref.current!.setLambdaArn('arn:aws:lambda:us-east-1:123456789012:function:myFn'));
      const frame = frameOf(lastFrame);
      expect(frame).toContain('step:confirm');
      expect(frame).toContain('"external"');
      expect(frame).toContain('"lambdaArn":"arn:aws:lambda:us-east-1:123456789012:function:myFn"');
      expect(frame).not.toContain('"managed"');
    });
  });

  describe('goBack', () => {
    it('goBack from interception-points returns to gateway', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setName('myInt'));
      act(() => ref.current!.setGateway('gw-a'));
      expect(lastFrame()).toContain('step:interception-points');

      act(() => ref.current!.goBack());
      expect(lastFrame()).toContain('step:gateway');
    });

    it('goBack from template returns to mode', () => {
      const ref = React.createRef<HarnessHandle>();
      const { lastFrame } = render(<ImperativeHarness ref={ref} />);

      act(() => ref.current!.setMode('managed'));
      expect(lastFrame()).toContain('step:template');

      act(() => ref.current!.goBack());
      expect(lastFrame()).toContain('step:mode');
    });
  });
});
