import type { InterceptorRuntime, InterceptorTemplate } from '../../schema';
import { copyAndRenderDir } from './render';
import { getTemplatePath } from './templateRoot';

const RUNTIME_DIR: Record<InterceptorRuntime, string> = {
  'python3.12': 'python-lambda',
  'nodejs22.x': 'node-lambda',
};

/**
 * Renders an interceptor template tree to the supplied output directory.
 *
 * Genuinely 4-arg (not a 1:1 mirror of EvaluatorRenderer):
 *   - `runtime` selects `python-lambda` vs `node-lambda` template root
 *   - `template` selects `pass-through` / `jwt-scope-authorizer` / `tools-list-filter` subdir
 *   - Handlebars data: `{ Name, Template, InterceptionPoint? }` (caller supplies extras via overrides)
 */
export async function renderInterceptorTemplate(
  name: string,
  runtime: InterceptorRuntime,
  template: InterceptorTemplate,
  outputDir: string,
  extraData: Record<string, unknown> = {}
): Promise<void> {
  const templateDir = getTemplatePath('interceptors', RUNTIME_DIR[runtime], template);
  // PackageName is the lowercase form for NPM compliance (npm rejects
  // uppercase package names). Templates that need a name in the
  // user-supplied case still use {{ Name }}.
  await copyAndRenderDir(templateDir, outputDir, {
    Name: name,
    PackageName: name.toLowerCase(),
    Template: template,
    Runtime: runtime,
    ...extraData,
  });
}
