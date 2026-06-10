import { ConfigIO, ResourceNotFoundError, type Result, ValidationError } from '../../../lib';
import { searchLogs, streamLogs } from '../../aws/cloudwatch';
import { ensureManagedForLogs } from '../shared/interceptor-mode-check';

export interface LogsInterceptorOptions {
  /** Interceptor name (required) */
  name?: string;
  /** Deployment target name (defaults to first target). */
  target?: string;
  /** Search-mode start time (e.g. "1h", ISO 8601). Mutually exclusive with --follow. */
  since?: string;
  /** Search-mode end time. */
  until?: string;
  /** Maximum number of log lines to return in search mode. */
  limit?: string;
  /** Stream logs in real-time. */
  follow?: boolean;
  /** Output as JSON Lines. */
  json?: boolean;
}

const SEARCH_DEFAULT_DURATION_MS = 60 * 60 * 1000; // 1h

function parseRelativeTime(s: string, nowMs: number): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (m) {
    const n = parseInt(m[1]!, 10);
    const unit = m[2]!;
    const ms =
      unit === 's'
        ? n * 1000
        : unit === 'm'
          ? n * 60 * 1000
          : unit === 'h'
            ? n * 60 * 60 * 1000
            : n * 24 * 60 * 60 * 1000;
    return nowMs - ms;
  }
  if (s === 'now') return nowMs;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return t;
  throw new ValidationError(
    `Invalid time value "${s}". Expected ISO 8601, "now", or a relative duration like "1h", "30m".`
  );
}

/**
 * agentcore logs interceptor --name <n> [--follow|--since|--until]
 *
 * Routes to CloudWatch Logs for the managed interceptor's /aws/lambda/<fn>
 * group. External interceptors short-circuit via ensureManagedForLogs,
 * which throws a structured ValidationError carrying the aws logs tail
 * remediation.
 */
export async function handleLogsInterceptor(options: LogsInterceptorOptions): Promise<Result> {
  if (!options.name) {
    return { success: false, error: new ValidationError('--name is required') };
  }

  let entry: Awaited<ReturnType<typeof ensureManagedForLogs>>['entry'];
  let targetName: string;
  try {
    const lookup = await ensureManagedForLogs(options.name, options.target);
    entry = lookup.entry;
    targetName = lookup.targetName;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err : new Error(String(err)) };
  }

  if (!entry.interceptorFunctionName) {
    return {
      success: false,
      error: new ValidationError(
        `Interceptor "${options.name}" has no Lambda function recorded yet. ` +
          `Run \`agentcore deploy\` to provision it before tailing logs.`
      ),
    };
  }

  const configIO = new ConfigIO();
  const targets = await configIO.resolveAWSDeploymentTargets();
  const target = targets.find(t => t.name === targetName) ?? targets[0];
  if (!target) {
    return { success: false, error: new ValidationError('No AWS deployment targets configured.') };
  }

  const logGroupName = `/aws/lambda/${entry.interceptorFunctionName}`;

  // Wire SIGINT to AbortController so Ctrl-C cleanly closes the LiveTail
  // session. Mirrors the pattern in logs/action.ts.
  const ac = new AbortController();
  const onSignal = () => ac.abort();
  process.on('SIGINT', onSignal);

  try {
    if (options.follow ?? (!options.since && !options.until)) {
      for await (const event of streamLogs({
        logGroupName,
        region: target.region,
        accountId: target.account,
        abortSignal: ac.signal,
      })) {
        if (options.json) {
          process.stdout.write(`${JSON.stringify(event)}\n`);
        } else {
          process.stdout.write(`${new Date(event.timestamp).toISOString()} ${event.message}\n`);
        }
      }
      return { success: true };
    }

    const now = Date.now();
    const startTimeMs = options.since ? parseRelativeTime(options.since, now) : now - SEARCH_DEFAULT_DURATION_MS;
    const endTimeMs = options.until ? parseRelativeTime(options.until, now) : now;
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    if (limit !== undefined && (Number.isNaN(limit) || limit < 1)) {
      return { success: false, error: new ValidationError('--limit must be a positive integer.') };
    }

    for await (const ev of searchLogs({
      logGroupName,
      region: target.region,
      startTimeMs,
      endTimeMs,
      ...(limit !== undefined && { limit }),
    })) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(ev)}\n`);
      } else {
        process.stdout.write(`${new Date(ev.timestamp).toISOString()} ${ev.message}\n`);
      }
    }
    return { success: true };
  } catch (err: unknown) {
    const errorName = (err as { name?: string })?.name;

    if (errorName === 'ResourceNotFoundException') {
      return {
        success: false,
        error: new ResourceNotFoundError(
          `Log group "${logGroupName}" does not exist yet. The interceptor Lambda creates it on its first invocation — send a request through the gateway so the interceptor fires, then tail logs.`
        ),
      };
    }

    if (errorName === 'AbortError' || ac.signal.aborted) {
      return { success: true };
    }

    if (err instanceof Error) {
      return { success: false, error: err };
    }
    return { success: false, error: new Error(String(err)) };
  } finally {
    process.removeListener('SIGINT', onSignal);
  }
}
