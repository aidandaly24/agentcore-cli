import { ResourceNotFoundError, findConfigRoot, serializeResult, toError } from '../../lib';
import type { Result } from '../../lib/result';
import type { InterceptionPoint, Interceptor, InterceptorRuntime, InterceptorTemplate } from '../../schema';
import {
  InterceptionPointSchema,
  InterceptorRuntimeSchema,
  InterceptorSchema,
  InterceptorTemplateSchema,
} from '../../schema';
import { getErrorMessage } from '../errors';
import type { RemovalPreview, SchemaChange } from '../operations/remove/types';
import { runCliCommand } from '../telemetry/cli-command-run.js';
import { renderInterceptorTemplate } from '../templates/InterceptorRenderer';
import { requireTTY } from '../tui/guards/tty';
import { BasePrimitive } from './BasePrimitive';
import type { AddResult, AddScreenComponent, RemovableResource } from './types';
import type { Command } from '@commander-js/extra-typings';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface AddInterceptorOptions {
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

export type RemovableInterceptor = RemovableResource;

const DEFAULT_TIMEOUT_SECONDS = 30;
const DEFAULT_PYTHON_ENTRYPOINT = 'handler.lambda_handler';
const DEFAULT_NODE_ENTRYPOINT = 'index.handler';

/**
 * InterceptorPrimitive owns the add/remove lifecycle for Lambda Interceptors.
 *
 * Mode selection (mirrors EvaluatorPrimitive's codeBased managed/external pattern):
 *   - Presence of `--lambda-arn` forces external mode.
 *   - Absence triggers managed mode with template scaffolding.
 *
 * Cardinality (max 2 per gateway, unique interception points) is enforced both
 * at the schema level (top-level superRefine in agentcore-project.ts) and here
 * for TUI ergonomics so the user gets a clean error before scaffolding code.
 */
export class InterceptorPrimitive extends BasePrimitive<AddInterceptorOptions, RemovableInterceptor> {
  readonly kind = 'interceptor' as const;
  readonly label = 'Interceptor';
  override readonly article = 'an';
  readonly primitiveSchema = InterceptorSchema;

  async add(options: AddInterceptorOptions): Promise<AddResult<{ interceptorName: string; codePath?: string }>> {
    return this.addWithTemplate(options, 'pass-through');
  }

  /**
   * Adds an interceptor with an explicit template. External-mode callers
   * still pass a template name but it is ignored — `template` is meaningful
   * only when `options.config.managed` is set.
   */
  async addWithTemplate(
    options: AddInterceptorOptions,
    template: InterceptorTemplate
  ): Promise<AddResult<{ interceptorName: string; codePath?: string }>> {
    try {
      const interceptor = await this.createInterceptor(options);
      if ('managed' in options.config) {
        const configRoot = findConfigRoot();
        if (!configRoot) {
          throw new Error('No agentcore project found. Run `agentcore create` first.');
        }
        const projectRoot = dirname(configRoot);
        const codeLocation = options.config.managed.codeLocation;
        const runtime = options.config.managed.runtime ?? 'python3.12';
        const targetDir = join(projectRoot, codeLocation);
        try {
          await renderInterceptorTemplate(options.name, runtime, template, targetDir);
        } catch (renderErr) {
          // Roll back the spec write so the project isn't left half-added.
          // The user will see the original render error, not a recovery error.
          try {
            const project = await this.readProjectSpec();
            project.interceptors = (project.interceptors ?? []).filter(i => i.name !== options.name);
            await this.writeProjectSpec(project);
          } catch {
            // Best-effort rollback — surface the original render error regardless.
          }
          throw renderErr;
        }
        return { success: true, interceptorName: interceptor.name, codePath: codeLocation };
      }
      return { success: true, interceptorName: interceptor.name };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async remove(interceptorName: string): Promise<Result> {
    try {
      const project = await this.readProjectSpec();
      project.interceptors ??= [];

      const index = project.interceptors.findIndex(i => i.name === interceptorName);
      if (index === -1) {
        return { success: false, error: new ResourceNotFoundError(`Interceptor "${interceptorName}" not found.`) };
      }

      const interceptor = project.interceptors[index]!;

      // Write spec first so a directory-delete failure leaves no orphan
      // entry in agentcore.json. The recoverable case is "spec is up to
      // date but a stale directory exists" — fully manual cleanup.
      project.interceptors.splice(index, 1);
      await this.writeProjectSpec(project);

      if (interceptor.config.managed) {
        const configRoot = findConfigRoot();
        if (configRoot) {
          const projectRoot = dirname(configRoot);
          const codeDir = join(projectRoot, interceptor.config.managed.codeLocation);
          if (existsSync(codeDir)) {
            await rm(codeDir, { recursive: true, force: true });
          }
        }
      }

      return { success: true };
    } catch (err) {
      return { success: false, error: toError(err) };
    }
  }

  async previewRemove(interceptorName: string): Promise<RemovalPreview> {
    const project = await this.readProjectSpec();
    project.interceptors ??= [];

    const interceptor = project.interceptors.find(i => i.name === interceptorName);
    if (!interceptor) {
      throw new Error(`Interceptor "${interceptorName}" not found.`);
    }

    const summary: string[] = [`Removing interceptor: ${interceptorName}`];
    const directoriesToDelete: string[] = [];
    const schemaChanges: SchemaChange[] = [];

    if (interceptor.config.managed) {
      const configRoot = findConfigRoot()!;
      const projectRoot = dirname(configRoot);
      const codeLocation = interceptor.config.managed.codeLocation;
      const codeDir = join(projectRoot, codeLocation);
      if (existsSync(codeDir)) {
        directoriesToDelete.push(codeLocation);
        summary.push(`Will delete directory: ${codeLocation}`);
      }
    }

    const afterSpec = {
      ...project,
      interceptors: project.interceptors.filter(i => i.name !== interceptorName),
    };

    schemaChanges.push({
      file: 'agentcore/agentcore.json',
      before: project,
      after: afterSpec,
    });

    return { summary, directoriesToDelete, schemaChanges };
  }

  async getRemovable(): Promise<RemovableInterceptor[]> {
    if (!findConfigRoot()) return [];
    const project = await this.readProjectSpec();
    return (project.interceptors ?? []).map(i => ({ name: i.name }));
  }

  async getAllNames(): Promise<string[]> {
    if (!findConfigRoot()) return [];
    const project = await this.readProjectSpec();
    return (project.interceptors ?? []).map(i => i.name);
  }

  registerCommands(addCmd: Command, removeCmd: Command): void {
    addCmd
      .command(this.kind)
      .description('Add a Lambda Interceptor to an existing gateway')
      .option('--name <name>', 'Interceptor name')
      .option('--gateway <name>', 'Gateway to attach the interceptor to')
      .option(
        '--interception-points <points>',
        'Comma-separated points: REQUEST, RESPONSE (e.g. "REQUEST" or "REQUEST,RESPONSE")'
      )
      .option('--lambda-arn <arn>', '[External] Existing Lambda function ARN (forces external mode)')
      .option('--template <name>', '[Managed] Template: pass-through, jwt-scope-authorizer, tools-list-filter')
      .option('--runtime <runtime>', '[Managed] Lambda runtime: python3.12 (default) or nodejs22.x')
      .option('--timeout <seconds>', '[Managed] Lambda timeout in seconds, 1-300 (default: 30)')
      .option(
        '--additional-policies <list>',
        '[Managed] Comma-separated IAM policy file paths (relative to the interceptor code dir) or managed-policy ARNs'
      )
      .option('--no-pass-request-headers', 'Disable passing request headers to the interceptor')
      .option('--json', 'Output as JSON [non-interactive]')
      .action(
        async (cliOptions: {
          name?: string;
          gateway?: string;
          interceptionPoints?: string;
          lambdaArn?: string;
          template?: string;
          runtime?: string;
          timeout?: string;
          additionalPolicies?: string;
          passRequestHeaders?: boolean;
          json?: boolean;
        }) => {
          if (!findConfigRoot()) {
            console.error('No agentcore project found. Run `agentcore create` first.');
            process.exit(1);
          }

          if (cliOptions.name || cliOptions.json) {
            await runCliCommand('add.interceptor', !!cliOptions.json, async () => {
              const fail = (error: string): never => {
                throw new Error(error);
              };

              if (!cliOptions.name || !cliOptions.gateway || !cliOptions.interceptionPoints) {
                fail('--name, --gateway, and --interception-points are required in non-interactive mode');
              }

              // Cross-flag rejection runs BEFORE Zod parse so error messages
              // are user-actionable (mirrors EvaluatorPrimitive.ts:226-235).
              if (cliOptions.lambdaArn) {
                if (cliOptions.template) fail('--template cannot be used with --lambda-arn');
                if (cliOptions.runtime) fail('--runtime cannot be used with --lambda-arn');
                if (cliOptions.timeout) fail('--timeout cannot be used with --lambda-arn');
                if (cliOptions.additionalPolicies) fail('--additional-policies cannot be used with --lambda-arn');
              }

              const points = cliOptions
                .interceptionPoints!.split(',')
                .map(s => s.trim())
                .filter(Boolean);

              for (const p of points) {
                const r = InterceptionPointSchema.safeParse(p);
                if (!r.success) {
                  fail(`Invalid --interception-points value "${p}". Must be REQUEST or RESPONSE.`);
                }
              }

              const interceptionPoints = points as InterceptionPoint[];
              if (new Set(interceptionPoints).size !== interceptionPoints.length) {
                fail('--interception-points must not contain duplicates');
              }
              if (interceptionPoints.length === 0 || interceptionPoints.length > 2) {
                fail('--interception-points must contain 1 or 2 points');
              }

              const passRequestHeaders = cliOptions.passRequestHeaders ?? true;

              let result;
              let mode: 'managed' | 'external';
              let template: InterceptorTemplate = 'pass-through';
              let runtime: InterceptorRuntime = 'python3.12';

              if (cliOptions.lambdaArn) {
                mode = 'external';
                result = await this.add({
                  name: cliOptions.name!,
                  gatewayName: cliOptions.gateway!,
                  interceptionPoints,
                  passRequestHeaders,
                  config: { external: { lambdaArn: cliOptions.lambdaArn } },
                });
              } else {
                mode = 'managed';
                if (cliOptions.runtime) {
                  const rRes = InterceptorRuntimeSchema.safeParse(cliOptions.runtime);
                  if (!rRes.success) {
                    fail(`Invalid --runtime "${cliOptions.runtime}". Must be python3.12 or nodejs22.x.`);
                  }
                  runtime = rRes.data!;
                }
                if (cliOptions.template) {
                  const tRes = InterceptorTemplateSchema.safeParse(cliOptions.template);
                  if (!tRes.success) {
                    fail(
                      `Invalid --template "${cliOptions.template}". Must be pass-through, jwt-scope-authorizer, or tools-list-filter.`
                    );
                  }
                  template = tRes.data!;
                }

                const timeoutSeconds = cliOptions.timeout ? parseInt(cliOptions.timeout, 10) : DEFAULT_TIMEOUT_SECONDS;
                if (Number.isNaN(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 300) {
                  fail('--timeout must be an integer in [1, 300]');
                }

                const entrypoint = runtime === 'python3.12' ? DEFAULT_PYTHON_ENTRYPOINT : DEFAULT_NODE_ENTRYPOINT;

                const parsedPolicies = cliOptions.additionalPolicies
                  ?.split(',')
                  .map(s => s.trim())
                  .filter(Boolean);
                const additionalPolicies = parsedPolicies && parsedPolicies.length > 0 ? parsedPolicies : undefined;

                result = await this.addWithTemplate(
                  {
                    name: cliOptions.name!,
                    gatewayName: cliOptions.gateway!,
                    interceptionPoints,
                    passRequestHeaders,
                    config: {
                      managed: {
                        codeLocation: `app/${cliOptions.name!}/`,
                        entrypoint,
                        timeoutSeconds,
                        runtime,
                        ...(additionalPolicies && { additionalPolicies }),
                      },
                    },
                  },
                  template
                );
              }

              if (!result.success) {
                throw result.error;
              }

              if (cliOptions.json) {
                console.log(JSON.stringify(serializeResult(result)));
              } else if (result.codePath) {
                console.log(`Created interceptor '${result.interceptorName}' (managed)`);
                console.log(`  Code: ${result.codePath}`);
                console.log(`  Template: ${template}`);
                console.log(`  Runtime: ${runtime}`);
                console.log(`\n  Next: Edit the handler, then run \`agentcore deploy\`.`);
              } else {
                console.log(`Added interceptor '${result.interceptorName}' (external)`);
                console.log(
                  `  Note: external Lambdas are trusted to honor the AgentCore interceptor envelope (interceptorOutputVersion 1.0).`
                );
              }

              return {
                mode,
                runtime,
                template,
                has_cross_account_warning: false,
              };
            });
          } else {
            try {
              requireTTY();
              const [{ render }, { default: React }, { AddFlow }] = await Promise.all([
                import('ink'),
                import('react'),
                import('../tui/screens/add/AddFlow'),
              ]);
              const { clear, unmount } = render(
                React.createElement(AddFlow, {
                  isInteractive: false,
                  initialResource: 'interceptor',
                  onExit: () => {
                    clear();
                    unmount();
                    process.exit(0);
                  },
                })
              );
            } catch (error) {
              console.error(getErrorMessage(error));
              process.exit(1);
            }
          }
        }
      );

    this.registerRemoveSubcommand(removeCmd);
  }

  addScreen(): AddScreenComponent {
    return null;
  }

  /**
   * Internal helper: validates and appends to agentcore.json.
   *
   * Performs a redundant cardinality check (already enforced via superRefine)
   * for TUI ergonomics — surfaces the failure inline before scaffolding code.
   */
  private async createInterceptor(options: AddInterceptorOptions): Promise<Interceptor> {
    const project = await this.readProjectSpec();
    project.interceptors ??= [];

    this.checkDuplicate(project.interceptors, options.name);

    // Verify the gateway exists.
    if (!project.agentCoreGateways.some(g => g.name === options.gatewayName)) {
      throw new Error(`Gateway "${options.gatewayName}" not found in agentcore.json.`);
    }

    // Cardinality + unique-point check on the same gateway.
    const existing = project.interceptors.filter(i => i.gatewayName === options.gatewayName);
    if (existing.length >= 2) {
      throw new Error(`Gateway "${options.gatewayName}" already has 2 interceptors. Maximum is 2 per gateway.`);
    }
    const usedPoints = new Set<InterceptionPoint>();
    for (const i of existing) for (const p of i.interceptionPoints) usedPoints.add(p);
    for (const p of options.interceptionPoints) {
      if (usedPoints.has(p)) {
        throw new Error(`Gateway "${options.gatewayName}" already has an interceptor at point ${p}.`);
      }
    }

    const interceptor: Interceptor = {
      name: options.name,
      gatewayName: options.gatewayName,
      interceptionPoints: options.interceptionPoints,
      passRequestHeaders: options.passRequestHeaders ?? true,
      config:
        'managed' in options.config
          ? {
              managed: {
                codeLocation: options.config.managed.codeLocation,
                entrypoint: options.config.managed.entrypoint ?? DEFAULT_PYTHON_ENTRYPOINT,
                timeoutSeconds: options.config.managed.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
                runtime: options.config.managed.runtime ?? 'python3.12',
                ...(options.config.managed.additionalPolicies && {
                  additionalPolicies: options.config.managed.additionalPolicies,
                }),
              },
            }
          : { external: options.config.external },
    };

    project.interceptors.push(interceptor);
    await this.writeProjectSpec(project);

    return interceptor;
  }
}
