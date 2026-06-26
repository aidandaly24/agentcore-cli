import type { LegacyProjectMigrationInfo, LegacyProjectMigrationReporter } from '../../../lib/schemas/io/config-io';
import * as configIo from '../../../lib/schemas/io/config-io';
import { TelemetryClient } from '../client';
import { TelemetryClientAccessor } from '../client-accessor';
import {
  printLegacyProjectMigrationNotice,
  registerLegacyProjectMigrationReporter,
  resetLegacyProjectMigrationNotice,
} from '../legacy-project-migration';
import { InMemorySink } from '../sinks/in-memory-sink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let sink: InMemorySink;
let capturedReporter: LegacyProjectMigrationReporter | undefined;

const ALL_LEGACY: LegacyProjectMigrationInfo = {
  hadAgentsKey: true,
  hadCredentialTypeKey: true,
  hadRuntimeTypeKey: true,
};

/** Wait for the reporter's fire-and-forget telemetry promise chain to settle. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  sink = new InMemorySink();
  capturedReporter = undefined;
  vi.spyOn(TelemetryClientAccessor, 'get').mockResolvedValue(new TelemetryClient(sink));
  // Capture the reporter the CLI installs, instead of letting it mutate lib module state.
  vi.spyOn(configIo, 'setLegacyProjectMigrationReporter').mockImplementation(reporter => {
    capturedReporter = reporter;
  });
  resetLegacyProjectMigrationNotice();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetLegacyProjectMigrationNotice();
});

describe('registerLegacyProjectMigrationReporter', () => {
  it('emits cli.legacy_project_migrated with the camelCase->snake_case attribute mapping', async () => {
    registerLegacyProjectMigrationReporter();
    expect(capturedReporter).toBeDefined();

    capturedReporter!({ hadAgentsKey: true, hadCredentialTypeKey: false, hadRuntimeTypeKey: true });
    await flushMicrotasks();

    expect(sink.metrics).toHaveLength(1);
    expect(sink.metrics[0]!.metric).toBe('cli.legacy_project_migrated');
    expect(sink.metrics[0]!.value).toBe(1);
    // Booleans are serialized to strings by TelemetryClient.emit; assert each key maps to its own field.
    expect(sink.metrics[0]!.attrs).toEqual({
      had_agents_key: 'true',
      had_credential_type_key: 'false',
      had_runtime_type_key: 'true',
    });
  });

  it('does not let a TelemetryClientAccessor.get() rejection propagate', async () => {
    vi.spyOn(TelemetryClientAccessor, 'get').mockRejectedValue(new Error('no client'));
    registerLegacyProjectMigrationReporter();

    expect(() => capturedReporter!(ALL_LEGACY)).not.toThrow();
    await flushMicrotasks();
    expect(sink.metrics).toHaveLength(0);
  });
});

describe('printLegacyProjectMigrationNotice', () => {
  it('is a no-op when no migration was observed', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    printLegacyProjectMigrationNotice();
    expect(write).not.toHaveBeenCalled();
  });

  it('prints once after a migration is observed, then is a no-op (one-time latch)', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerLegacyProjectMigrationReporter();
    capturedReporter!(ALL_LEGACY);
    await flushMicrotasks();

    printLegacyProjectMigrationNotice();
    printLegacyProjectMigrationNotice();

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]![0])).toContain('pre-v0.4.0');
  });

  it('does not print synchronously from the reporter (deferred to keep it out of the TUI alt-screen)', async () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    registerLegacyProjectMigrationReporter();
    capturedReporter!(ALL_LEGACY);
    await flushMicrotasks();

    // The reporter only arms the notice; nothing is written until printPostCommandNotices flushes it.
    expect(write).not.toHaveBeenCalled();
  });
});
