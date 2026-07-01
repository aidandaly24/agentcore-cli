import { useResponsive } from '../hooks/useResponsive';
import { symbols } from '../utils';
import { Box, Text } from 'ink';

interface StepIndicatorProps<T extends string> {
  /** Ordered list of step identifiers */
  steps: T[];
  /** Current active step */
  currentStep: T;
  /** Labels for each step */
  labels: Record<T, string>;
  /** Show arrow separators between steps (default: true) */
  showArrows?: boolean;
}

/**
 * Horizontal step indicator showing progress through a wizard.
 * Shows completed steps with checkmarks, current step highlighted, and pending steps dimmed.
 * Automatically wraps to multiple rows if the terminal is too narrow.
 */
export function StepIndicator<T extends string>({
  steps,
  currentStep,
  labels,
  showArrows = true,
}: StepIndicatorProps<T>) {
  const { width } = useResponsive();
  const currentIndex = steps.indexOf(currentStep);

  // Calculate width of each step: icon (1) + space (1) + label + optional arrow (4)
  const getStepWidth = (step: T, isLast: boolean) => {
    const arrowLen = showArrows && !isLast ? 4 : 0;
    return 2 + labels[step].length + arrowLen;
  };

  // Account for screen padding (roughly 4 chars)
  const availableWidth = width - 4;

  // Split steps into rows based on available width
  const rows: T[][] = [];
  let currentRow: T[] = [];
  let currentRowWidth = 0;

  steps.forEach((step, idx) => {
    const isLastStep = idx === steps.length - 1;
    const stepWidth = getStepWidth(step, isLastStep);
    const gapWidth = currentRow.length > 0 ? 1 : 0;

    if (currentRowWidth + gapWidth + stepWidth > availableWidth && currentRow.length > 0) {
      rows.push(currentRow);
      currentRow = [step];
      currentRowWidth = stepWidth;
    } else {
      currentRow.push(step);
      currentRowWidth += gapWidth + stepWidth;
    }
  });

  if (currentRow.length > 0) {
    rows.push(currentRow);
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      {rows.map((rowSteps, rowIdx) => (
        <Box key={rowIdx} flexDirection="row" gap={1}>
          {rowSteps.map((step, idx) => {
            const stepIdx = steps.indexOf(step);
            const isDone = stepIdx < currentIndex;
            const isCurrent = stepIdx === currentIndex;
            const label = labels[step];
            const isLastInRow = idx === rowSteps.length - 1;
            const isLastStep = stepIdx === steps.length - 1;

            const icon = isDone ? symbols.stepDone : isCurrent ? symbols.stepCurrent : symbols.stepPending;
            const color = isCurrent ? 'cyan' : isDone ? 'green' : 'gray';

            return (
              <Box key={step} flexDirection="row">
                <Text color={color}>{icon}</Text>
                <Text color={color} dimColor={!isCurrent && !isDone}>
                  {' '}
                  {label}
                </Text>
                {showArrows && !isLastStep && !isLastInRow && <Text dimColor> {symbols.branch} </Text>}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
