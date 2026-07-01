import { MultiSelectList } from '../../components/MultiSelectList.js';
import { SelectList } from '../../components/SelectList.js';
import { StepIndicator } from '../../components/StepIndicator.js';
import { isUnicodeSupported, symbols } from '../symbols.js';
import { render } from 'ink-testing-library';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../hooks/useResponsive.js', () => ({
  useResponsive: () => ({ width: 120, height: 40, isNarrow: false }),
}));

// Every non-ASCII glyph the TUI/console renders. None of these may appear when
// Unicode support is forced off (the legacy-Windows path).
const NON_ASCII_GLYPHS = ['❯', '↑', '↓', '✓', '✗', '●', '○', '→', '⚑', '▶'];

function withAscii(off: boolean, fn: () => void) {
  const prev = process.env.AGENTCORE_ASCII;
  process.env.AGENTCORE_ASCII = off ? '1' : '0';
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.AGENTCORE_ASCII;
    else process.env.AGENTCORE_ASCII = prev;
  }
}

afterEach(() => {
  delete process.env.AGENTCORE_ASCII;
});

describe('symbols', () => {
  it('AGENTCORE_ASCII override flips Unicode detection', () => {
    withAscii(true, () => expect(isUnicodeSupported()).toBe(false));
    withAscii(false, () => expect(isUnicodeSupported()).toBe(true));
  });

  it('emits ASCII fallbacks when Unicode is off', () => {
    withAscii(true, () => {
      expect(symbols.cursor).toBe('>');
      expect(symbols.checkboxOn).toBe('[x]');
      expect(symbols.checkboxOff).toBe('[ ]');
      expect(symbols.arrowUp).toBe('^');
      expect(symbols.arrowDown).toBe('v');
      expect(symbols.stepDone).toBe('x');
      expect(symbols.stepCurrent).toBe('*');
      expect(symbols.stepPending).toBe('o');
      expect(symbols.branch).toBe('->');
      expect(symbols.success).toBe('OK');
      expect(symbols.failure).toBe('X');
      // checked and unchecked stay distinguishable
      expect(symbols.checkboxOn).not.toBe(symbols.checkboxOff);
    });
  });

  it('emits original glyphs when Unicode is on', () => {
    withAscii(false, () => {
      expect(symbols.cursor).toBe('❯');
      expect(symbols.checkboxOn).toBe('[✓]');
      expect(symbols.stepCurrent).toBe('●');
    });
  });
});

describe('TUI glyph fallback (legacy Windows)', () => {
  const items = [
    { id: 'a', title: 'Alpha' },
    { id: 'b', title: 'Bravo' },
  ];

  it('SelectList renders no non-ASCII codepoints with Unicode off', () => {
    withAscii(true, () => {
      const { lastFrame } = render(<SelectList items={items} selectedIndex={0} maxVisibleItems={1} />);
      const frame = lastFrame()!;
      expect(frame).toContain('>');
      for (const g of NON_ASCII_GLYPHS) expect(frame).not.toContain(g);
    });
  });

  it('MultiSelectList keeps checkbox state distinguishable in both modes', () => {
    withAscii(true, () => {
      const { lastFrame } = render(
        <MultiSelectList items={items} selectedIndex={0} selectedIds={new Set(['a'])} />
      );
      const frame = lastFrame()!;
      expect(frame).toContain('[x]');
      expect(frame).toContain('[ ]');
      for (const g of NON_ASCII_GLYPHS) expect(frame).not.toContain(g);
    });
    withAscii(false, () => {
      const { lastFrame } = render(
        <MultiSelectList items={items} selectedIndex={0} selectedIds={new Set(['a'])} />
      );
      const frame = lastFrame()!;
      expect(frame).toContain('[✓]');
      expect(frame).toContain('[ ]');
    });
  });

  it('StepIndicator renders no non-ASCII codepoints with Unicode off', () => {
    withAscii(true, () => {
      const steps = ['one', 'two', 'three'] as const;
      const labels = { one: 'One', two: 'Two', three: 'Three' };
      const { lastFrame } = render(<StepIndicator steps={[...steps]} currentStep="two" labels={labels} />);
      const frame = lastFrame()!;
      for (const g of NON_ASCII_GLYPHS) expect(frame).not.toContain(g);
    });
  });
});
