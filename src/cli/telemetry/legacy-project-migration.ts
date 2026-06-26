import type { LegacyProjectMigrationInfo } from '../../lib/schemas/io/config-io.js';
import { setLegacyProjectMigrationReporter } from '../../lib/schemas/io/config-io.js';
import { ANSI } from '../constants.js';
import { TelemetryClientAccessor } from './client-accessor.js';

/**
 * Set once a pre-v0.4.0 agentcore.json is auto-migrated on read, so the deprecation notice can be
 * printed *after* the command/TUI exits. Printing synchronously from the reporter would land the
 * notice inside the Ink alt-screen buffer (most legacy-project reads happen inside a TUI flow) where
 * it is immediately repainted over and lost — so we defer, mirroring `printTelemetryNotice` /
 * `printUpdateNotification` which are also flushed via `printPostCommandNotices`.
 */
let migrationObserved = false;
let noticePrinted = false;

/** Reset the deferred-notice state. Test-only. */
export function resetLegacyProjectMigrationNotice(): void {
  migrationObserved = false;
  noticePrinted = false;
}

/**
 * Print the one-time pre-v0.4.0 deprecation notice if a legacy agentcore.json was migrated during
 * this invocation. No-op if no migration was observed or the notice already fired. Call after the
 * TUI/command finishes (the alt-screen buffer has been restored) — see `printPostCommandNotices`.
 */
export function printLegacyProjectMigrationNotice(): void {
  if (!migrationObserved || noticePrinted) return;
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
 * is measurable and the shim can eventually be removed) and arm a one-time deprecation notice that
 * `printPostCommandNotices` flushes after the alt-screen buffer is restored.
 *
 * Kept here in the CLI layer so `src/lib` stays free of any telemetry/CLI import.
 */
export function registerLegacyProjectMigrationReporter(): void {
  setLegacyProjectMigrationReporter((info: LegacyProjectMigrationInfo) => {
    migrationObserved = true;
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
  });
}
