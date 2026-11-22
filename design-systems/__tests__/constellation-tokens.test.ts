import { describe, expect, it } from 'vitest';

interface Token {
  name: string;
  value: string | Record<string, string>;
  usage: string;
  derive?: { mix: string; over: string; percent: number };
}
import source from '../constellation.tokens.json';
// Pinned archive reference: c54319e. Tests never read the originating repository.
import archive from './fixtures/constellation-archive-tokens.json';
const themes = ['dusk', 'day'] as const;
const allowedAdditions = [
  'on-accent', 'accent-hover', 'surface-hover', 'line-soft', 'signal-warn',
  'accent-soft', 'running-soft', 'landed-soft', 'failed-soft', 'warn-soft',
  'track', 'ribbon', 'tip-bg', 'tip-ink', 'hatch-ground', 'hatch-ink',
];
// Designer-ruled day-theme contrast fixes over the archive (DZ-DS).
const dayContrastOverrides: Record<string, string> = { 'signal-running': '#0a717d', 'signal-landed': '#0e7457' };
const allowedTopLevelAdditions = ['hatch'];
const allowedTypeAdditions = ['appFonts', 'familyUsage'];
const tokens = source.color.tokens as Token[];
function token(name: string): Token {
  const found = tokens.find(t => t.name === name);
  if (!found) throw new Error(`Missing colour token: ${name}`);
  return found;
}
function hex(name: string, theme: string): string {
  const value = token(name).value;
  const resolved = typeof value === 'string' ? value : value[theme];
  if (!/^#[0-9a-f]{6}$/i.test(resolved)) throw new Error(`Invalid ${name}.${theme}: ${resolved}`);
  return resolved;
}
function rgb(value: string): number[] {
  return [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16));
}
function luminance(value: string): number {
  const channels = rgb(value).map(channel => {
    const s = channel / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function hue(value: string): number {
  const [r, g, b] = rgb(value).map(c => c / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  if (delta === 0) throw new Error(`Achromatic warning comparison: ${value}`);
  const sector = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return (sector * 60 + 360) % 360;
}

describe('Constellation token source', () => {
  it('source holds every constellation colour in dusk and day, matching the archived tokens', () => {
    expect(Object.keys(source).sort()).toEqual([...Object.keys(archive), ...allowedTopLevelAdditions].sort());
    expect(source.name).toEqual(archive.name);
    expect(source.version).toEqual(archive.version);
    expect(Object.keys(source.color).sort()).toEqual(Object.keys(archive.color).sort());
    expect(source.color.themes).toEqual(archive.color.themes);
    const archivedTokens = archive.color.tokens as Token[];
    expect(tokens.map(t => t.name).sort()).toEqual([...archivedTokens.map(t => t.name), ...allowedAdditions].sort());
    for (const original of archivedTokens) {
      const expectedValue = dayContrastOverrides[original.name]
        ? { ...(original.value as Record<string, string>), day: dayContrastOverrides[original.name] }
        : original.value;
      expect(token(original.name).value, `${original.name}: source differs from archived value`).toEqual(expectedValue);
      expect(Object.keys(token(original.name)).sort()).toEqual(Object.keys(original).sort());
      if (original.name !== 'sky-cyan') expect(token(original.name).usage).toEqual(original.usage);
    }
    for (const t of tokens) {
      expect(t.usage.trim().length, `${t.name} needs usage`).toBeGreaterThan(0);
      for (const theme of themes) hex(t.name, theme);
    }
    for (const section of ['spacing', 'radius', 'shadow'] as const) {
      expect(source[section], `${section}: source differs from archive`).toEqual(archive[section]);
    }
    expect(Object.keys(source.type).sort()).toEqual([...Object.keys(archive.type), ...allowedTypeAdditions].sort());
    for (const [key, value] of Object.entries(archive.type)) {
      expect(source.type[key as keyof typeof archive.type], `type.${key}: source differs from archive`).toEqual(value);
    }
    expect(source.type.appFonts).toEqual({ heading: 'body', body: 'body', data: 'mono' });
    expect(source.type.familyUsage).toEqual({
      display: 'Bricolage Grotesque: landing and marketing only.',
      body: 'Instrument Sans: app headings and body.',
      mono: 'JetBrains Mono: numbers, ids and durations.',
      serif: 'Instrument Serif: sim and preview hero only.',
    });
    expect(token('sky-cyan').usage).toContain('AI line colour; day uses signal-running');
  });

  it('contrast pairs hold', () => {
    const pairs: [string, string, number][] = [
      ...['ink', 'ink-muted'].flatMap(ink => ['bg', 'surface', 'surface-raised'].map(
        ground => [ink, ground, 4.5] as [string, string, number],
      )),
      ['line-strong', 'surface', 3], ['on-sun', 'sun', 4.5], // archive values give 9.6:1; the designer floor is 4.5.
      ['on-accent', 'accent', 4.5], ['signal-warn', 'surface', 4.5],
      ['hatch-ink', 'hatch-ground', 3],
      // Signal text on its own soft tint. failed is excluded: its archive day value (#c2264a) gives 4.42:1 and is not in the designer's fix list.
      ['accent', 'accent-soft', 4.5], ['signal-running', 'running-soft', 4.5],
      ['signal-landed', 'landed-soft', 4.5], ['signal-warn', 'warn-soft', 4.5],
    ];
    for (const theme of themes) for (const [fg, bg, minimum] of pairs) {
      const a = luminance(hex(fg, theme)), b = luminance(hex(bg, theme));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      expect(ratio, `${theme}: ${fg} on ${bg} must reach ${minimum}:1; got ${ratio}`).toBeGreaterThanOrEqual(minimum);
    }
  });

  it('soft tints are the 16 percent mix over surface', () => {
    const mixes = {
      'accent-soft': 'accent', 'running-soft': 'signal-running',
      'landed-soft': 'signal-landed', 'failed-soft': 'signal-failed', 'warn-soft': 'signal-warn',
    };
    for (const [name, colour] of Object.entries(mixes)) {
      expect(token(name).derive).toEqual({ mix: colour, over: 'surface', percent: 16 });
      for (const theme of themes) {
        const foreground = rgb(hex(colour, theme)), background = rgb(hex('surface', theme));
        // Linear interpolation of encoded sRGB channels, rounded to the nearest byte.
        const expected = '#' + foreground.map((c, i) => Math.round(c * 0.16 + background[i] * 0.84).toString(16).padStart(2, '0')).join('');
        expect(hex(name, theme), `${name}.${theme} must be the explicit 16 percent mix`).toEqual(expected);
      }
    }
  });

  it('warn is not sun', () => {
    for (const theme of themes) for (const other of ['sun', 'signal-needs-you']) {
      const difference = Math.abs(hue(hex('signal-warn', theme)) - hue(hex(other, theme)));
      expect(Math.min(difference, 360 - difference), `${theme}: warning hue must differ from ${other} by at least 20 degrees`).toBeGreaterThanOrEqual(20); // designer-ruled day warn #865e00 is 22 degrees from sun
    }
    expect(token('signal-warn').usage).toContain('sun is needs-you only');
    expect(token('signal-warn').usage).toContain('Warn always carries a word or icon');
  });

  it('hatch tokens and rule are present', () => {
    expect(token('hatch-ground').value).toEqual(token('surface-raised').value);
    expect((token('hatch-ink').value as Record<string, string>).dusk).toEqual((token('line-strong').value as Record<string, string>).dusk);
    expect(source.hatch).toEqual({
      periodPx: 5, strokePx: 1.6, lean: '/',
      usage: 'Forecast or future only. Never animated, never progress.',
    });
  });
});
