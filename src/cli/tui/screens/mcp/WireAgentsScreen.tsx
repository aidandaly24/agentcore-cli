import type { SelectableItem } from '../../components';
import { Panel, Screen, WizardMultiSelect } from '../../components';
import { useMultiSelectNavigation } from '../../hooks';
import { useMemo } from 'react';

interface WireAgentsScreenProps {
  gatewayName: string;
  agents: string[];
  onConfirm: (selectedAgents: string[]) => void;
  onSkip: () => void;
}

export function WireAgentsScreen({ gatewayName, agents, onConfirm, onSkip }: WireAgentsScreenProps) {
  const agentItems: SelectableItem[] = useMemo(() => agents.map(name => ({ id: name, title: name })), [agents]);

  const nav = useMultiSelectNavigation({
    items: agentItems,
    getId: item => item.id,
    onConfirm: ids => {
      if (ids.length === 0) {
        onSkip();
      } else {
        onConfirm(ids);
      }
    },
    onExit: onSkip,
    isActive: true,
    requireSelection: false,
  });

  return (
    <Screen title="Wire Gateway" onExit={onSkip} helpText="Space toggle · Enter wire · Esc skip" exitEnabled={false}>
      <Panel>
        <WizardMultiSelect
          title={`Wire "${gatewayName}" into agents`}
          description="Generates capabilities/gateway.py for selected agents"
          items={agentItems}
          cursorIndex={nav.cursorIndex}
          selectedIds={nav.selectedIds}
        />
      </Panel>
    </Screen>
  );
}
