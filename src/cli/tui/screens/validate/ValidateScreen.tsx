import { handleValidate } from '../../../commands/validate/action';
import type { ValidateFileResult } from '../../../commands/validate/action';
import { NextSteps, Screen, StepProgress } from '../../components';
import type { NextStep, Step } from '../../components';
import { STATUS_COLORS } from '../../theme';
import { Box, Text } from 'ink';
import React, { useEffect, useState } from 'react';

interface ValidateScreenProps {
  isInteractive: boolean;
  onExit: () => void;
}

type Phase = 'validating' | 'success' | 'error';

interface ValidationState {
  phase: Phase;
  steps: Step[];
  error: string | null;
}

function getValidateNextSteps(success: boolean): NextStep[] {
  if (success) {
    return [
      { command: 'deploy', label: 'Deploy your agent' },
      { command: 'status', label: 'View deployment status' },
    ];
  }
  return [];
}

/**
 * Maps handleValidate() results to StepProgress UI steps.
 */
function mapResultsToSteps(results: ValidateFileResult[]): Step[] {
  return results.map(r => {
    if (r.skipped) {
      return { label: r.file, status: 'info' as const, info: 'Not present (optional)' };
    }
    if (r.success) {
      return { label: r.file, status: 'success' as const };
    }
    return { label: r.file, status: 'error' as const, error: r.error };
  });
}

export function ValidateScreen({ isInteractive, onExit }: ValidateScreenProps) {
  const [state, setState] = useState<ValidationState>({
    phase: 'validating',
    steps: [],
    error: null,
  });

  useEffect(() => {
    const runValidation = async () => {
      const result = await handleValidate({});

      const steps = mapResultsToSteps(result.results);

      if (result.success) {
        setState({
          phase: 'success',
          steps,
          error: null,
        });
      } else {
        setState({
          phase: 'error',
          steps: steps.length > 0 ? steps : [{ label: 'Project', status: 'error', error: result.error }],
          error: result.error ?? 'Validation failed',
        });
      }
    };

    void runValidation();
  }, []);

  return (
    <Screen title="AgentCore Validate" onExit={onExit}>
      <Box flexDirection="column" marginTop={1}>
        <StepProgress steps={state.steps} />

        {state.phase === 'success' && (
          <Box marginTop={1}>
            <Text color={STATUS_COLORS.success}>All schemas valid</Text>
          </Box>
        )}

        {state.phase === 'error' && (
          <Box marginTop={1}>
            <Text color={STATUS_COLORS.error}>Validation failed</Text>
          </Box>
        )}

        {(state.phase === 'success' || state.phase === 'error') && (
          <NextSteps
            steps={getValidateNextSteps(state.phase === 'success')}
            isInteractive={isInteractive}
            onBack={onExit}
            isActive={true}
          />
        )}
      </Box>
    </Screen>
  );
}
