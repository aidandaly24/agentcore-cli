/**
 * Centralized color definitions for the TUI.
 * All color values should be referenced from here to ensure consistency.
 * Supports both light and dark color schemes.
 */

/**
 * Theme preference options.
 */
export type ThemePreference = 'light' | 'dark' | 'system';

/**
 * Resolved theme mode (after system preference is applied).
 */
export type ThemeMode = 'light' | 'dark';

/**
 * Color palette interface for semantic colors.
 */
export interface ColorPalette {
  /** Status colors for indicating state/progress */
  status: {
    success: string;
    error: string;
    warning: string;
    info: string;
    pending: string;
  };
  /** Colors for interactive elements */
  interactive: {
    selection: string;
    cursor: string;
    highlight: string;
  };
  /** Text colors for general content */
  text: {
    primary: string;
    secondary: string;
    muted: string;
    directory: string;
  };
  /** Border colors */
  border: {
    default: string;
    active: string;
  };
}

/**
 * Light mode color palette.
 * Optimized for terminals with light backgrounds.
 */
export const LIGHT_PALETTE: ColorPalette = {
  status: {
    success: 'green',
    error: 'red',
    warning: 'yellow',
    info: 'blue',
    pending: 'gray',
  },
  interactive: {
    selection: 'cyan',
    cursor: 'black',
    highlight: 'cyan',
  },
  text: {
    primary: 'black',
    secondary: 'gray',
    muted: 'gray',
    directory: 'blue',
  },
  border: {
    default: 'gray',
    active: 'cyan',
  },
} as const;

/**
 * Dark mode color palette.
 * Optimized for terminals with dark backgrounds.
 */
export const DARK_PALETTE: ColorPalette = {
  status: {
    success: 'green',
    error: 'red',
    warning: 'yellow',
    info: 'blue',
    pending: 'gray',
  },
  interactive: {
    selection: 'cyan',
    cursor: 'white',
    highlight: 'cyan',
  },
  text: {
    primary: 'white',
    secondary: 'gray',
    muted: 'gray',
    directory: 'blue',
  },
  border: {
    default: 'gray',
    active: 'cyan',
  },
} as const;

/**
 * Get the color palette for a given theme mode.
 */
export function getColorPalette(mode: ThemeMode): ColorPalette {
  return mode === 'light' ? LIGHT_PALETTE : DARK_PALETTE;
}

/**
 * Detect system color scheme preference.
 * Uses environment variables commonly set by terminals to indicate color scheme.
 *
 * Detection methods:
 * 1. COLORFGBG - Format: "fg;bg" where bg > 7 typically indicates dark mode
 * 2. TERM_PROGRAM specific detection (iTerm2, Apple Terminal, etc.)
 * 3. Default to dark mode (most common for CLI tools)
 */
export function detectSystemColorScheme(): ThemeMode {
  // Check COLORFGBG environment variable
  // Format: "foreground;background" where colors are 0-15
  // Background > 7 typically indicates dark mode
  const colorFgBg = process.env['COLORFGBG'];
  if (colorFgBg) {
    const parts = colorFgBg.split(';');
    const bg = parts[parts.length - 1];
    if (bg !== undefined) {
      const bgNum = parseInt(bg, 10);
      if (!isNaN(bgNum)) {
        // Colors 0-7 are typically dark, 8-15 are bright/light
        // A dark background (0-7) means dark mode
        // A light background (8-15, especially 15 for white) means light mode
        return bgNum >= 8 ? 'light' : 'dark';
      }
    }
  }

  // Check for macOS dark mode via TERM_PROGRAM
  // Note: This is a heuristic and may not be accurate for all terminals
  const termProgram = process.env['TERM_PROGRAM'];
  if (termProgram === 'Apple_Terminal') {
    // Apple Terminal follows system appearance
    // We can't reliably detect this, so default to dark
    return 'dark';
  }

  // Check for explicit dark mode indicators
  const colorScheme = process.env['COLOR_SCHEME'];
  if (colorScheme === 'light') {
    return 'light';
  }
  if (colorScheme === 'dark') {
    return 'dark';
  }

  // Default to dark mode (most common for CLI tools)
  return 'dark';
}

/**
 * Resolve theme preference to actual theme mode.
 */
export function resolveThemeMode(preference: ThemePreference): ThemeMode {
  if (preference === 'system') {
    return detectSystemColorScheme();
  }
  return preference;
}

// ============================================================================
// Legacy exports for backward compatibility
// These maintain the existing API while the codebase migrates to theme context
// ============================================================================

/**
 * Semantic status colors for indicating state/progress.
 * @deprecated Use useTheme() hook and colors.status instead
 */
export const STATUS_COLORS = {
  success: 'green',
  error: 'red',
  warning: 'yellow',
  info: 'blue',
  pending: 'gray',
} as const;

/**
 * Colors for interactive elements like selections and highlights.
 * @deprecated Use useTheme() hook and colors.interactive instead
 */
export const INTERACTIVE_COLORS = {
  selection: 'cyan',
  cursor: 'white',
  highlight: 'cyan',
} as const;

/**
 * Text colors for general content.
 * @deprecated Use useTheme() hook and colors.text instead
 */
export const TEXT_COLORS = {
  primary: 'white',
  muted: 'gray',
  directory: 'blue',
} as const;

/**
 * Combined theme object for convenient access.
 * @deprecated Use useTheme() hook instead
 */
export const THEME = {
  status: STATUS_COLORS,
  interactive: INTERACTIVE_COLORS,
  text: TEXT_COLORS,
} as const;
