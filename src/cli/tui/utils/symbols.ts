/**
 * Single source of truth for the Unicode glyphs the TUI and console output use,
 * each paired with an ASCII fallback for terminals that cannot render them
 * (legacy Windows CMD / older PowerShell on a non-UTF-8 code page).
 *
 * Detection mirrors the `is-unicode-supported` heuristic but is hand-rolled to
 * avoid a new dependency. The result is evaluated lazily on every access so that
 * a process can switch modes (used by tests and the AGENTCORE_ASCII override).
 */

/**
 * Whether the current terminal can render the BMP Unicode glyphs we use.
 *
 * Honors an explicit override first:
 *   - AGENTCORE_ASCII=1 / true  forces ASCII fallbacks (off)
 *   - AGENTCORE_ASCII=0 / false forces Unicode (on)
 * Otherwise: always on for non-Windows (except the bare Linux kernel console);
 * on Windows only for terminals known to support Unicode (Windows Terminal,
 * VS Code, modern emulators, CI), matching `is-unicode-supported`.
 */
export function isUnicodeSupported(): boolean {
  const override = process.env.AGENTCORE_ASCII;
  if (override === '1' || override?.toLowerCase() === 'true') return false;
  if (override === '0' || override?.toLowerCase() === 'false') return true;

  if (process.platform !== 'win32') {
    return process.env.TERM !== 'linux';
  }

  return [
    Boolean(process.env.WT_SESSION),
    process.env.TERMINAL_EMULATOR === 'JetBrains-JediTerm',
    process.env.TERM_PROGRAM === 'vscode',
    process.env.ConEmuTask === '{cmd::Cmder}',
    process.env.TERM === 'xterm-256color',
    process.env.TERM === 'alacritty',
    Boolean(process.env.CI),
  ].some(Boolean);
}

interface Glyph {
  readonly unicode: string;
  readonly ascii: string;
}

const GLYPHS = {
  cursor: { unicode: '❯', ascii: '>' },
  checkboxOn: { unicode: '[✓]', ascii: '[x]' },
  checkboxOff: { unicode: '[ ]', ascii: '[ ]' },
  arrowUp: { unicode: '↑', ascii: '^' },
  arrowDown: { unicode: '↓', ascii: 'v' },
  stepDone: { unicode: '✓', ascii: 'x' },
  stepCurrent: { unicode: '●', ascii: '*' },
  stepPending: { unicode: '○', ascii: 'o' },
  branch: { unicode: '→', ascii: '->' },
  pointer: { unicode: '▶', ascii: '>' },
  flag: { unicode: '⚑', ascii: '*' },
  success: { unicode: '✓', ascii: 'OK' },
  failure: { unicode: '✗', ascii: 'X' },
} satisfies Record<string, Glyph>;

type SymbolName = keyof typeof GLYPHS;
type SymbolMap = Readonly<Record<SymbolName, string>>;

/**
 * Live, lazily-evaluated glyph map. Each access re-checks Unicode support so the
 * rendered string always matches the current terminal (and test overrides).
 */
export const symbols: SymbolMap = Object.defineProperties(
  {},
  Object.fromEntries(
    (Object.keys(GLYPHS) as SymbolName[]).map(name => [
      name,
      { enumerable: true, get: () => (isUnicodeSupported() ? GLYPHS[name].unicode : GLYPHS[name].ascii) },
    ])
  )
) as SymbolMap;
