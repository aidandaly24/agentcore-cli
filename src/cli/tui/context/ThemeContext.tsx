import {
  type ColorPalette,
  type ThemeMode,
  type ThemePreference,
  getColorPalette,
  resolveThemeMode,
} from '../theme.js';
import React, { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Theme context value interface.
 */
export interface ThemeContextValue {
  /** Current theme preference (light/dark/system) */
  preference: ThemePreference;
  /** Resolved theme mode after applying system preference */
  mode: ThemeMode;
  /** Color palette for the current theme */
  colors: ColorPalette;
  /** Update the theme preference */
  setPreference: (preference: ThemePreference) => void;
}

/**
 * Default theme context value.
 */
const defaultThemeContext: ThemeContextValue = {
  preference: 'system',
  mode: 'dark',
  colors: getColorPalette('dark'),
  setPreference: () => {
    // No-op for default context
  },
};

/**
 * React context for theme management.
 */
const ThemeContext = createContext<ThemeContextValue>(defaultThemeContext);

/**
 * Hook to access the current theme context.
 *
 * @returns The current theme context value including colors, mode, and preference setter
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { colors, mode, setPreference } = useTheme();
 *
 *   return (
 *     <Box>
 *       <Text color={colors.text.primary}>Hello</Text>
 *       <Text color={colors.status.success}>Success!</Text>
 *     </Box>
 *   );
 * }
 * ```
 */
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

/**
 * Props for the ThemeProvider component.
 */
export interface ThemeProviderProps {
  /** Child components to wrap with theme context */
  children: ReactNode;
  /** Initial theme preference (defaults to 'system') */
  initialPreference?: ThemePreference;
}

/**
 * Provider component for theme context.
 * Wraps the application to provide theme-aware colors throughout the component tree.
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <ThemeProvider initialPreference="system">
 *       <MyApp />
 *     </ThemeProvider>
 *   );
 * }
 * ```
 */
export function ThemeProvider({ children, initialPreference = 'system' }: ThemeProviderProps) {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference);

  // Resolve the actual theme mode based on preference
  const mode = useMemo(() => resolveThemeMode(preference), [preference]);

  // Get the color palette for the current mode
  const colors = useMemo(() => getColorPalette(mode), [mode]);

  // Memoized setter to avoid unnecessary re-renders
  const setPreference = useCallback((newPreference: ThemePreference) => {
    setPreferenceState(newPreference);
  }, []);

  // Memoize the context value to prevent unnecessary re-renders
  const contextValue = useMemo<ThemeContextValue>(
    () => ({
      preference,
      mode,
      colors,
      setPreference,
    }),
    [preference, mode, colors, setPreference]
  );

  return <ThemeContext.Provider value={contextValue}>{children}</ThemeContext.Provider>;
}
