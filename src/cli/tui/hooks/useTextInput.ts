import { isMacOS, isWindows } from '../../../lib/utils/platform';
import { useInput } from 'ink';
import { spawnSync } from 'node:child_process';
import React, { useCallback, useState } from 'react';

/**
 * Synchronously read the OS clipboard so Ctrl+V works on consoles (e.g. classic Windows conhost)
 * that pass the raw control byte to the app instead of injecting the clipboard text themselves.
 * Mirrors the cross-platform clipboard-write in fetch-access's useFetchAccessFlow. Returns '' on
 * any failure (missing tool, empty clipboard) so paste is a safe no-op.
 */
function readClipboard(): string {
  const [cmd, args]: [string, string[]] = isWindows
    ? ['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]
    : isMacOS
      ? ['pbpaste', []]
      : ['xclip', ['-o', '-selection', 'clipboard']];
  let result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.status !== 0 && !isWindows && !isMacOS) {
    result = spawnSync('xsel', ['-b'], { encoding: 'utf8' });
  }
  if (result.status !== 0 || typeof result.stdout !== 'string') return '';
  // Windows Get-Clipboard appends a trailing newline; trim it without touching interior content.
  return isWindows ? result.stdout.replace(/\r?\n$/, '') : result.stdout;
}

/** Find the position of the previous word boundary */
export function findPrevWordBoundary(text: string, cursor: number): number {
  let pos = cursor;
  while (pos > 0 && text.charAt(pos - 1) === ' ') pos--;
  while (pos > 0 && text.charAt(pos - 1) !== ' ') pos--;
  return pos;
}

/** Find the position of the next word boundary */
export function findNextWordBoundary(text: string, cursor: number): number {
  let pos = cursor;
  while (pos < text.length && text.charAt(pos) !== ' ') pos++;
  while (pos < text.length && text.charAt(pos) === ' ') pos++;
  return pos;
}

export interface UseTextInputOptions {
  initialValue?: string;
  /** Called when Enter is pressed */
  onSubmit?: (value: string) => void;
  /** Called when Escape is pressed */
  onCancel?: () => void;
  /** Called when value changes */
  onChange?: (value: string) => void;
  /** Called when backspace is pressed on an empty input */
  onBackspaceEmpty?: () => void;
  /** Called when up arrow is pressed */
  onUpArrow?: () => void;
  /** Called when down arrow is pressed */
  onDownArrow?: () => void;
  /** Whether input is active (default: true) */
  isActive?: boolean;
  /** Characters to ignore (not added to input) */
  excludeChars?: string[];
}

export interface UseTextInputResult {
  value: string;
  cursor: number;
  setValue: (value: string) => void;
  clear: () => void;
}

/**
 * Shared hook for text input with cursor position and editing shortcuts.
 * Handles all keyboard input internally via useInput.
 *
 * Supported shortcuts:
 * - ←/→: Move cursor
 * - Ctrl+A / Cmd+←: Cursor to start
 * - Ctrl+E / Cmd+→: Cursor to end
 * - Alt+B / Alt+←: Cursor back one word
 * - Alt+F / Alt+→: Cursor forward one word
 * - Backspace: Delete char before cursor
 * - Ctrl+W / Cmd+Backspace: Delete previous word
 * - Ctrl+U / Cmd+Backspace: Delete to start
 * - Ctrl+K: Delete to end
 */
export function useTextInput({
  initialValue = '',
  onSubmit,
  onCancel,
  onChange,
  onBackspaceEmpty,
  onUpArrow,
  onDownArrow,
  isActive = true,
  excludeChars,
}: UseTextInputOptions = {}): UseTextInputResult {
  const [state, setState] = useState({ text: initialValue, cursor: initialValue.length });

  const setValue = useCallback((value: string) => {
    setState({ text: value, cursor: value.length });
  }, []);

  const clear = useCallback(() => {
    setState({ text: '', cursor: 0 });
  }, []);

  // Notify on text changes (skip initial value)
  const prevText = React.useRef(initialValue);
  React.useEffect(() => {
    if (state.text !== prevText.current) {
      prevText.current = state.text;
      onChange?.(state.text);
    }
  }, [state.text, onChange]);

  useInput(
    (input, key) => {
      // Escape
      if (key.escape) {
        onCancel?.();
        return;
      }

      // Enter
      if (key.return) {
        onSubmit?.(state.text);
        return;
      }

      // Backspace variants
      if (key.backspace || key.delete) {
        if (state.cursor === 0 && state.text.length === 0) {
          onBackspaceEmpty?.();
          return;
        }
        setState(prev => {
          if (prev.cursor === 0) {
            return prev;
          }
          // Cmd+Backspace: delete to start
          if (key.meta) {
            return { text: prev.text.slice(prev.cursor), cursor: 0 };
          }
          // Regular backspace
          return {
            text: prev.text.slice(0, prev.cursor - 1) + prev.text.slice(prev.cursor),
            cursor: prev.cursor - 1,
          };
        });
        return;
      }

      // Ctrl+W: delete previous word
      if (key.ctrl && input === 'w') {
        setState(prev => {
          const newCursor = findPrevWordBoundary(prev.text, prev.cursor);
          return { text: prev.text.slice(0, newCursor) + prev.text.slice(prev.cursor), cursor: newCursor };
        });
        return;
      }

      // Ctrl+U: delete to start
      if (key.ctrl && input === 'u') {
        setState(prev => ({ text: prev.text.slice(prev.cursor), cursor: 0 }));
        return;
      }

      // Ctrl+K: delete to end
      if (key.ctrl && input === 'k') {
        setState(prev => ({ text: prev.text.slice(0, prev.cursor), cursor: prev.cursor }));
        return;
      }

      // Ctrl+V: paste from OS clipboard (consoles that drop the raw control byte instead of
      // injecting clipboard text themselves). Insert at cursor with the same control-char filtering
      // as the regular-character branch below.
      if (key.ctrl && input === 'v') {
        // eslint-disable-next-line no-control-regex
        const pasted = readClipboard().replace(/[\x7f\x08\r]/g, '');
        if (pasted) {
          setState(prev => ({
            text: prev.text.slice(0, prev.cursor) + pasted + prev.text.slice(prev.cursor),
            cursor: prev.cursor + pasted.length,
          }));
        }
        return;
      }

      // Arrow keys
      if (key.leftArrow) {
        setState(prev => ({
          ...prev,
          cursor: key.meta ? 0 : Math.max(0, prev.cursor - 1),
        }));
        return;
      }
      if (key.rightArrow) {
        setState(prev => ({
          ...prev,
          cursor: key.meta ? prev.text.length : Math.min(prev.text.length, prev.cursor + 1),
        }));
        return;
      }

      // Up/down arrows - pass to callbacks
      if (key.upArrow) {
        onUpArrow?.();
        return;
      }
      if (key.downArrow) {
        onDownArrow?.();
        return;
      }

      // Ctrl+A: cursor to start
      if (key.ctrl && input === 'a') {
        setState(prev => ({ ...prev, cursor: 0 }));
        return;
      }

      // Ctrl+E: cursor to end
      if (key.ctrl && input === 'e') {
        setState(prev => ({ ...prev, cursor: prev.text.length }));
        return;
      }

      // Alt+B: cursor back one word
      if (key.meta && input === 'b') {
        setState(prev => ({ ...prev, cursor: findPrevWordBoundary(prev.text, prev.cursor) }));
        return;
      }

      // Alt+F: cursor forward one word
      if (key.meta && input === 'f') {
        setState(prev => ({ ...prev, cursor: findNextWordBoundary(prev.text, prev.cursor) }));
        return;
      }

      // Alt+Backspace (escape + DEL)
      if (key.meta && (input === '\x7f' || input === '\x08')) {
        setState(prev => {
          const newCursor = findPrevWordBoundary(prev.text, prev.cursor);
          return { text: prev.text.slice(0, newCursor) + prev.text.slice(prev.cursor), cursor: newCursor };
        });
        return;
      }

      // Regular character input
      if (input && !key.ctrl && !key.meta) {
        // Skip excluded characters
        if (excludeChars?.includes(input)) return;
        // Filter out control characters (DEL, backspace, carriage return)
        // eslint-disable-next-line no-control-regex
        const filtered = input.replace(/[\x7f\x08\r]/g, '');
        if (filtered) {
          setState(prev => ({
            text: prev.text.slice(0, prev.cursor) + filtered + prev.text.slice(prev.cursor),
            cursor: prev.cursor + filtered.length,
          }));
        }
      }
    },
    { isActive }
  );

  return { value: state.text, cursor: state.cursor, setValue, clear };
}
