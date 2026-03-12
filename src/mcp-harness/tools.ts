/**
 * MCP tool schema definitions for the TUI harness.
 *
 * This module defines the JSON Schema-based tool definitions that the MCP server
 * registers for agent interaction with TUI applications. Each tool maps to an
 * operation in the underlying TUI harness (launch, send keys, read screen, etc.).
 *
 * These are pure schema definitions with no runtime dependencies on the MCP SDK
 * or the TUI harness itself.
 */

// ---------------------------------------------------------------------------
// Tool Name Constants
// ---------------------------------------------------------------------------

/**
 * Canonical tool names used by the MCP server.
 *
 * Use these constants instead of raw strings to avoid typos and enable
 * compile-time checking when wiring tool handlers.
 */
export const TOOL_NAMES = {
  LAUNCH: 'tui_launch',
  SEND_KEYS: 'tui_send_keys',
  READ_SCREEN: 'tui_read_screen',
  WAIT_FOR: 'tui_wait_for',
  SCREENSHOT: 'tui_screenshot',
  CLOSE: 'tui_close',
  LIST_SESSIONS: 'tui_list_sessions',
} as const;

// ---------------------------------------------------------------------------
// Tool Definition Interface
// ---------------------------------------------------------------------------

/**
 * Shape of a single MCP tool definition.
 *
 * Follows the MCP tool registration protocol: a human-readable name and
 * description, plus a JSON Schema object that validates the tool's input.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Shared Enum Values
// ---------------------------------------------------------------------------

/**
 * All special key names recognized by the TUI harness, matching the
 * SpecialKey union type in `src/test-utils/tui-harness/types.ts`.
 *
 * Exported so both the JSON Schema definitions (this file) and the Zod
 * schemas in `server.ts` share a single source of truth.
 */
export const SPECIAL_KEY_ENUM = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'delete',
  'space',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'ctrl+c',
  'ctrl+d',
  'ctrl+q',
  'ctrl+g',
  'ctrl+a',
  'ctrl+e',
  'ctrl+w',
  'ctrl+u',
  'ctrl+k',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
] as const;

// ---------------------------------------------------------------------------
// Launch Defaults
// ---------------------------------------------------------------------------

/**
 * Default command and args for `tui_launch` when not specified by the caller.
 *
 * This makes `tui_launch({})` a convenient shorthand for launching the
 * AgentCore CLI TUI.
 */
export const LAUNCH_DEFAULTS = {
  command: 'node',
  args: ['dist/cli/index.mjs'],
} as const;

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

/**
 * Launch a TUI application in a pseudo-terminal.
 */
const tuiLaunch: ToolDefinition = {
  name: TOOL_NAMES.LAUNCH,
  description:
    'Launch a TUI application in a pseudo-terminal. Returns session ID and initial screen state. ' +
    'Defaults to launching AgentCore CLI if no command is specified.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The executable to spawn (e.g. "vim", "htop", "agentcore"). Defaults to "node".',
        default: LAUNCH_DEFAULTS.command,
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Arguments passed to the command. Defaults to ["dist/cli/index.mjs"] (AgentCore CLI).',
        default: [...LAUNCH_DEFAULTS.args],
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the spawned process.',
      },
      cols: {
        type: 'integer',
        description: 'Terminal width in columns.',
        default: 100,
        minimum: 40,
        maximum: 300,
      },
      rows: {
        type: 'integer',
        description: 'Terminal height in rows.',
        default: 30,
        minimum: 10,
        maximum: 100,
      },
      env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Additional environment variables merged with the default environment.',
      },
    },
    additionalProperties: false,
  },
};

/**
 * Send keystrokes to a TUI session.
 */
const tuiSendKeys: ToolDefinition = {
  name: TOOL_NAMES.SEND_KEYS,
  description: 'Send keystrokes to a TUI session. Returns updated screen state after rendering settles.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The session ID returned by tui_launch.',
      },
      keys: {
        type: 'string',
        description: 'Raw text to type into the terminal. For special keys, use the specialKey parameter instead.',
      },
      specialKey: {
        type: 'string',
        enum: [...SPECIAL_KEY_ENUM],
        description: 'A named special key to send (e.g. "enter", "tab", "ctrl+c", "f1"). Mutually usable with keys.',
      },
      waitMs: {
        type: 'integer',
        description: 'Milliseconds to wait for the screen to settle after sending keys.',
        default: 300,
        minimum: 0,
        maximum: 10000,
      },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
};

/**
 * Read the current terminal screen state.
 */
const tuiReadScreen: ToolDefinition = {
  name: TOOL_NAMES.READ_SCREEN,
  description: 'Read the current terminal screen state. Safe read-only operation.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The session ID returned by tui_launch.',
      },
      includeScrollback: {
        type: 'boolean',
        description: 'When true, include lines above the visible viewport (scrollback history).',
        default: false,
      },
      numbered: {
        type: 'boolean',
        description: 'When true, prefix each line with its 1-indexed line number.',
        default: false,
      },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
};

/**
 * Wait for a text pattern to appear on the terminal screen.
 */
const tuiWaitFor: ToolDefinition = {
  name: TOOL_NAMES.WAIT_FOR,
  description:
    'Wait for a text pattern to appear on the terminal screen. Useful for synchronizing with async TUI operations.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The session ID returned by tui_launch.',
      },
      pattern: {
        type: 'string',
        description:
          'The text or regex pattern to search for on screen. Interpreted as a plain substring unless isRegex is true.',
      },
      timeoutMs: {
        type: 'integer',
        description: 'Maximum time in milliseconds to wait for the pattern to appear.',
        default: 5000,
        minimum: 100,
        maximum: 30000,
      },
      isRegex: {
        type: 'boolean',
        description: 'When true, interpret the pattern as a regular expression.',
        default: false,
      },
    },
    required: ['sessionId', 'pattern'],
    additionalProperties: false,
  },
};

/**
 * Capture a formatted screenshot of the terminal.
 */
const tuiScreenshot: ToolDefinition = {
  name: TOOL_NAMES.SCREENSHOT,
  description: 'Capture a formatted screenshot of the terminal with line numbers and borders for debugging.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The session ID returned by tui_launch.',
      },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
};

/**
 * Close a TUI session and terminate the process.
 */
const tuiClose: ToolDefinition = {
  name: TOOL_NAMES.CLOSE,
  description: 'Close a TUI session and terminate the process.',
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'The session ID returned by tui_launch.',
      },
      signal: {
        type: 'string',
        enum: ['SIGTERM', 'SIGKILL', 'SIGHUP'],
        description: 'The signal to send to the process.',
        default: 'SIGTERM',
      },
    },
    required: ['sessionId'],
    additionalProperties: false,
  },
};

/**
 * List all active TUI sessions.
 */
const tuiListSessions: ToolDefinition = {
  name: TOOL_NAMES.LIST_SESSIONS,
  description: 'List all active TUI sessions.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
};

// ---------------------------------------------------------------------------
// Exported Tool Collection
// ---------------------------------------------------------------------------

/**
 * All MCP tool definitions for the TUI harness, ordered by typical usage flow:
 * launch -> send keys -> read screen -> wait for -> screenshot -> close -> list.
 */
export const TOOLS: ToolDefinition[] = [
  tuiLaunch,
  tuiSendKeys,
  tuiReadScreen,
  tuiWaitFor,
  tuiScreenshot,
  tuiClose,
  tuiListSessions,
];
