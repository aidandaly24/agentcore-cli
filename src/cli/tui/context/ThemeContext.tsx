import {
  type ThemeColors,
  type ThemeMode,
  getCurrentThemeColors,
  getThemeColors,
  getThemeMode,
} from '../theme';
import React, { type ReactNode, createContext, useContext, useMemo, useState } from 'react';

/**
 * Theme context value interface
 */
interface ThemeContextValue {
  /** Current theme mode ('light' or 'dark') */
  mode: 'light' | 'dark';
  /** Current theme colors */
  colors: ThemeColors;
  /** Whether the theme was auto-detected from system */
  isSystemDetected: boolean;
  /** Set the theme mode manually */
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: 'dark',
  colors: getCurrentThemeColors(),
  isSystemDetected: true,
  setMode: () => {},
});

/**
 * Hook to access the current theme context.
 * Returns the current theme mode, colors, and a function to change the theme.
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { colors, mode } = useTheme();
 *   return <Text color={colors.status.success}>Success!</Text>;
 * }
 * ```
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}

interface ThemeProviderProps {
  /** Initial theme mode (defaults to system detection) */
  initialMode?: ThemeMode;
  children: ReactNode;
}

/**
 * Theme provider component that manages theme state.
 * Wraps the application to provide theme context to all child components.
 *
 * @example
 * ```tsx
 * function App() {
 *   return (
 *     <ThemeProvider>
 *       <MyApp />
 *     </ThemeProvider>
 *   );
 * }
 * ```
 */
export function ThemeProvider({ initialMode = 'system', children }: ThemeProviderProps) {
  // Resolve initial mode
  const resolvedInitialMode = initialMode === 'system' ? getThemeMode() : initialMode;
  const [mode, setModeState] = useState<'light' | 'dark'>(resolvedInitialMode);
  const [isSystemDetected, setIsSystemDetected] = useState(initialMode === 'system');

  const setMode = (newMode: ThemeMode) => {
    if (newMode === 'system') {
      setModeState(getThemeMode());
      setIsSystemDetected(true);
    } else {
      setModeState(newMode);
      setIsSystemDetected(false);
    }
  };

  const colors = useMemo(() => getThemeColors(mode), [mode]);

  const value = useMemo(
    () => ({
      mode,
      colors,
      isSystemDetected,
      setMode,
    }),
    [mode, colors, isSystemDetected]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
