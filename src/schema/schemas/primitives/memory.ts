import { z } from 'zod';

// ============================================================================
// Memory Strategy Types
// ============================================================================

/**
 * Memory strategy types.
 * Maps to AWS MemoryStrategy types:
 * - SEMANTIC → SemanticMemoryStrategy
 * - SUMMARIZATION → SummaryMemoryStrategy (note: CloudFormation uses "Summary")
 * - USER_PREFERENCE → UserPreferenceMemoryStrategy
 * - EPISODIC → EpisodicMemoryStrategy
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-memory-memorystrategy.html
 */
export const MemoryStrategyTypeSchema = z.enum(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'EPISODIC']);
export type MemoryStrategyType = z.infer<typeof MemoryStrategyTypeSchema>;

/**
 * Default namespaces for each memory strategy type.
 * These match the patterns generated in CLI session.py templates.
 */
export const DEFAULT_STRATEGY_NAMESPACES: Partial<Record<MemoryStrategyType, string[]>> = {
  SEMANTIC: ['/users/{actorId}/facts'],
  USER_PREFERENCE: ['/users/{actorId}/preferences'],
  SUMMARIZATION: ['/summaries/{actorId}/{sessionId}'],
  EPISODIC: ['/episodes/{actorId}/{sessionId}'],
};

/**
 * Default reflection namespaces for the EPISODIC strategy.
 * The service requires reflection namespaces to be the same as or a prefix of episode namespaces.
 */
export const DEFAULT_EPISODIC_REFLECTION_NAMESPACES: string[] = ['/episodes/{actorId}'];

/**
 * Memory strategy name validation.
 * Pattern: ^[a-zA-Z][a-zA-Z0-9_]{0,47}$
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-bedrockagentcore-memory.html#cfn-bedrockagentcore-memory-name
 */
export const MemoryStrategyNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/,
    'Must begin with a letter and contain only alphanumeric characters and underscores (max 48 chars)'
  );

// ============================================================================
// Semantic Override Types (CloudFormation SemanticOverride)
// ============================================================================

/**
 * Configuration for overriding semantic memory extraction behavior.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-memory-semanticoverrideextractionconfigurationinput.html
 */
export const SemanticExtractionOverrideSchema = z.object({
  /** Custom prompt to append for memory extraction */
  appendToPrompt: z.string().min(1).max(30000),
  /** Bedrock model ID to use for extraction */
  modelId: z.string().min(1),
});

export type SemanticExtractionOverride = z.infer<typeof SemanticExtractionOverrideSchema>;

/**
 * Configuration for overriding semantic memory consolidation behavior.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-memory-semanticoverrideconsolidationconfigurationinput.html
 */
export const SemanticConsolidationOverrideSchema = z.object({
  /** Custom prompt to append for memory consolidation */
  appendToPrompt: z.string().min(1).max(30000),
  /** Bedrock model ID to use for consolidation */
  modelId: z.string().min(1),
});

export type SemanticConsolidationOverride = z.infer<typeof SemanticConsolidationOverrideSchema>;

/**
 * Override configuration for semantic memory strategy.
 * At least one of extraction or consolidation must be provided.
 * @see https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-bedrockagentcore-memory-semanticoverride.html
 */
export const SemanticOverrideSchema = z
  .object({
    /** Override extraction behavior (custom prompt + model) */
    extraction: SemanticExtractionOverrideSchema.optional(),
    /** Override consolidation behavior (custom prompt + model) */
    consolidation: SemanticConsolidationOverrideSchema.optional(),
  })
  .refine(data => data.extraction !== undefined || data.consolidation !== undefined, {
    message: 'At least one of extraction or consolidation must be provided',
  });

export type SemanticOverride = z.infer<typeof SemanticOverrideSchema>;

/**
 * Memory strategy configuration.
 * Each memory can have multiple strategies with optional namespace scoping.
 */
export const MemoryStrategySchema = z
  .object({
    /** Strategy type */
    type: MemoryStrategyTypeSchema,
    /** Optional custom name for the strategy */
    name: MemoryStrategyNameSchema.optional(),
    /** Optional description */
    description: z.string().optional(),
    /** Optional namespaces for scoping memory access */
    namespaces: z.array(z.string()).optional(),
    /** Reflection namespaces for EPISODIC strategy. Required by the service for episodic strategies. */
    reflectionNamespaces: z.array(z.string()).optional(),
    /** Only valid when type is 'SEMANTIC'. Override extraction and/or consolidation behavior. */
    semanticOverride: SemanticOverrideSchema.optional(),
  })
  .refine(
    strategy =>
      strategy.type !== 'EPISODIC' ||
      (strategy.reflectionNamespaces !== undefined && strategy.reflectionNamespaces.length > 0),
    {
      message: 'EPISODIC strategy requires reflectionNamespaces',
      path: ['reflectionNamespaces'],
    }
  )
  .refine(
    strategy => {
      if (strategy.type !== 'EPISODIC' || !strategy.reflectionNamespaces || !strategy.namespaces) return true;
      return strategy.reflectionNamespaces.every(ref => strategy.namespaces!.some(ns => ns.startsWith(ref)));
    },
    {
      message: 'Each reflectionNamespace must be a prefix of at least one namespace',
      path: ['reflectionNamespaces'],
    }
  )
  .refine(strategy => strategy.semanticOverride === undefined || strategy.type === 'SEMANTIC', {
    message: 'semanticOverride is only valid for SEMANTIC strategy type',
    path: ['semanticOverride'],
  });

export type MemoryStrategy = z.infer<typeof MemoryStrategySchema>;
