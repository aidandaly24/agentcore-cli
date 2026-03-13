import { DARK_THEME, LIGHT_THEME, THEME_ENV_VAR } from '../../theme.js';
import { ThemeProvider, useTheme } from '../ThemeContext.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Test component that uses the theme hook
function ThemeConsumer({ onRender }: { onRender: (theme: ReturnType<typeof useTheme>) => void }) {
  const theme = useTheme();
  onRender(theme);
  return null;
}

describe('ThemeContext', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Clear theme-related env vars
    delete process.env[THEME_ENV_VAR];
    delete process.env.COLORFGBG;
    delete process.env.APPLE_INTERFACE_STYLE;
    delete process.env.TERMINAL_LIGHT_MODE;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('useTheme', () => {
    it('provides dark theme colors by default', () => {
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider>
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(capturedTheme!.mode).toBe('dark');
      expect(capturedTheme!.colors).toEqual(DARK_THEME);
    });

    it('provides light theme colors when initialMode is light', () => {
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider initialMode="light">
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(capturedTheme!.mode).toBe('light');
      expect(capturedTheme!.colors).toEqual(LIGHT_THEME);
    });

    it('provides dark theme colors when initialMode is dark', () => {
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider initialMode="dark">
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(capturedTheme!.mode).toBe('dark');
      expect(capturedTheme!.colors).toEqual(DARK_THEME);
    });

    it('respects AGENTCORE_THEME environment variable for light mode', () => {
      process.env[THEME_ENV_VAR] = 'light';
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider initialMode="system">
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(capturedTheme!.mode).toBe('light');
      expect(capturedTheme!.colors).toEqual(LIGHT_THEME);
    });

    it('sets isSystemDetected to true when using system mode', () => {
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider initialMode="system">
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(capturedTheme!.isSystemDetected).toBe(true);
    });

    it('sets isSystemDetected to false when using explicit mode', () => {
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider initialMode="dark">
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(capturedTheme!.isSystemDetected).toBe(false);
    });

    it('provides setMode function', () => {
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider>
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(typeof capturedTheme!.setMode).toBe('function');
    });
  });

  describe('ThemeProvider', () => {
    it('renders children', () => {
      const { lastFrame } = render(
        <ThemeProvider>
          <span>Test Content</span>
        </ThemeProvider>
      );

      expect(lastFrame()).toContain('Test Content');
    });

    it('defaults to system mode when no initialMode provided', () => {
      let capturedTheme: ReturnType<typeof useTheme> | null = null;

      render(
        <ThemeProvider>
          <ThemeConsumer onRender={theme => (capturedTheme = theme)} />
        </ThemeProvider>
      );

      expect(capturedTheme).not.toBeNull();
      expect(capturedTheme!.isSystemDetected).toBe(true);
    });
  });
});
