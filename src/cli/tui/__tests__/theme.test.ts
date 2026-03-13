import {
  DARK_THEME,
  LIGHT_THEME,
  THEME_ENV_VAR,
  detectSystemTheme,
  getCurrentThemeColors,
  getThemeColors,
  getThemeMode,
} from '../theme.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('theme', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('getThemeColors', () => {
    it('returns dark theme colors for dark mode', () => {
      const colors = getThemeColors('dark');

      expect(colors).toEqual(DARK_THEME);
    });

    it('returns light theme colors for light mode', () => {
      const colors = getThemeColors('light');

      expect(colors).toEqual(LIGHT_THEME);
    });
  });

  describe('getThemeMode', () => {
    it('returns dark when AGENTCORE_THEME is set to dark', () => {
      process.env[THEME_ENV_VAR] = 'dark';

      expect(getThemeMode()).toBe('dark');
    });

    it('returns light when AGENTCORE_THEME is set to light', () => {
      process.env[THEME_ENV_VAR] = 'light';

      expect(getThemeMode()).toBe('light');
    });

    it('is case insensitive for AGENTCORE_THEME', () => {
      process.env[THEME_ENV_VAR] = 'LIGHT';

      expect(getThemeMode()).toBe('light');

      process.env[THEME_ENV_VAR] = 'DARK';

      expect(getThemeMode()).toBe('dark');
    });

    it('falls back to system detection when AGENTCORE_THEME is system', () => {
      process.env[THEME_ENV_VAR] = 'system';
      // Clear other env vars that might affect detection
      delete process.env.COLORFGBG;
      delete process.env.APPLE_INTERFACE_STYLE;
      delete process.env.TERMINAL_LIGHT_MODE;

      // Should default to dark when no system indicators
      expect(getThemeMode()).toBe('dark');
    });

    it('falls back to system detection when AGENTCORE_THEME is not set', () => {
      delete process.env[THEME_ENV_VAR];
      delete process.env.COLORFGBG;
      delete process.env.APPLE_INTERFACE_STYLE;
      delete process.env.TERMINAL_LIGHT_MODE;

      // Should default to dark when no system indicators
      expect(getThemeMode()).toBe('dark');
    });
  });

  describe('detectSystemTheme', () => {
    it('returns dark by default when no indicators present', () => {
      delete process.env.COLORFGBG;
      delete process.env.APPLE_INTERFACE_STYLE;
      delete process.env.TERMINAL_LIGHT_MODE;

      expect(detectSystemTheme()).toBe('dark');
    });

    it('detects light mode from COLORFGBG with light background', () => {
      process.env.COLORFGBG = '0;15'; // Black text on white background

      expect(detectSystemTheme()).toBe('light');
    });

    it('detects dark mode from COLORFGBG with dark background', () => {
      process.env.COLORFGBG = '15;0'; // White text on black background

      expect(detectSystemTheme()).toBe('dark');
    });

    it('detects light mode from APPLE_INTERFACE_STYLE', () => {
      process.env.APPLE_INTERFACE_STYLE = 'Light';

      expect(detectSystemTheme()).toBe('light');
    });

    it('detects light mode from TERMINAL_LIGHT_MODE=true', () => {
      process.env.TERMINAL_LIGHT_MODE = 'true';

      expect(detectSystemTheme()).toBe('light');
    });

    it('detects light mode from TERMINAL_LIGHT_MODE=1', () => {
      process.env.TERMINAL_LIGHT_MODE = '1';

      expect(detectSystemTheme()).toBe('light');
    });
  });

  describe('getCurrentThemeColors', () => {
    it('returns dark theme colors when mode is dark', () => {
      process.env[THEME_ENV_VAR] = 'dark';

      const colors = getCurrentThemeColors();

      expect(colors).toEqual(DARK_THEME);
    });

    it('returns light theme colors when mode is light', () => {
      process.env[THEME_ENV_VAR] = 'light';

      const colors = getCurrentThemeColors();

      expect(colors).toEqual(LIGHT_THEME);
    });
  });

  describe('theme color palettes', () => {
    it('dark theme has all required color categories', () => {
      expect(DARK_THEME.status).toBeDefined();
      expect(DARK_THEME.interactive).toBeDefined();
      expect(DARK_THEME.text).toBeDefined();
    });

    it('light theme has all required color categories', () => {
      expect(LIGHT_THEME.status).toBeDefined();
      expect(LIGHT_THEME.interactive).toBeDefined();
      expect(LIGHT_THEME.text).toBeDefined();
    });

    it('dark theme has all status colors', () => {
      expect(DARK_THEME.status.success).toBeDefined();
      expect(DARK_THEME.status.error).toBeDefined();
      expect(DARK_THEME.status.warning).toBeDefined();
      expect(DARK_THEME.status.info).toBeDefined();
      expect(DARK_THEME.status.pending).toBeDefined();
    });

    it('light theme has all status colors', () => {
      expect(LIGHT_THEME.status.success).toBeDefined();
      expect(LIGHT_THEME.status.error).toBeDefined();
      expect(LIGHT_THEME.status.warning).toBeDefined();
      expect(LIGHT_THEME.status.info).toBeDefined();
      expect(LIGHT_THEME.status.pending).toBeDefined();
    });

    it('dark theme has all interactive colors', () => {
      expect(DARK_THEME.interactive.selection).toBeDefined();
      expect(DARK_THEME.interactive.cursor).toBeDefined();
      expect(DARK_THEME.interactive.highlight).toBeDefined();
    });

    it('light theme has all interactive colors', () => {
      expect(LIGHT_THEME.interactive.selection).toBeDefined();
      expect(LIGHT_THEME.interactive.cursor).toBeDefined();
      expect(LIGHT_THEME.interactive.highlight).toBeDefined();
    });

    it('dark theme has all text colors', () => {
      expect(DARK_THEME.text.primary).toBeDefined();
      expect(DARK_THEME.text.muted).toBeDefined();
      expect(DARK_THEME.text.directory).toBeDefined();
    });

    it('light theme has all text colors', () => {
      expect(LIGHT_THEME.text.primary).toBeDefined();
      expect(LIGHT_THEME.text.muted).toBeDefined();
      expect(LIGHT_THEME.text.directory).toBeDefined();
    });
  });
});
