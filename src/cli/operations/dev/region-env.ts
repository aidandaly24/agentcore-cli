import { ConfigIO } from '../../../lib/index.js';

/**
 * Resolve the deployed target's region as AWS_REGION / AWS_DEFAULT_REGION env
 * vars for dev mode. Deployed resources (e.g. AgentCore Memory) live in the
 * region recorded in aws-targets.json, but the local agent's AWS SDK falls back
 * to the shell's AWS_REGION otherwise — so a shell region that is unset or
 * differs from the deployed region makes calls like ListEvents hit the wrong
 * region and fail with "Memory not found" (see issue #1457).
 *
 * Uses the same target the dev path already resolves: the first target in
 * deployed state, matched against aws-targets.json by name.
 */
export async function getRegionEnvVars(): Promise<Record<string, string>> {
  const configIO = new ConfigIO();

  try {
    const deployedState = await configIO.readDeployedState();
    const targetName = Object.keys(deployedState?.targets ?? {})[0];
    if (!targetName) return {};

    const awsTargets = await configIO.readAWSDeploymentTargets();
    const region = awsTargets.find(t => t.name === targetName)?.region;
    if (!region) return {};

    return { AWS_REGION: region, AWS_DEFAULT_REGION: region };
  } catch {
    // No deployed state or targets — leave region resolution to the SDK default chain
    return {};
  }
}
