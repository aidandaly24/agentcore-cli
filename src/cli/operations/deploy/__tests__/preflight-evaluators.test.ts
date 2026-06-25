import { validateOnlineEvalEvaluators } from '../preflight.js';
import type { AgentCoreProjectSpec } from '../../../../schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mockGetEvaluator = vi.fn();

vi.mock('../../../aws/agentcore-control', () => ({
  getEvaluator: (...args: unknown[]) => mockGetEvaluator(...args),
}));

function spec(partial: Partial<AgentCoreProjectSpec>): AgentCoreProjectSpec {
  return { evaluators: [], onlineEvalConfigs: [], ...partial } as AgentCoreProjectSpec;
}

describe('validateOnlineEvalEvaluators', () => {
  afterEach(() => vi.clearAllMocks());

  it('throws naming the config and missing evaluator when a referenced evaluator is gone', async () => {
    mockGetEvaluator.mockRejectedValue(new Error('not found'));

    await expect(
      validateOnlineEvalEvaluators(
        spec({ onlineEvalConfigs: [{ name: 'cfg', evaluators: ['Builtin.GoalSuccessRate'] }] as any }),
        'us-east-1'
      )
    ).rejects.toThrow(/Builtin\.GoalSuccessRate.*online eval config "cfg".*no longer exists in us-east-1/s);
  });

  it('does not flag evaluators this deploy is about to create (project-managed, no API call)', async () => {
    await expect(
      validateOnlineEvalEvaluators(
        spec({
          evaluators: [{ name: 'MyEval' }] as any,
          onlineEvalConfigs: [{ name: 'cfg', evaluators: ['MyEval'] }] as any,
        }),
        'us-east-1'
      )
    ).resolves.toBeUndefined();
    expect(mockGetEvaluator).not.toHaveBeenCalled();
  });

  it('passes when non-project-managed references resolve', async () => {
    mockGetEvaluator.mockResolvedValue({ evaluatorId: 'Builtin.GoalSuccessRate' });

    await expect(
      validateOnlineEvalEvaluators(
        spec({ onlineEvalConfigs: [{ name: 'cfg', evaluators: ['Builtin.GoalSuccessRate'] }] as any }),
        'us-east-1'
      )
    ).resolves.toBeUndefined();
    expect(mockGetEvaluator).toHaveBeenCalledWith({ region: 'us-east-1', evaluatorId: 'Builtin.GoalSuccessRate' });
  });
});
