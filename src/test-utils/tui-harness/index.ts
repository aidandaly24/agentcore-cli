/**
 * Public API surface for the TUI test harness.
 *
 * This barrel file re-exports only the symbols intended for external
 * consumption. Internal implementation details (SettlingMonitor, screen
 * reader helpers, session registry internals) are deliberately excluded.
 *
 * Import convention:
 *   import { TuiSession, isAvailable, closeAll } from '../test-utils/tui-harness/index.js';
 */

// --- Core session class ---
export { TuiSession } from './TuiSession.js';

// --- Types and error classes ---
export type { LaunchOptions, ScreenState, ReadOptions, CloseResult, SessionInfo } from './types.js';
export type { SpecialKey } from './types.js';
export { WaitForTimeoutError, LaunchError } from './types.js';

// --- Key mapping ---
export { KEY_MAP, resolveKey } from './key-map.js';

// --- Availability ---
export { isAvailable, unavailableReason } from './availability.js';

// --- Session management (for test cleanup) ---
export { closeAll } from './session-manager.js';
