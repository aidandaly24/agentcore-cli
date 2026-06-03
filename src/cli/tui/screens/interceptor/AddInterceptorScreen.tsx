import type { InterceptorRuntime, InterceptorTemplate } from '../../../../schema';
import { INTERCEPTOR_LAMBDA_ARN_PATTERN, InterceptorNameSchema } from '../../../../schema';
import { parseCommaSeparatedList } from '../../../commands/shared/vpc-utils';
import type { SelectableItem } from '../../components';
import {
  ConfirmReview,
  Panel,
  Screen,
  StepIndicator,
  TextInput,
  WizardMultiSelect,
  WizardSelect,
} from '../../components';
import { HELP_TEXT } from '../../constants';
import { useListNavigation, useMultiSelectNavigation } from '../../hooks';
import { generateUniqueName } from '../../utils';
import type { AddInterceptorConfig, InterceptorAdvancedSettingId, InterceptorModeId } from './types';
import {
  DEFAULT_INTERCEPTOR_TIMEOUT,
  INTERCEPTION_POINT_OPTIONS,
  INTERCEPTOR_ADVANCED_OPTIONS,
  INTERCEPTOR_MODE_OPTIONS,
  INTERCEPTOR_RUNTIME_OPTIONS,
  INTERCEPTOR_STEP_LABELS,
  INTERCEPTOR_TEMPLATE_OPTIONS,
  PASS_REQUEST_HEADERS_OPTIONS,
} from './types';
import { useAddInterceptorWizard } from './useAddInterceptorWizard';
import { Box, Text } from 'ink';
import React, { useMemo } from 'react';

interface AddInterceptorScreenProps {
  existingInterceptorNames: string[];
  existingGateways: string[];
  onComplete: (config: AddInterceptorConfig, template: InterceptorTemplate) => void;
  onExit: () => void;
}

function NoGatewaysMessage() {
  return (
    <Box flexDirection="column">
      <Text color="yellow">No gateways found</Text>
      <Text dimColor>Add a gateway first, then attach an interceptor to it.</Text>
      <Box marginTop={1}>
        <Text dimColor>Esc back</Text>
      </Box>
    </Box>
  );
}

export function AddInterceptorScreen({
  existingInterceptorNames,
  existingGateways,
  onComplete,
  onExit,
}: AddInterceptorScreenProps) {
  const wizard = useAddInterceptorWizard(existingGateways);

  const isNameStep = wizard.step === 'name';
  const isGatewayStep = wizard.step === 'gateway';
  const isInterceptionPointsStep = wizard.step === 'interception-points';
  const isModeStep = wizard.step === 'mode';
  const isTemplateStep = wizard.step === 'template';
  const isRuntimeStep = wizard.step === 'runtime';
  const isAdvancedStep = wizard.step === 'advanced';
  const isTimeoutStep = wizard.step === 'timeout';
  const isAdditionalPoliciesStep = wizard.step === 'additionalPolicies';
  const isPassRequestHeadersStep = wizard.step === 'passRequestHeaders';
  const isLambdaArnStep = wizard.step === 'lambda-arn';
  const isConfirmStep = wizard.step === 'confirm';
  const noGatewaysAvailable = isGatewayStep && existingGateways.length === 0;

  const gatewayItems: SelectableItem[] = useMemo(
    () => existingGateways.map(g => ({ id: g, title: g })),
    [existingGateways]
  );
  const interceptionPointItems: SelectableItem[] = useMemo(
    () => INTERCEPTION_POINT_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
  const modeItems: SelectableItem[] = useMemo(
    () => INTERCEPTOR_MODE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
  const templateItems: SelectableItem[] = useMemo(
    () => INTERCEPTOR_TEMPLATE_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
  const runtimeItems: SelectableItem[] = useMemo(
    () => INTERCEPTOR_RUNTIME_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
  const advancedItems: SelectableItem[] = useMemo(
    () => INTERCEPTOR_ADVANCED_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );
  const passRequestHeadersItems: SelectableItem[] = useMemo(
    () => PASS_REQUEST_HEADERS_OPTIONS.map(o => ({ id: o.id, title: o.title, description: o.description })),
    []
  );

  const gatewayNav = useListNavigation({
    items: gatewayItems,
    onSelect: item => wizard.setGateway(item.id),
    onExit: () => wizard.goBack(),
    isActive: isGatewayStep && !noGatewaysAvailable,
  });

  const interceptionPointsNav = useMultiSelectNavigation({
    items: interceptionPointItems,
    getId: item => item.id,
    onConfirm: selectedIds => {
      // Persist in canonical REQUEST-before-RESPONSE order regardless of toggle
      // order, so the confirm screen and agentcore.json stay diff-stable.
      const ordered = INTERCEPTION_POINT_OPTIONS.map(o => o.id).filter(id => selectedIds.includes(id));
      wizard.setInterceptionPoints(ordered);
    },
    onExit: () => wizard.goBack(),
    isActive: isInterceptionPointsStep,
    requireSelection: true,
  });

  const modeNav = useListNavigation({
    items: modeItems,
    onSelect: item => wizard.setMode(item.id as InterceptorModeId),
    onExit: () => wizard.goBack(),
    isActive: isModeStep,
  });

  const templateNav = useListNavigation({
    items: templateItems,
    onSelect: item => wizard.setTemplate(item.id as InterceptorTemplate),
    onExit: () => wizard.goBack(),
    isActive: isTemplateStep,
  });

  const runtimeNav = useListNavigation({
    items: runtimeItems,
    onSelect: item => wizard.setRuntime(item.id as InterceptorRuntime),
    onExit: () => wizard.goBack(),
    isActive: isRuntimeStep,
  });

  const advancedNav = useMultiSelectNavigation({
    items: advancedItems,
    getId: item => item.id,
    onConfirm: selectedIds => wizard.setAdvanced(new Set(selectedIds as InterceptorAdvancedSettingId[])),
    onExit: () => wizard.goBack(),
    isActive: isAdvancedStep,
    requireSelection: false,
  });

  const passRequestHeadersNav = useListNavigation({
    items: passRequestHeadersItems,
    onSelect: item => wizard.setPassRequestHeaders(item.id === 'yes'),
    onExit: () => wizard.goBack(),
    isActive: isPassRequestHeadersStep,
  });

  useListNavigation({
    items: [{ id: 'confirm', title: 'Confirm' }],
    onSelect: () => onComplete(wizard.config, wizard.state.template),
    onExit: () => wizard.goBack(),
    isActive: isConfirmStep,
  });

  const isSelectStep = isGatewayStep || isModeStep || isTemplateStep || isRuntimeStep || isPassRequestHeadersStep;
  const isMultiSelectStep = isInterceptionPointsStep || isAdvancedStep;

  const helpText = isConfirmStep
    ? HELP_TEXT.CONFIRM_CANCEL
    : isMultiSelectStep
      ? HELP_TEXT.MULTI_SELECT
      : isSelectStep
        ? HELP_TEXT.NAVIGATE_SELECT
        : HELP_TEXT.TEXT_INPUT;

  const headerContent = (
    <StepIndicator steps={wizard.steps} currentStep={wizard.step} labels={INTERCEPTOR_STEP_LABELS} />
  );

  const confirmFields = useMemo(() => {
    const fields = [
      { label: 'Name', value: wizard.config.name },
      { label: 'Gateway', value: wizard.config.gatewayName },
      { label: 'Points', value: wizard.config.interceptionPoints.join(', ') },
    ];
    if ('managed' in wizard.config.config) {
      const managed = wizard.config.config.managed;
      return [
        ...fields,
        { label: 'Mode', value: 'Managed (CLI scaffolds Lambda)' },
        {
          label: 'Template',
          value: INTERCEPTOR_TEMPLATE_OPTIONS.find(o => o.id === wizard.state.template)?.title ?? wizard.state.template,
        },
        {
          label: 'Runtime',
          value: INTERCEPTOR_RUNTIME_OPTIONS.find(o => o.id === managed.runtime)?.title ?? managed.runtime ?? '',
        },
        { label: 'Code', value: managed.codeLocation },
        { label: 'Timeout', value: `${managed.timeoutSeconds}s` },
        ...(managed.additionalPolicies?.length
          ? [{ label: 'Policies', value: managed.additionalPolicies.join(', ') }]
          : []),
        { label: 'Pass Headers', value: wizard.config.passRequestHeaders ? 'Yes' : 'No' },
      ];
    }
    return [
      ...fields,
      { label: 'Mode', value: 'External (existing Lambda)' },
      { label: 'Lambda ARN', value: wizard.config.config.external.lambdaArn },
      { label: 'Pass Headers', value: wizard.config.passRequestHeaders ? 'Yes' : 'No' },
    ];
  }, [wizard.config, wizard.state.template]);

  return (
    <Screen
      title="Add Interceptor"
      onExit={onExit}
      helpText={helpText}
      headerContent={headerContent}
      exitEnabled={false}
    >
      <Panel>
        {isNameStep && (
          <TextInput
            key="name"
            prompt="Interceptor name"
            initialValue={generateUniqueName('MyInterceptor', existingInterceptorNames)}
            onSubmit={wizard.setName}
            onCancel={onExit}
            schema={InterceptorNameSchema}
            customValidation={value => !existingInterceptorNames.includes(value) || 'Interceptor name already exists'}
          />
        )}

        {isGatewayStep && !noGatewaysAvailable && (
          <WizardSelect
            title="Select gateway"
            description="Which gateway will this interceptor attach to?"
            items={gatewayItems}
            selectedIndex={gatewayNav.selectedIndex}
          />
        )}

        {noGatewaysAvailable && <NoGatewaysMessage />}

        {isInterceptionPointsStep && (
          <WizardMultiSelect
            title="Select interception points"
            description="Where should this interceptor run? Choose 1 or 2 points."
            items={interceptionPointItems}
            cursorIndex={interceptionPointsNav.cursorIndex}
            selectedIds={interceptionPointsNav.selectedIds}
          />
        )}

        {isModeStep && (
          <WizardSelect
            title="How would you like to provide the Lambda?"
            description="Managed: CLI scaffolds and deploys. External: use existing Lambda ARN."
            items={modeItems}
            selectedIndex={modeNav.selectedIndex}
          />
        )}

        {isTemplateStep && (
          <WizardSelect
            title="Select a template"
            description="Starting point for the scaffolded interceptor handler"
            items={templateItems}
            selectedIndex={templateNav.selectedIndex}
          />
        )}

        {isRuntimeStep && (
          <WizardSelect
            title="Select runtime"
            description="Lambda runtime for the interceptor"
            items={runtimeItems}
            selectedIndex={runtimeNav.selectedIndex}
          />
        )}

        {isAdvancedStep && (
          <WizardMultiSelect
            title="Customize advanced settings"
            description="Select settings to configure. Unselected items use defaults."
            items={advancedItems}
            cursorIndex={advancedNav.cursorIndex}
            selectedIds={advancedNav.selectedIds}
          />
        )}

        {isTimeoutStep && (
          <TextInput
            key="timeout"
            prompt="Lambda timeout in seconds (1-300)"
            initialValue={String(DEFAULT_INTERCEPTOR_TIMEOUT)}
            onSubmit={value => wizard.setTimeout(parseInt(value, 10))}
            onCancel={() => wizard.goBack()}
            customValidation={value => {
              const num = parseInt(value, 10);
              if (isNaN(num)) return 'Must be a number';
              return (num >= 1 && num <= 300) || 'Must be between 1 and 300';
            }}
          />
        )}

        {isAdditionalPoliciesStep && (
          <Box flexDirection="column">
            <TextInput
              key="additionalPolicies"
              prompt="Additional IAM policies (comma-separated, or press Enter to skip)"
              initialValue=""
              allowEmpty
              onSubmit={value => wizard.setAdditionalPolicies(parseCommaSeparatedList(value) ?? [])}
              onCancel={() => wizard.goBack()}
            />
            <Box marginTop={1}>
              <Text dimColor>
                Enter relative paths to JSON IAM policy files in the interceptor code directory (e.g.
                execution-role-policy.json) or managed-policy ARNs (e.g.
                arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess).
              </Text>
            </Box>
          </Box>
        )}

        {isPassRequestHeadersStep && (
          <WizardSelect
            title="Pass request headers to the interceptor?"
            description="Forward request headers to the interceptor Lambda"
            items={passRequestHeadersItems}
            selectedIndex={passRequestHeadersNav.selectedIndex}
          />
        )}

        {isLambdaArnStep && (
          <TextInput
            key="lambda-arn"
            prompt="Lambda function ARN"
            initialValue=""
            onSubmit={wizard.setLambdaArn}
            onCancel={() => wizard.goBack()}
            customValidation={value =>
              (value.length <= 170 && INTERCEPTOR_LAMBDA_ARN_PATTERN.test(value)) ||
              'Must be a valid unqualified Lambda function ARN (≤170 chars, no :VERSION or :ALIAS suffix)'
            }
          />
        )}

        {isConfirmStep && <ConfirmReview fields={confirmFields} />}
      </Panel>
    </Screen>
  );
}
