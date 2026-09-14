import { HarnessSpecSchema as PublishedHarnessSpecSchema } from '@aws/agentcore-cdk';

// Match CLI root/model strictness without dropping the published schema's refinements.
export const HarnessSpecSchema: typeof PublishedHarnessSpecSchema = PublishedHarnessSpecSchema.strict().safeExtend({
  model: PublishedHarnessSpecSchema.shape.model.strict(),
});
