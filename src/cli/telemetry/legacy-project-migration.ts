import type { LegacyProjectMigrationInfo } from '../../lib/schemas/io/config-io.js';
import { setLegacyProjectMigrationReporter } from '../../lib/schemas/io/config-io.js';
import { ANSI } from '../constants.js';
import { TelemetryClientAccessor } from './client-accessor.js';

let noticePrinted = false;

/** Reset the one-time-notice latch. Test-only. */
export function resetLegacyProjectMigrationNotice(): void {
  noticePrinted = false;
}

function printDeprecationNotice(): void {
  if (noticePrinted) return;
  noticePrinted = true;
  const { yellow, reset } = ANSI;
  process.stderr.write(
    [
      '',
      `${yellow}Your agentcore.json uses pre-v0.4.0 keys (\`agents\`, and/or \`type\` on`,
      'credentials/runtimes). These are auto-migrated for now, but support will be',
      'removed in a future release. Update the file to use `runtimes` and',
      `\`authorizerType\` to silence this notice.${reset}`,
      '',
    ].join('\n')
  );
}

/**
 * Wire the CLI's observability into the lib config loader: when a pre-v0.4.0 agentcore.json is
 * auto-migrated on read, emit the `cli.legacy_project_migrated` metric (so legacy-project adoption
 * is measurable and the shim can eventually be removed) and print a one-time deprecation notice.
 *
 * Kept here in the CLI layer so `src/lib` stays free of any telemetry/CLI import.
 */
export function registerLegacyProjectMigrationReporter(): void {
  setLegacyProjectMigrationReporter((info: LegacyProjectMigrationInfo) => {
    void TelemetryClientAccessor.get()
      .then(client =>
        client.emit('cli.legacy_project_migrated', 1, {
          had_agents_key: info.hadAgentsKey,
          had_credential_type_key: info.hadCredentialTypeKey,
          had_runtime_type_key: info.hadRuntimeTypeKey,
        })
      )
      .catch(() => {
        // Telemetry is best-effort and must never affect CLI behavior.
      });
    printDeprecationNotice();
  });
}
