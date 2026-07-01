import { getCredentialProvider } from '../aws';
import { consoleDomain } from '../aws/partition';
import { isFailureEvent } from './types';
import { CloudFormationClient, DescribeStackEventsCommand, type StackEvent } from '@aws-sdk/client-cloudformation';

// CloudFormation reports a cascade of these on sibling resources once one resource
// in the stack fails. They carry no root-cause information, so they're filtered out.
const CASCADE_REASONS = [
  'Resource creation cancelled',
  'Resource update cancelled',
  'The following resource(s) failed to create',
  'The following resource(s) failed to update',
  'The following resource(s) failed to delete',
];

function isCascadeNoise(reason?: string): boolean {
  if (!reason) return true;
  return CASCADE_REASONS.some(prefix => reason.startsWith(prefix));
}

/**
 * Build a CloudFormation stack-events console deep link for the given stack.
 */
export function stackEventsConsoleUrl(region: string, stackName: string): string {
  const encoded = encodeURIComponent(stackName);
  return `https://${region}.${consoleDomain(region)}/cloudformation/home?region=${region}#/stacks/events?stackId=${encoded}`;
}

/**
 * Reduce a stack's events to the root resource failure(s), skipping the generic
 * cascade noise CloudFormation emits on sibling resources once one fails.
 *
 * Returns a human-readable, multi-line detail string of the form
 * `<LogicalId> (<ResourceType>) failed: <ResourceStatusReason>` plus a console
 * deep link, or null if no actionable failure reason is present.
 */
export function formatStackFailureDetail(events: StackEvent[], region: string, stackName: string): string | null {
  const rootFailures = events.filter(ev => isFailureEvent(ev) && !isCascadeNoise(ev.ResourceStatusReason));

  if (rootFailures.length === 0) {
    return null;
  }

  const lines = rootFailures.map(ev => {
    const logicalId = ev.LogicalResourceId ?? 'UnknownResource';
    const resourceType = ev.ResourceType ?? 'UnknownType';
    return `${logicalId} (${resourceType}) failed: ${ev.ResourceStatusReason}`;
  });

  lines.push(`See stack events: ${stackEventsConsoleUrl(region, stackName)}`);
  return lines.join('\n');
}

/**
 * Fetch the most recent stack events and distill the root failure reason(s).
 * Returns null if the events can't be read or contain no actionable failure.
 */
export async function describeStackFailureDetail(region: string, stackName: string): Promise<string | null> {
  try {
    const cfn = new CloudFormationClient({ region, credentials: getCredentialProvider() });
    const resp = await cfn.send(new DescribeStackEventsCommand({ StackName: stackName }));
    return formatStackFailureDetail(resp.StackEvents ?? [], region, stackName);
  } catch {
    return null;
  }
}
