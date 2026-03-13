/**
 * Centralized color definitions for the TUI.
 * All color values should be referenced from here to ensure consistency.
 * Supports both light and dark mode themes.
 */

/**
 * Theme mode type - either 'light', 'dark', or 'system' (auto-detect)
 */
export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Color palette interface for a single theme
 */
export interface ThemeColors {
  status: {
    success: string;
    error: string;
    warning: string;
    info: string;
    pending: string;
  };
  interactive: {
    selection: string;
    cursor: string;
    highlight: string;
  };
  text: {
    primary: string;
    muted: string;
    directory: string;
  };
}

/**
 * Dark mode color palette - optimized for dark terminal backgrounds
 */
export const DARK_THEME: ThemeColors = {
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
    muted: 'gray',
    directory: 'blue',
  },
};

/**
 * Light mode color palette - optimized for light terminal backgrounds
 */
export const LIGHT_THEME: ThemeColors = {
  status: {
    success: 'greenBright',
    error: 'redBright',
    warning: 'yellowBright',
    info: 'blueBright',
    pending: 'blackBright',
  },
  interactive: {
    selection: 'cyanBright',
    cursor: 'black',
    highlight: 'cyanBright',
  },
  text: {
    primary: 'black',
    muted: 'blackBright',
    directory: 'blueBright',
  },
};

/**
 * Environment variable name for theme configuration
 */
export const THEME_ENV_VAR = 'AGENTCORE_THEME';

/**
 * Detect system color scheme preference.
 * Checks common environment variables and terminal settings.
 * Returns 'dark' as default since most terminal users prefer dark mode.
 */
export function detectSystemTheme(): 'light' | 'dark' {
  // Check COLORFGBG environment variable (format: "fg;bg" where higher bg = light)
  const colorFgBg = process.env.COLORFGBG;
  if (colorFgBg) {
    const parts = colorFgBg.split(';');
    const bg = parseInt(parts[parts.length - 1], 10);
    // Background colors 0-6 and 8 are typically dark, 7 and 9-15 are light
    if (!isNaN(bg) && (bg === 7 || (bg >= 9 && bg <= 15))) {
      return 'light';
    }
  }

  // Check macOS appearance (if available via environment)
  const appleInterfaceStyle = process.env.APPLE_INTERFACE_STYLE;
  if (appleInterfaceStyle?.toLowerCase() === 'light') {
    return 'light';
  }

  // Check for explicit light terminal indicators
  const termProgram = process.env.TERM_PROGRAM?.toLowerCase();
  const colorTerm = process.env.COLORTERM?.toLowerCase();

  // Some terminals set specific variables when in light mode
  if (process.env.TERMINAL_LIGHT_MODE === 'true' || process.env.TERMINAL_LIGHT_MODE === '1') {
    return 'light';
  }

  // Default to dark mode (most common for terminal users)
  return 'dark';
}

/**
 * Get the current theme mode from environment or system detection.
 * Priority: AGENTCORE_THEME env var > system detection
 */
export function getThemeMode(): 'light' | 'dark' {
  const envTheme = process.env[THEME_ENV_VAR]?.toLowerCase();

  if (envTheme === 'light') {
    return 'light';
  }

  if (envTheme === 'dark') {
    return 'dark';
  }

  if (envTheme === 'system' || !envTheme) {
    return detectSystemTheme();
  }

  // Invalid value, default to system detection
  return detectSystemTheme();
}

/**
 * Get the theme colors for the specified mode.
 */
export function getThemeColors(mode: 'light' | 'dark'): ThemeColors {
  return mode === 'light' ? LIGHT_THEME : DARK_THEME;
}

/**
 * Get the current theme colors based on environment/system settings.
 */
export function getCurrentThemeColors(): ThemeColors {
  return getThemeColors(getThemeMode());
}

// Legacy exports for backward compatibility
// These use the current theme colors dynamically

/**
 * @deprecated Use useTheme() hook or getCurrentThemeColors() instead
 * Semantic status colors for indicating state/progress.
 */
export const STATUS_COLORS = {
  get success() {
    return getCurrentThemeColors().status.success;
  },
  get error() {
    return getCurrentThemeColors().status.error;
  },
  get warning() {
    return getCurrentThemeColors().status.warning;
  },
  get info() {
    return getCurrentThemeColors().status.info;
  },
  get pending() {
    return getCurrentThemeColors().status.pending;
  },
} as const;

/**
 * @deprecated Use useTheme() hook or getCurrentThemeColors() instead
 * Colors for interactive elements like selections and highlights.
 */
export const INTERACTIVE_COLORS = {
  get selection() {
    return getCurrentThemeColors().interactive.selection;
  },
  get cursor() {
    return getCurrentThemeColors().interactive.cursor;
  },
  get highlight() {
    return getCurrentThemeColors().interactive.highlight;
  },
} as const;

/**
 * @deprecated Use useTheme() hook or getCurrentThemeColors() instead
 * Text colors for general content.
 */
export const TEXT_COLORS = {
  get primary() {
    return getCurrentThemeColors().text.primary;
  },
  get muted() {
    return getCurrentThemeColors().text.muted;
  },
  get directory() {
    return getCurrentThemeColors().text.directory;
  },
} as const;

/**
 * @deprecated Use useTheme() hook or getCurrentThemeColors() instead
 * Combined theme object for convenient access.
 */
export const THEME = {
  get status() {
    return STATUS_COLORS;
  },
  get interactive() {
    return INTERACTIVE_COLORS;
  },
  get text() {
    return TEXT_COLORS;
  },
} as const;
