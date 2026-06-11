import { LogLink, type NextStep, NextSteps, Screen } from '../../components';
import { Box, Text } from 'ink';
import React from 'react';

const REMOVE_SUCCESS_STEPS: NextStep[] = [{ command: 'remove', label: 'Remove another resource' }];

/** Default note — accurate when removal only edits agentcore.json. */
const DEFAULT_SOURCE_NOTE = 'Your source code has not been modified.';

interface RemoveSuccessScreenProps {
  /** Whether running in interactive TUI mode */
  isInteractive: boolean;
  /** Success message (shown in green) */
  message: string;
  /** Optional detail text */
  detail?: string;
  /**
   * Footer note about source-code impact. Defaults to "not modified"; flows that
   * delete scaffolded code on removal (managed interceptors, gateway cascade)
   * pass an accurate note instead so it doesn't falsely claim nothing changed.
   */
  sourceNote?: string;
  /** Path to the log file showing the schema diff */
  logFilePath?: string | null;
  /** Called when "Remove another resource" is selected */
  onRemoveAnother: () => void;
  /** Called when "return" is selected to go back to main menu, or in non-interactive exit */
  onExit: () => void;
}

export function RemoveSuccessScreen({
  isInteractive,
  message,
  detail,
  sourceNote = DEFAULT_SOURCE_NOTE,
  logFilePath,
  onRemoveAnother,
  onExit,
}: RemoveSuccessScreenProps) {
  const handleSelect = (step: NextStep) => {
    if (step.command === 'remove') {
      onRemoveAnother();
    }
  };

  // Non-interactive mode - just show success message
  if (!isInteractive) {
    return (
      <Screen title="Success" onExit={onExit}>
        <Box flexDirection="column">
          <Text color="green">✓ {message}</Text>
          {detail && <Text>{detail}</Text>}
          <Text dimColor>{sourceNote}</Text>
          {logFilePath && <LogLink filePath={logFilePath} label="Diff" />}
        </Box>
      </Screen>
    );
  }

  return (
    <Screen title="Success" onExit={onExit}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text color="green">✓ {message}</Text>
          {detail && <Text>{detail}</Text>}
          <Text dimColor>{sourceNote}</Text>
          {logFilePath && <LogLink filePath={logFilePath} label="Diff" />}
        </Box>
        <NextSteps steps={REMOVE_SUCCESS_STEPS} isInteractive={true} onSelect={handleSelect} onBack={onExit} />
      </Box>
    </Screen>
  );
}
