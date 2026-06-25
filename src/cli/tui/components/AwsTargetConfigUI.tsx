import { AgentCoreRegionSchema, AwsAccountIdSchema } from '../../../schema';
import type { AgentCoreRegion as _AgentCoreRegion } from '../../../schema';
import { useListNavigation } from '../hooks';
import type { AwsConfigPhase, AwsTargetConfigState } from '../hooks/useAwsTargetConfig';
import { INTERACTIVE_COLORS } from '../theme';
import { symbols } from '../utils';
import { Cursor } from './Cursor';
import { SelectList } from './SelectList';
import { TextInput } from './TextInput';
import { Box, Text, useInput } from 'ink';
import { useState } from 'react';

const AGENT_CORE_REGIONS = AgentCoreRegionSchema.options;

const AWS_CHOICE_ITEMS = [
  { id: 'login', title: 'Exit and run `aws login` in terminal (Recommended)' },
  { id: 'env', title: 'Enter AWS credentials manually' },
];

interface AwsTargetConfigUIProps {
  config: AwsTargetConfigState;
  /** Called when user presses Esc to exit */
  onExit: () => void;
  isActive: boolean;
}

/**
 * Reusable UI component for AWS target configuration.
 * Used by plan and deploy screens when aws-targets.json is empty.
 */
export function AwsTargetConfigUI({ config, onExit, isActive }: AwsTargetConfigUIProps) {
  // Track which row is focused: 0 = "All Targets", 1+ = individual targets
  const [focusedRow, setFocusedRow] = useState(0);
  const totalRows = 1 + config.availableTargets.length; // "All" + individual targets

  // Choice selection (used for both 'choice' and 'token-expired' phases)
  const { selectedIndex: choiceIndex } = useListNavigation({
    items: AWS_CHOICE_ITEMS,
    onSelect: item => {
      if (item.id === 'login') {
        // Exit so user can run aws login in their terminal
        onExit();
      } else {
        // Go to manual entry flow
        config.selectManualEntry();
      }
    },
    onExit,
    isActive: isActive && (config.phase === 'choice' || config.phase === 'token-expired'),
  });

  // Target selection input handling
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setFocusedRow(r => Math.max(0, r - 1));
      } else if (key.downArrow) {
        setFocusedRow(r => Math.min(totalRows - 1, r + 1));
      } else if (key.return) {
        if (focusedRow === 0) {
          // "All Targets" - deploy to all immediately
          config.selectAllTargets();
        } else {
          // Confirm checkbox selection (must have at least one selected)
          config.confirmTargetSelection();
        }
      } else if (input === ' ' && focusedRow > 0) {
        // Space toggles checkbox for individual targets
        config.toggleTarget(focusedRow - 1);
      } else if (key.escape) {
        onExit();
      }
    },
    { isActive: isActive && config.phase === 'select-target' }
  );

  // Region picker state
  const [regionFilter, setRegionFilter] = useState('');
  const [regionIndex, setRegionIndex] = useState(0);

  // Filter regions based on user input
  const filteredRegions = AGENT_CORE_REGIONS.filter(r => r.toLowerCase().includes(regionFilter.toLowerCase()));

  // Handle region picker input
  useInput(
    (input, key) => {
      if (key.upArrow) {
        setRegionIndex(i => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setRegionIndex(i => Math.min(filteredRegions.length - 1, i + 1));
      } else if (key.return) {
        const selectedRegion = filteredRegions.at(regionIndex);
        if (selectedRegion) {
          config.submitRegion(selectedRegion);
        }
      } else if (key.escape) {
        config.goBackToChoice();
      } else if (key.backspace || key.delete) {
        setRegionFilter(f => f.slice(0, -1));
        setRegionIndex(0);
      } else if (input && !key.ctrl && !key.meta && input.length === 1) {
        setRegionFilter(f => f + input);
        setRegionIndex(0);
      }
    },
    { isActive: isActive && config.phase === 'manual-region' }
  );

  if (config.phase === 'checking' || config.phase === 'detecting' || config.phase === 'saving') {
    const messages = {
      checking: 'Checking AWS configuration...',
      detecting: 'Detecting AWS credentials...',
      saving: 'Saving AWS target...',
    };

    return (
      <Box>
        <Text dimColor>{messages[config.phase]}</Text>
      </Box>
    );
  }

  if (config.phase === 'error') {
    return (
      <Box>
        <Text color="red">Error: {config.error}</Text>
      </Box>
    );
  }

  if (config.phase === 'choice' || config.phase === 'token-expired') {
    const isExpired = config.phase === 'token-expired';
    return (
      <Box flexDirection="column">
        {isExpired ? (
          <Text color="yellow">⚠ AWS credentials have expired or are invalid.</Text>
        ) : (
          <Text>No AWS credentials detected. How would you like to proceed?</Text>
        )}
        <Box marginTop={1}>
          <SelectList items={AWS_CHOICE_ITEMS} selectedIndex={choiceIndex} />
        </Box>
      </Box>
    );
  }

  if (config.phase === 'select-target') {
    const selectedCount = config.pendingTargetIndices.length;
    return (
      <Box flexDirection="column">
        <Text bold>Select deployment target(s)</Text>

        {/* All Targets - quick action with distinct styling */}
        <Box marginTop={1} flexDirection="column">
          <Box>
            <Text color={focusedRow === 0 ? INTERACTIVE_COLORS.selection : undefined}>
              {focusedRow === 0 ? `${symbols.cursor} ` : '  '}
            </Text>
            <Text bold color={focusedRow === 0 ? INTERACTIVE_COLORS.selection : 'cyan'}>
              {symbols.pointer} All Targets
            </Text>
            <Text dimColor> — Deploy to all {config.availableTargets.length} targets</Text>
          </Box>

          {/* Separator */}
          <Box marginTop={1} marginBottom={1}>
            <Text dimColor>─── Or select specific targets ───</Text>
          </Box>

          {/* Individual targets with checkboxes */}
          {config.availableTargets.map((target, i) => {
            const isChecked = config.pendingTargetIndices.includes(i);
            const isFocused = focusedRow === i + 1;
            return (
              <Box key={i}>
                <Text color={isFocused ? INTERACTIVE_COLORS.selection : undefined}>
                  {isFocused ? `${symbols.cursor} ` : '  '}
                </Text>
                <Text color={isChecked ? 'green' : 'gray'}>{isChecked ? symbols.checkboxOn : symbols.checkboxOff}</Text>
                <Text color={isFocused ? INTERACTIVE_COLORS.selection : undefined}> {target.name}</Text>
                <Text dimColor>
                  {' '}
                  — {target.region} ({target.account})
                </Text>
              </Box>
            );
          })}

          {/* Selection count */}
          {selectedCount > 0 && (
            <Box marginTop={1}>
              <Text color="green">{selectedCount} target(s) selected — Enter to deploy</Text>
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  if (config.phase === 'manual-account') {
    return (
      <Box flexDirection="column">
        <TextInput
          prompt="AWS Account ID"
          placeholder="123456789012"
          schema={AwsAccountIdSchema}
          onSubmit={config.submitAccountId}
          onCancel={config.goBackToChoice}
        />
      </Box>
    );
  }

  if (config.phase === 'manual-region') {
    return (
      <Box flexDirection="column">
        <Box>
          <Text>Region: </Text>
          <Text color={INTERACTIVE_COLORS.selection}>{regionFilter}</Text>
          <Cursor />
        </Box>
        <Box marginTop={1} flexDirection="column">
          {filteredRegions.length === 0 ? (
            <Text dimColor>No matching regions</Text>
          ) : (
            filteredRegions.map((region, i) => (
              <Text key={region} color={i === regionIndex ? INTERACTIVE_COLORS.selection : undefined}>
                {i === regionIndex ? symbols.cursor : ' '} {region}
              </Text>
            ))
          )}
        </Box>
      </Box>
    );
  }

  // configured phase - nothing to render
  return null;
}

/**
 * Returns the appropriate help text for the current AWS config phase.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function getAwsConfigHelpText(phase: AwsConfigPhase): string | undefined {
  switch (phase) {
    case 'choice':
    case 'token-expired':
      return '↑↓ navigate · Enter select · Esc exit';
    case 'select-target':
      return '↑↓ navigate · Space toggle · Enter deploy · Esc exit';
    case 'manual-account':
      return '12-digit account ID · Esc back';
    case 'manual-region':
      return 'Type to filter · ↑↓ navigate · Enter select · Esc back';
    default:
      return undefined;
  }
}
