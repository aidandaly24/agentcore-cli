import type { InterceptionPoint, InterceptorRuntime, InterceptorTemplate } from '../../../../schema';

// ─────────────────────────────────────────────────────────────────────────────
// Interceptor Flow Types
// ─────────────────────────────────────────────────────────────────────────────

export type InterceptorModeId = 'managed' | 'external';

/**
 * Optional managed-mode settings the user can opt into via the advanced
 * multi-select. Selecting one injects its sub-step(s) after the advanced step
 * (mirrors the agent BYO `AdvancedSettingId` pattern).
 */
export type InterceptorAdvancedSettingId = 'timeout' | 'additionalPolicies' | 'passRequestHeaders';

export type AddInterceptorStep =
  | 'name'
  | 'gateway'
  | 'interception-points'
  | 'mode'
  | 'template'
  | 'runtime'
  | 'advanced'
  | 'timeout'
  | 'additionalPolicies'
  | 'passRequestHeaders'
  | 'lambda-arn'
  | 'confirm';

export interface AddInterceptorConfig {
  name: string;
  gatewayName: string;
  interceptionPoints: InterceptionPoint[];
  passRequestHeaders?: boolean;
  config:
    | {
        managed: {
          codeLocation: string;
          entrypoint?: string;
          timeoutSeconds?: number;
          runtime?: InterceptorRuntime;
          additionalPolicies?: string[];
        };
      }
    | { external: { lambdaArn: string } };
}

export const INTERCEPTOR_STEP_LABELS: Record<AddInterceptorStep, string> = {
  name: 'Name',
  gateway: 'Gateway',
  'interception-points': 'Points',
  mode: 'Mode',
  template: 'Template',
  runtime: 'Runtime',
  advanced: 'Advanced',
  timeout: 'Timeout',
  additionalPolicies: 'Policies',
  passRequestHeaders: 'Headers',
  'lambda-arn': 'Lambda',
  confirm: 'Confirm',
};

// ─────────────────────────────────────────────────────────────────────────────
// UI Option Constants
// ─────────────────────────────────────────────────────────────────────────────

export const INTERCEPTOR_MODE_OPTIONS = [
  {
    id: 'managed',
    title: 'Create new (CLI scaffolds and deploys the Lambda for you)',
    description: 'CLI scaffolds code from a template and deploys the Lambda',
  },
  {
    id: 'external',
    title: 'Existing Lambda ARN (bring your own)',
    description: 'Attach an existing Lambda function by ARN',
  },
] as const;

export const INTERCEPTION_POINT_OPTIONS = [
  { id: 'REQUEST', title: 'REQUEST', description: 'Intercept inbound requests before they reach the gateway target' },
  { id: 'RESPONSE', title: 'RESPONSE', description: 'Intercept outbound responses before they return to the caller' },
] as const;

export const INTERCEPTOR_TEMPLATE_OPTIONS = [
  { id: 'pass-through', title: 'Pass-through', description: 'Minimal handler that forwards requests unchanged' },
  {
    id: 'jwt-scope-authorizer',
    title: 'JWT scope authorizer',
    description: 'Authorize requests based on JWT scope claims',
  },
  { id: 'tools-list-filter', title: 'Tools list filter', description: 'Filter the tools list returned to the caller' },
] as const;

export const INTERCEPTOR_RUNTIME_OPTIONS = [
  { id: 'python3.12', title: 'Python 3.12', description: 'Python Lambda runtime' },
  { id: 'nodejs22.x', title: 'Node.js 22', description: 'Node.js Lambda runtime' },
] as const;

export const INTERCEPTOR_ADVANCED_OPTIONS = [
  { id: 'timeout', title: 'Lambda timeout', description: `Set a custom timeout (default ${30}s)` },
  {
    id: 'additionalPolicies',
    title: 'Additional IAM policies',
    description: 'Attach policy files or managed-policy ARNs to the execution role',
  },
  {
    id: 'passRequestHeaders',
    title: 'Pass request headers',
    description: 'Control whether request headers are forwarded to the interceptor',
  },
] as const;

export const PASS_REQUEST_HEADERS_OPTIONS = [
  { id: 'yes', title: 'Yes', description: 'Forward request headers to the interceptor (default)' },
  { id: 'no', title: 'No', description: 'Do not forward request headers' },
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_INTERCEPTOR_TIMEOUT = 30;
export const DEFAULT_INTERCEPTOR_RUNTIME: InterceptorRuntime = 'python3.12';
export const DEFAULT_INTERCEPTOR_TEMPLATE: InterceptorTemplate = 'pass-through';
export const DEFAULT_PYTHON_ENTRYPOINT = 'handler.lambda_handler';
export const DEFAULT_NODE_ENTRYPOINT = 'index.handler';

/** Entrypoint for the managed code path, keyed by runtime. */
export function entrypointForRuntime(runtime: InterceptorRuntime): string {
  return runtime === 'python3.12' ? DEFAULT_PYTHON_ENTRYPOINT : DEFAULT_NODE_ENTRYPOINT;
}
