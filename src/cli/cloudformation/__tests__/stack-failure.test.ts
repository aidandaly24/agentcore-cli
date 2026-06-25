import { describeStackFailureDetail, formatStackFailureDetail } from '../stack-failure.js';
import type { StackEvent } from '@aws-sdk/client-cloudformation';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
}));

vi.mock('@aws-sdk/client-cloudformation', () => ({
  CloudFormationClient: class {
    send = mockSend;
  },
  DescribeStackEventsCommand: class {
    constructor(public input: unknown) {}
  },
}));

vi.mock('../../aws', () => ({
  getCredentialProvider: vi.fn().mockReturnValue({}),
}));

const ROOT_FAILURE: StackEvent = {
  StackId: 'stack-id',
  EventId: '1',
  StackName: 'my-stack',
  Timestamp: new Date(),
  LogicalResourceId: 'AgentRuntimeFunction',
  ResourceType: 'AWS::Lambda::Function',
  ResourceStatus: 'CREATE_FAILED',
  ResourceStatusReason: 'Resource handler returned message: "Role arn is invalid"',
};

const CASCADE: StackEvent = {
  StackId: 'stack-id',
  EventId: '2',
  StackName: 'my-stack',
  Timestamp: new Date(),
  LogicalResourceId: 'OtherResource',
  ResourceType: 'AWS::IAM::Role',
  ResourceStatus: 'CREATE_FAILED',
  ResourceStatusReason: 'Resource creation cancelled',
};

describe('formatStackFailureDetail', () => {
  it('names the root logical id, resource type, and reason; skips cascade noise; includes a console link', () => {
    const detail = formatStackFailureDetail([CASCADE, ROOT_FAILURE], 'us-east-1', 'my-stack');

    expect(detail).not.toBeNull();
    expect(detail).toContain('AgentRuntimeFunction (AWS::Lambda::Function) failed: Resource handler returned message');
    // Cascade noise is filtered out
    expect(detail).not.toContain('Resource creation cancelled');
    expect(detail).not.toContain('OtherResource');
    // Console deep link with the partition console domain and stack name
    expect(detail).toContain('console.aws.amazon.com');
    expect(detail).toContain('my-stack');
  });

  it('returns null when no actionable failure reason is present', () => {
    expect(formatStackFailureDetail([CASCADE], 'us-east-1', 'my-stack')).toBeNull();
    expect(formatStackFailureDetail([], 'us-east-1', 'my-stack')).toBeNull();
  });
});

describe('describeStackFailureDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches events via DescribeStackEvents and distills the root failure', async () => {
    mockSend.mockResolvedValue({ StackEvents: [CASCADE, ROOT_FAILURE] });

    const detail = await describeStackFailureDetail('us-east-1', 'my-stack');

    expect(detail).toContain('AgentRuntimeFunction (AWS::Lambda::Function) failed');
    expect(detail).not.toContain('Resource creation cancelled');
  });

  it('returns null when DescribeStackEvents throws', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    expect(await describeStackFailureDetail('us-east-1', 'my-stack')).toBeNull();
  });
});
