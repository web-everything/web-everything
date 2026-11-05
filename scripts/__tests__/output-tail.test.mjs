/**
 * @file scripts/__tests__/output-tail.test.mjs
 * @description Red-first proof of the verify-timeout output tail: last 200 lines, bounded, secrets scrubbed.
 */
import { describe, it, expect } from 'vitest';
import { createOutputTail, OUTPUT_TAIL_LINES } from '../lib/output-tail.mjs';

describe('output tail (verify timeout)', () => {
  it('keeps only the last 200 lines across chunk boundaries', () => {
    const tail = createOutputTail();
    for (let i = 0; i < 500; i++) tail.push(`line ${i}\n`);
    tail.push('partial');
    const lines = tail.finish();
    expect(OUTPUT_TAIL_LINES).toBe(200);
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)).toBe('partial');
    expect(lines[0]).toBe('line 301');
  });
  it('joins a line split across chunks', () => {
    const tail = createOutputTail();
    tail.push('RUN scripts/__tests__/sl'); tail.push('ow.test.mjs\n');
    expect(tail.finish()).toEqual(['RUN scripts/__tests__/slow.test.mjs']);
  });
  it('bounds total bytes and per-line length', () => {
    const tail = createOutputTail({ maxBytes: 1000, maxLineChars: 50 });
    tail.push(`${'x'.repeat(5000)}\n`);
    for (let i = 0; i < 100; i++) tail.push(`${'y'.repeat(40)}${i}\n`);
    const lines = tail.finish();
    expect(lines.join('\n').length).toBeLessThanOrEqual(1000);
    expect(lines.every(l => l.length <= 50)).toBe(true);
  });
  it('scrubs secret-shaped lines but keeps test file names', () => {
    const tail = createOutputTail();
    tail.push('RUN scripts/__tests__/slow.test.mjs\n');
    tail.push(`auth ${'gh' + 'p_'}${'a1B2c3D4e5F6g7H8i9J0'}\n`);
    tail.push(`password=${'Hunter2'}Trombone99\n`);
    const out = tail.finish().join('\n');
    expect(out).toContain('scripts/__tests__/slow.test.mjs');
    expect(out).not.toContain('a1B2c3D4e5F6g7H8i9J0');
    expect(out).not.toContain('Trombone99');
    expect(out).toContain('[redacted');
  });
  it('strips ANSI escapes', () => {
    const tail = createOutputTail();
    tail.push('\u001b[31mFAIL\u001b[0m a.test.mjs\n');
    expect(tail.finish()).toEqual(['FAIL a.test.mjs']);
  });
});
