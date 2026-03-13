import { DARK_PALETTE, LIGHT_PALETTE, detectSystemColorScheme, getColorPalette, resolveThemeMode } from '../../theme.js';
import { ThemeProvider, useTheme } from '../ThemeContext.js';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Test component that displays theme information
function ThemeDisplay() {
  const { preference, mode, colors } = useTheme();
  return (
    <Text>
      preference:{preference} mode:{mode} primary:{colors.text.primary}
    </Text>
  );
}

// Test component that can change theme
function ThemeChanger({ onReady }: { onReady: (setPreference: (p: 'light' | 'dark' | 'system') => void) => void }) {
  const { setPreference, mode } = useTheme();
  React.useEffect(() => {
    onReady(setPreference);
  }, [onReady, setPreference]);
  return <Text>mode:{mode}</Text>;
}

describe('ThemeContext', () => {
  describe('ThemeProvider', () => {
    it('provides default system preference', () => {
      const { lastFrame } = render(
        <ThemeProvider>
          <ThemeDisplay />
        </ThemeProvider>
      );

      expect(lastFrame()).toContain('preference:system');
      expect(lastFrame()).toContain('mode:dark'); // Default system detection returns dark
    });

    it('provides dark theme when preference is dark', () => {
      const { lastFrame } = render(
        <ThemeProvider initialPreference="dark">
          <ThemeDisplay />
        </ThemeProvider>
      );

      expect(lastFrame()).toContain('preference:dark');
      expect(lastFrame()).toContain('mode:dark');
      expect(lastFrame()).toContain('primary:white');
    });

    it('provides light theme when preference is light', () => {
      const { lastFrame } = render(
        <ThemeProvider initialPreference="light">
          <ThemeDisplay />
        </ThemeProvider>
      );

      expect(lastFrame()).toContain('preference:light');
      expect(lastFrame()).toContain('mode:light');
      expect(lastFrame()).toContain('primary:black');
    });
  });

  describe('useTheme hook outside provider', () => {
    it('returns default dark theme', () => {
      const { lastFrame } = render(<ThemeDisplay />);

      expect(lastFrame()).toContain('preference:system');
      expect(lastFrame()).toContain('mode:dark');
    });
  });
});

describe('theme utilities', () => {
  describe('getColorPalette', () => {
    it('returns light palette for light mode', () => {
      expect(getColorPalette('light')).toEqual(LIGHT_PALETTE);
    });

    it('returns dark palette for dark mode', () => {
      expect(getColorPalette('dark')).toEqual(DARK_PALETTE);
    });
  });

  describe('resolveThemeMode', () => {
    it('returns light for light preference', () => {
      expect(resolveThemeMode('light')).toBe('light');
    });

    it('returns dark for dark preference', () => {
      expect(resolveThemeMode('dark')).toBe('dark');
    });

    it('detects system preference for system setting', () => {
      // Default system detection returns dark
      expect(resolveThemeMode('system')).toBe('dark');
    });
  });

  describe('detectSystemColorScheme', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset environment for each test
      process.env = { ...originalEnv };
      delete process.env['COLORFGBG'];
      delete process.env['TERM_PROGRAM'];
      delete process.env['COLOR_SCHEME'];
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    it('returns dark by default when no environment hints', () => {
      expect(detectSystemColorScheme()).toBe('dark');
    });

    it('detects dark mode from COLORFGBG with dark background', () => {
      process.env['COLORFGBG'] = '15;0'; // White text on black background
      expect(detectSystemColorScheme()).toBe('dark');
    });

    it('detects light mode from COLORFGBG with light background', () => {
      process.env['COLORFGBG'] = '0;15'; // Black text on white background
      expect(detectSystemColorScheme()).toBe('light');
    });

    it('detects light mode from COLOR_SCHEME environment variable', () => {
      process.env['COLOR_SCHEME'] = 'light';
      expect(detectSystemColorScheme()).toBe('light');
    });

    it('detects dark mode from COLOR_SCHEME environment variable', () => {
      process.env['COLOR_SCHEME'] = 'dark';
      expect(detectSystemColorScheme()).toBe('dark');
    });

    it('handles invalid COLORFGBG gracefully', () => {
      process.env['COLORFGBG'] = 'invalid';
      expect(detectSystemColorScheme()).toBe('dark');
    });
  });
});

describe('color palettes', () => {
  it('light palette has correct structure', () => {
    expect(LIGHT_PALETTE.status).toBeDefined();
    expect(LIGHT_PALETTE.interactive).toBeDefined();
    expect(LIGHT_PALETTE.text).toBeDefined();
    expect(LIGHT_PALETTE.border).toBeDefined();

    expect(LIGHT_PALETTE.status.success).toBe('green');
    expect(LIGHT_PALETTE.status.error).toBe('red');
    expect(LIGHT_PALETTE.text.primary).toBe('black');
    expect(LIGHT_PALETTE.interactive.cursor).toBe('black');
  });

  it('dark palette has correct structure', () => {
    expect(DARK_PALETTE.status).toBeDefined();
    expect(DARK_PALETTE.interactive).toBeDefined();
    expect(DARK_PALETTE.text).toBeDefined();
    expect(DARK_PALETTE.border).toBeDefined();

    expect(DARK_PALETTE.status.success).toBe('green');
    expect(DARK_PALETTE.status.error).toBe('red');
    expect(DARK_PALETTE.text.primary).toBe('white');
    expect(DARK_PALETTE.interactive.cursor).toBe('white');
  });

  it('palettes have different primary text colors', () => {
    expect(LIGHT_PALETTE.text.primary).not.toBe(DARK_PALETTE.text.primary);
  });

  it('palettes have different cursor colors', () => {
    expect(LIGHT_PALETTE.interactive.cursor).not.toBe(DARK_PALETTE.interactive.cursor);
  });
});
