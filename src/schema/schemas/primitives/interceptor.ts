import { TagsSchema } from './tags';
import { z } from 'zod';

// ============================================================================
// Lambda Interceptor — CLI-side schema
//
// Mirrors @aws/agentcore-cdk's `interceptor.ts` field-for-field. The CLI's
// schema layer is stricter on a few axes (Lambda ARN regex tightened to reject
// version/alias qualifiers) so user input gets a clear error before deploy.
// ============================================================================

export const InterceptionPointSchema = z.enum(['REQUEST', 'RESPONSE']);
export type InterceptionPoint = z.infer<typeof InterceptionPointSchema>;

/**
 * Cap chosen to keep `${projectName}-interceptor-${interceptorName}` under
 * AWS Lambda's 64-char functionName limit. Project name is capped at 23
 * (see ProjectNameSchema), `-interceptor-` is 13 chars, leaving 28 for the
 * interceptor name; 24 is the safe ceiling.
 */
export const InterceptorNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(24)
  .regex(
    /^[a-zA-Z][a-zA-Z0-9-]{0,23}$/,
    'Must begin with a letter and contain only alphanumeric characters and hyphens (max 24 chars)'
  );

export const InterceptorRuntimeSchema = z.enum(['python3.12', 'nodejs22.x']);
export type InterceptorRuntime = z.infer<typeof InterceptorRuntimeSchema>;

export const InterceptorTemplateSchema = z.enum(['pass-through', 'jwt-scope-authorizer', 'tools-list-filter']);
export type InterceptorTemplate = z.infer<typeof InterceptorTemplateSchema>;

/**
 * Defaults are NOT applied here. Zod's `.default(X)` mutates parsed output,
 * which causes the CLI to rewrite user-edited `agentcore.json` with filled-in
 * fields on every command that round-trips the spec (parse → write). We keep
 * the schema sparse and let consumers (CDK constructs, primitive add flows)
 * apply defaults at use time via `?? INTERCEPTOR_DEFAULTS.X`.
 */
export const ManagedInterceptorConfigSchema = z.object({
  codeLocation: z.string().min(1),
  entrypoint: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().min(1).max(300).optional(),
  runtime: InterceptorRuntimeSchema.optional(),
  additionalPolicies: z.array(z.string().min(1)).optional(),
});

/**
 * Effective defaults consumers apply when these fields are absent in the
 * user's `agentcore.json`. Mirrored in `@aws/agentcore-cdk` —
 * keep the two copies in sync.
 */
export const INTERCEPTOR_DEFAULTS = {
  entrypoint: 'handler.lambda_handler',
  timeoutSeconds: 30,
  runtime: 'python3.12' as InterceptorRuntime,
  passRequestHeaders: true,
} as const;

export type ManagedInterceptorConfig = z.infer<typeof ManagedInterceptorConfigSchema>;

/**
 * Lambda ARN regex tightened to reject version/alias qualifiers
 * (e.g., `function:fn:1`, `function:fn:alias`). Qualifiers are out of scope
 * for P0; the gateway-interceptor invocation path may not honor them.
 *
 * `arn:[^:]+:` accepts any partition (commercial, GovCloud, China).
 */
export const LAMBDA_ARN_PATTERN = /^arn:[^:]+:lambda:[a-z0-9-]+:\d{12}:function:[a-zA-Z0-9_-]+$/;

export const ExternalInterceptorConfigSchema = z.object({
  lambdaArn: z
    .string()
    .min(1)
    // CFN service contract caps lambda ARNs at 170 chars
    // (aws-properties-bedrockagentcore-gateway-lambdainterceptorconfiguration).
    .max(170, 'Lambda ARN must be 170 characters or fewer')
    .regex(LAMBDA_ARN_PATTERN, 'Must be a valid unqualified Lambda function ARN (no :VERSION or :ALIAS suffix)'),
});

export type ExternalInterceptorConfig = z.infer<typeof ExternalInterceptorConfigSchema>;

export const InterceptorConfigSchema = z
  .object({
    managed: ManagedInterceptorConfigSchema.optional(),
    external: ExternalInterceptorConfigSchema.optional(),
  })
  .refine(cfg => Boolean(cfg.managed) !== Boolean(cfg.external), {
    message: 'Interceptor config must have either managed or external, not both',
  });

export type InterceptorConfig = z.infer<typeof InterceptorConfigSchema>;

export const InterceptorSchema = z
  .object({
    name: InterceptorNameSchema,
    gatewayName: z.string().min(1),
    interceptionPoints: z.array(InterceptionPointSchema).min(1).max(2),
    passRequestHeaders: z.boolean().optional(),
    config: InterceptorConfigSchema,
    tags: TagsSchema.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<InterceptionPoint>();
    for (const p of data.interceptionPoints) {
      if (seen.has(p)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate interception point "${p}" in interceptor "${data.name}"`,
          path: ['interceptionPoints'],
        });
      }
      seen.add(p);
    }
  });

export type Interceptor = z.infer<typeof InterceptorSchema>;
