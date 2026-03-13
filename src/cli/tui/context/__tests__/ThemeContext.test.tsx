import { renderHook, act } from '@testing-library/react';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';

import { ThemeProvider, useTheme } from '../ThemeContext';
import {
  detectSystemColorScheme,
  resolveThemeMode,
  getColorPalette,
  LIGHT_PALETTE,
  DARK_PALETTE,
} from '../../theme';

// Mock React Testing Library's renderHook for Ink components
// Since we're testing React hooks, we can use a simple wrapper
function createWrapper(initialPreference?: 'light' | 'dark' | 'system') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <ThemeProvider initialPreference={initialPreference}>{children}</ThemeProvider>;
  };
}

describe('ThemeContext', () => {
  describe('useTheme hook', () => {
    it('returns default dark theme when used outside provider', () => {
      const { result } = renderHook(() => useTheme());

      expect(result.current.preference).toBe('system');
      expect(result.current.mode).toBe('dark');
      expect(result.current.colors).toEqual(DARK_PALETTE);
    });

    it('returns dark theme when preference is dark', () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: createWrapper('dark'),
      });

      expect(result.current.preference).toBe('dark');
      expect(result.current.mode).toBe('dark');
      expect(result.current.colors).toEqual(DARK_PALETTE);
    });

    it('returns light theme when preference is light', () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: createWrapper('light'),
      });

      expect(result.current.preference).toBe('light');
      expect(result.current.mode).toBe('light');
      expect(result.current.colors).toEqual(LIGHT_PALETTE);
    });

    it('allows changing theme preference', () => {
      const { result } = renderHook(() => useTheme(), {
        wrapper: createWrapper('dark'),
      });

      expect(result.current.mode).toBe('dark');

      act(() => {
        result.current.setPreference('light');
      });

      expect(result.current.preference).toBe('light');
      expect(result.current.mode).toBe('light');
      expect(result.current.colors).toEqual(LIGHT_PALETTE);
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
