import { ConfigIO, type Result, ValidationError } from '../../../lib';
import { getCredentialProvider } from '../../aws/account';
import { ensureManagedForInvoke } from '../shared/interceptor-mode-check';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { readFile } from 'node:fs/promises';

export interface InvokeInterceptorOptions {
  /** Interceptor name (required) */
  name?: string;
  /** Deployment target name (defaults to first target). */
  target?: string;
  /** Inline JSON payload. */
  payload?: string;
  /** Path to a JSON file containing the payload. */
  payloadFile?: string;
  /** Output as JSON. */
  json?: boolean;
}

/**
 * `agentcore invoke interceptor --name <n> [--payload | --payload-file]`.
 *
 * Routes to `lambda:Invoke` against the managed interceptor's deployed-state
 * ARN. External interceptors short-circuit via `ensureManagedForInvoke`,
 * which throws a structured ValidationError carrying the `aws lambda invoke`
 * remediation.
 */
export async function handleInvokeInterceptor(
  options: InvokeInterceptorOptions
): Promise<Result<{ payload: unknown; statusCode?: number }>> {
  if (!options.name) {
    return { success: false, error: new ValidationError('--name is required') };
  }

  try {
    const { entry, targetName } = await ensureManagedForInvoke(options.name, options.target);

    const configIO = new ConfigIO();
    const targets = await configIO.resolveAWSDeploymentTargets();
    const target = targets.find(t => t.name === targetName) ?? targets[0];
    if (!target) {
      return { success: false, error: new ValidationError('No AWS deployment targets configured.') };
    }

    let payloadJson: string | undefined;
    if (options.payloadFile) {
      try {
        payloadJson = await readFile(options.payloadFile, 'utf-8');
      } catch (readErr) {
        const msg = readErr instanceof Error ? readErr.message : String(readErr);
        return {
          success: false,
          error: new ValidationError(`Cannot read --payload-file "${options.payloadFile}": ${msg}`),
        };
      }
    } else if (options.payload) {
      payloadJson = options.payload;
    }

    if (payloadJson) {
      try {
        JSON.parse(payloadJson);
      } catch {
        return {
          success: false,
          error: new ValidationError(
            'Payload is not valid JSON. Provide an object via --payload or a JSON file via --payload-file.'
          ),
        };
      }
    }

    const client = new LambdaClient({ region: target.region, credentials: getCredentialProvider() });
    const response = await client.send(
      new InvokeCommand({
        FunctionName: entry.interceptorArn,
        ...(payloadJson ? { Payload: new TextEncoder().encode(payloadJson) } : {}),
      })
    );

    let decoded: unknown;
    if (response.Payload) {
      const text = new TextDecoder().decode(response.Payload);
      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = text;
      }
    }

    if (options.json) {
      process.stdout.write(
        `${JSON.stringify({ statusCode: response.StatusCode, payload: decoded, functionError: response.FunctionError })}\n`
      );
    } else {
      if (response.FunctionError) {
        process.stderr.write(`FunctionError: ${response.FunctionError}\n`);
      }
      process.stdout.write(`${typeof decoded === 'string' ? decoded : JSON.stringify(decoded, null, 2)}\n`);
    }

    if (response.FunctionError) {
      // Lambda-level errors must produce a non-zero exit so scripted callers
      // can detect them via $? — payload is preserved for diagnostics in the
      // structured error.
      return {
        success: false,
        error: new ValidationError(`Lambda FunctionError: ${response.FunctionError}`),
      };
    }

    return {
      success: true,
      payload: decoded,
      ...(response.StatusCode !== undefined && { statusCode: response.StatusCode }),
    };
  } catch (err) {
    if (err instanceof Error) {
      return { success: false, error: err };
    }
    return { success: false, error: new Error(String(err)) };
  }
}
