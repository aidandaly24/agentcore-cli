import { afterAll, beforeAll } from 'vitest';

// NOTE: The dynamic imports below reference modules that don't exist until Phase 2.
// TS diagnostics on the import paths are expected and will resolve once the modules are created.

beforeAll(async () => {
  try {
    const { isAvailable, unavailableReason } = await import('../../src/tui-harness/lib/availability.js');
    if (!isAvailable) {
      console.warn(`TUI harness unavailable: ${unavailableReason}. Skipping all TUI tests.`);
    }
  } catch {
    // Harness not yet built
  }
});

afterAll(async () => {
  // Safety net: kill any orphaned PTY sessions
  try {
    const { closeAll } = await import('../../src/tui-harness/lib/session-manager.js');
    await closeAll();
  } catch {
    // Harness not yet built — nothing to clean up
  }
});
