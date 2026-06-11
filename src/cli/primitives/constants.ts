/** User-facing note included in CLI remove JSON output. */
export const SOURCE_CODE_NOTE =
  'Your agent app source code has not been modified. Deploy with `agentcore deploy` to apply your removal changes to AWS.';

/**
 * Remove note for resources whose scaffolded code directory IS deleted on
 * removal (managed interceptors). Must not claim the source is untouched.
 */
export const SCAFFOLD_DELETED_NOTE =
  'The interceptor scaffold directory was deleted. Deploy with `agentcore deploy` to apply your removal changes to AWS.';
