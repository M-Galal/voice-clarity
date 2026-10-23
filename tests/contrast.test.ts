import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DARK, LIGHT } from '../src/ui/theme';

// WCAG 2.x relative luminance and contrast ratio
const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

for (const [name, p] of [['light', LIGHT], ['dark', DARK]] as const) {
  test(`${name} theme text pairs meet WCAG AA 4.5:1`, () => {
    const pairs: [string, string][] = [
      [p.text, p.bg], [p.text, p.surface], [p.text, p.surface2], [p.textMuted, p.surface], [p.textMuted, p.surface2],
      [p.onPrimary, p.primary], [p.primary, p.surface], [p.warn, p.warnBg], [p.danger, p.surface], [p.ok, p.surface],
    ];
    for (const [a, b] of pairs) assert.ok(ratio(a, b) >= 4.5, `${a} on ${b}: ${ratio(a, b).toFixed(2)}`);
  });
}
