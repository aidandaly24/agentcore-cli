import { getCredentialProvider } from '../aws';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

export const CDK_TOOLKIT_STACK_NAME = 'CDKToolkit';

/**
 * Minimum CDK bootstrap stack version the synthesized stacks require. Below this, toolkit-lib aborts
 * the deploy deep inside CloudFormation with a cryptic "Bootstrap toolkit stack version N or later is
 * needed" error. Surfacing it here lets us re-bootstrap (which upgrades CDKToolkit) before that point.
 */
export const MIN_BOOTSTRAP_VERSION = 30;

export interface BootstrapStatus {
  isBootstrapped: boolean;
  stackStatus?: string;
  /** Bootstrap stack version (from the CDKToolkit BootstrapVersion output). Undefined if unreadable. */
  bootstrapVersion?: number;
}

/**
 * Check if an AWS environment is bootstrapped by looking for the CDKToolkit stack.
 */
export async function checkBootstrapStatus(region: string): Promise<BootstrapStatus> {
  const cfn = new CloudFormationClient({ region, credentials: getCredentialProvider() });

  try {
    const resp = await cfn.send(new DescribeStacksCommand({ StackName: CDK_TOOLKIT_STACK_NAME }));

    const stack = resp.Stacks?.[0];
    if (!stack) {
      return { isBootstrapped: false };
    }

    const status = stack.StackStatus;
    const isUsable =
      status === 'CREATE_COMPLETE' || status === 'UPDATE_COMPLETE' || status === 'UPDATE_ROLLBACK_COMPLETE';

    // The CDKToolkit stack exposes its bootstrap version as the BootstrapVersion output (a duplicate of
    // the /cdk-bootstrap/<qualifier>/version SSM param, kept on the stack for reliable reads).
    const versionOutput = stack.Outputs?.find(o => o.OutputKey === 'BootstrapVersion')?.OutputValue;
    const bootstrapVersion = versionOutput !== undefined ? Number(versionOutput) : undefined;

    return {
      isBootstrapped: isUsable,
      stackStatus: status,
      bootstrapVersion: Number.isFinite(bootstrapVersion) ? bootstrapVersion : undefined,
    };
  } catch (err: unknown) {
    // Stack doesn't exist - not bootstrapped
    if (err instanceof Error && err.name === 'ValidationError') {
      return { isBootstrapped: false };
    }
    throw err;
  }
}

/**
 * Format environment string for CDK bootstrap.
 */
export function formatCdkEnvironment(accountId: string, region: string): string {
  return `aws://${accountId}/${region}`;
}
