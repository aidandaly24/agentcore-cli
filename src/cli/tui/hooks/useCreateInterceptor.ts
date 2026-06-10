import type { InterceptorRuntime, InterceptorTemplate } from '../../../schema';
import { interceptorPrimitive } from '../../primitives/registry';
import { withCommandRunTelemetry } from '../../telemetry/cli-command-run.js';
import type { AddInterceptorConfig } from '../screens/interceptor/types';
import { DEFAULT_INTERCEPTOR_RUNTIME, DEFAULT_INTERCEPTOR_TEMPLATE } from '../screens/interceptor/types';
import { useCallback, useEffect, useState } from 'react';

interface CreateInterceptorConfig {
  config: AddInterceptorConfig;
  template: InterceptorTemplate;
}

export function useCreateInterceptor() {
  const [status, setStatus] = useState<{ state: 'idle' | 'loading' | 'success' | 'error'; error?: string }>({
    state: 'idle',
  });

  const create = useCallback(async ({ config, template }: CreateInterceptorConfig) => {
    setStatus({ state: 'loading' });
    try {
      const isManaged = 'managed' in config.config;
      const mode: 'managed' | 'external' = isManaged ? 'managed' : 'external';
      const runtime: InterceptorRuntime =
        'managed' in config.config
          ? (config.config.managed.runtime ?? DEFAULT_INTERCEPTOR_RUNTIME)
          : DEFAULT_INTERCEPTOR_RUNTIME;
      const effectiveTemplate: InterceptorTemplate = isManaged ? template : DEFAULT_INTERCEPTOR_TEMPLATE;

      const addResult = await withCommandRunTelemetry(
        'add.interceptor',
        {
          mode,
          runtime,
          template: effectiveTemplate,
          has_cross_account_warning: false,
        },
        () => interceptorPrimitive.addWithTemplate(config, effectiveTemplate)
      );
      if (!addResult.success) {
        throw new Error(addResult.error?.message ?? 'Failed to create interceptor');
      }
      setStatus({ state: 'success' });
      return { ok: true as const, interceptorName: addResult.interceptorName, codePath: addResult.codePath };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create interceptor.';
      setStatus({ state: 'error', error: message });
      return { ok: false as const, error: message };
    }
  }, []);

  const reset = useCallback(() => {
    setStatus({ state: 'idle' });
  }, []);

  return { status, createInterceptor: create, reset };
}

export function useExistingInterceptorNames() {
  const [names, setNames] = useState<string[]>([]);

  useEffect(() => {
    void interceptorPrimitive.getAllNames().then(setNames);
  }, []);

  const refresh = useCallback(async () => {
    const result = await interceptorPrimitive.getAllNames();
    setNames(result);
  }, []);

  return { names, refresh };
}
