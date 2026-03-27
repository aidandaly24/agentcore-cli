import {
  DEFAULT_STRATEGY_NAMESPACES,
  MemoryStrategySchema,
  MemoryStrategyTypeSchema,
  SemanticOverrideSchema,
} from '../memory';
import { describe, expect, it } from 'vitest';

describe('MemoryStrategyTypeSchema', () => {
  describe('valid strategy types', () => {
    it('accepts SEMANTIC', () => {
      expect(MemoryStrategyTypeSchema.safeParse('SEMANTIC').success).toBe(true);
    });

    it('accepts SUMMARIZATION', () => {
      expect(MemoryStrategyTypeSchema.safeParse('SUMMARIZATION').success).toBe(true);
    });

    it('accepts USER_PREFERENCE', () => {
      expect(MemoryStrategyTypeSchema.safeParse('USER_PREFERENCE').success).toBe(true);
    });

    it('accepts EPISODIC', () => {
      expect(MemoryStrategyTypeSchema.safeParse('EPISODIC').success).toBe(true);
    });
  });

  describe('invalid strategy types', () => {
    // Issue #235: CUSTOM strategy has been removed
    it('rejects CUSTOM strategy', () => {
      const result = MemoryStrategyTypeSchema.safeParse('CUSTOM');
      expect(result.success).toBe(false);
    });

    it('rejects arbitrary invalid strategies', () => {
      expect(MemoryStrategyTypeSchema.safeParse('INVALID').success).toBe(false);
      expect(MemoryStrategyTypeSchema.safeParse('').success).toBe(false);
      expect(MemoryStrategyTypeSchema.safeParse('semantic').success).toBe(false); // lowercase
    });
  });

  describe('schema options', () => {
    it('contains four valid strategies including EPISODIC', () => {
      expect(MemoryStrategyTypeSchema.options).toEqual(['SEMANTIC', 'SUMMARIZATION', 'USER_PREFERENCE', 'EPISODIC']);
      expect(MemoryStrategyTypeSchema.options).not.toContain('CUSTOM');
    });
  });
});

describe('MemoryStrategySchema', () => {
  it('validates strategy with required type field', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'SEMANTIC' });
    expect(result.success).toBe(true);
  });

  it('validates strategy with optional fields', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SEMANTIC',
      name: 'myStrategy',
      description: 'A description',
      namespaces: ['/users/{actorId}/facts'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects strategy with CUSTOM type', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'CUSTOM' });
    expect(result.success).toBe(false);
  });

  it('rejects strategy with invalid type', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects strategy without type', () => {
    const result = MemoryStrategySchema.safeParse({ name: 'myStrategy' });
    expect(result.success).toBe(false);
  });

  it('accepts EPISODIC strategy with reflectionNamespaces', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: ['/episodes/{actorId}'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects EPISODIC strategy without reflectionNamespaces', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
    });
    expect(result.success).toBe(false);
  });

  it('rejects EPISODIC strategy with empty reflectionNamespaces', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: [],
    });
    expect(result.success).toBe(false);
  });

  it('allows non-EPISODIC strategies without reflectionNamespaces', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'SEMANTIC' });
    expect(result.success).toBe(true);
  });

  it('rejects EPISODIC when reflectionNamespaces is not a prefix of namespaces', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: ['/reflections/{actorId}'],
    });
    expect(result.success).toBe(false);
  });

  it('accepts EPISODIC when reflectionNamespaces is a prefix of namespaces', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: ['/episodes/{actorId}'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts EPISODIC when reflectionNamespaces equals namespaces', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'EPISODIC',
      namespaces: ['/episodes/{actorId}/{sessionId}'],
      reflectionNamespaces: ['/episodes/{actorId}/{sessionId}'],
    });
    expect(result.success).toBe(true);
  });
});

describe('DEFAULT_STRATEGY_NAMESPACES', () => {
  it('has default namespaces for SEMANTIC', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES.SEMANTIC).toEqual(['/users/{actorId}/facts']);
  });

  it('has default namespaces for USER_PREFERENCE', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES.USER_PREFERENCE).toEqual(['/users/{actorId}/preferences']);
  });

  it('has default namespaces for SUMMARIZATION', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES.SUMMARIZATION).toEqual(['/summaries/{actorId}/{sessionId}']);
  });

  it('has default namespaces for EPISODIC', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES.EPISODIC).toEqual(['/episodes/{actorId}/{sessionId}']);
  });

  it('does not have default namespaces for CUSTOM (removed)', () => {
    expect(DEFAULT_STRATEGY_NAMESPACES).not.toHaveProperty('CUSTOM');
  });
});

describe('SemanticOverrideSchema', () => {
  it('accepts extraction-only override', () => {
    const result = SemanticOverrideSchema.safeParse({
      extraction: { appendToPrompt: 'Extract key facts', modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts consolidation-only override', () => {
    const result = SemanticOverrideSchema.safeParse({
      consolidation: { appendToPrompt: 'Consolidate memories', modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts both extraction and consolidation', () => {
    const result = SemanticOverrideSchema.safeParse({
      extraction: { appendToPrompt: 'Extract', modelId: 'model-1' },
      consolidation: { appendToPrompt: 'Consolidate', modelId: 'model-2' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects empty override (at least one required)', () => {
    const result = SemanticOverrideSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects extraction with empty appendToPrompt', () => {
    const result = SemanticOverrideSchema.safeParse({
      extraction: { appendToPrompt: '', modelId: 'model-1' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects extraction with missing modelId', () => {
    const result = SemanticOverrideSchema.safeParse({
      extraction: { appendToPrompt: 'test' },
    });
    expect(result.success).toBe(false);
  });
});

describe('MemoryStrategySchema with semanticOverride', () => {
  it('accepts SEMANTIC strategy with extraction override', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SEMANTIC',
      semanticOverride: {
        extraction: { appendToPrompt: 'Extract key facts', modelId: 'anthropic.claude-3-sonnet-20240229-v1:0' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts SEMANTIC strategy with both overrides', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SEMANTIC',
      semanticOverride: {
        extraction: { appendToPrompt: 'Extract', modelId: 'model-1' },
        consolidation: { appendToPrompt: 'Consolidate', modelId: 'model-2' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts SEMANTIC strategy without override (backward compat)', () => {
    const result = MemoryStrategySchema.safeParse({ type: 'SEMANTIC' });
    expect(result.success).toBe(true);
  });

  it('rejects semanticOverride on SUMMARIZATION strategy', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SUMMARIZATION',
      semanticOverride: {
        extraction: { appendToPrompt: 'test', modelId: 'model-1' },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some(i => i.message.includes('SEMANTIC'))).toBe(true);
    }
  });

  it('rejects semanticOverride on USER_PREFERENCE strategy', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'USER_PREFERENCE',
      semanticOverride: {
        extraction: { appendToPrompt: 'test', modelId: 'model-1' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects consolidation-only semanticOverride on USER_PREFERENCE strategy', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'USER_PREFERENCE',
      semanticOverride: {
        consolidation: { appendToPrompt: 'test', modelId: 'model-1' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects SEMANTIC strategy with empty semanticOverride', () => {
    const result = MemoryStrategySchema.safeParse({
      type: 'SEMANTIC',
      semanticOverride: {},
    });
    expect(result.success).toBe(false);
  });
});
