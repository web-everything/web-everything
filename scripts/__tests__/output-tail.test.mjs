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
  it('does not splice interleaved streams into a secret-shaped line', () => {
    const tail = createOutputTail();
    const secret = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0';
    tail.push(`auth ${secret.slice(0, 8)}`, 'stdout'); tail.push('stderr noise\n', 'stderr'); tail.push(`${secret.slice(8)}\n`, 'stdout');
    const out = tail.finish().join('\n');
    expect(out).toContain('stderr noise');
    expect(out).not.toContain(secret);
  });
  it('scrubs before clipping and counts bytes, not characters', () => {
    const secret = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0';
    const tail = createOutputTail({ maxLineChars: 50, maxBytes: 100 });
    tail.push(`${'x'.repeat(45)} ${secret}\n`);
    expect(tail.finish().join('\n')).not.toContain('ghp_');
    const wide = createOutputTail({ maxBytes: 100 });
    for (let i = 0; i < 20; i++) wide.push(`${'é'.repeat(30)}\n`);
    expect(Buffer.byteLength(wide.finish().join('\n'))).toBeLessThanOrEqual(100);
  });
  it('drops the whole overlong line, including a secret that straddles the cut', () => {
    const secret = 'gh' + 'p_' + 'a1B2c3D4e5F6g7H8i9J0';
    const tail = createOutputTail();
    tail.push('z'.repeat(4090) + secret.slice(0, 8)); tail.push(`${secret.slice(8)}\nnext line\n`);
    const out = tail.finish().join('\n');
    expect(out).not.toContain('e5F6g7H8i9J0');
    expect(out).toContain('next line');
  });
  it('keeps a single multibyte line within the byte cap', () => {
    const tail = createOutputTail({ maxBytes: 100, maxLineChars: 400 });
    tail.push(`${'\u20ac'.repeat(80)}\n`);
    expect(Buffer.byteLength(tail.finish().join('\n'))).toBeLessThanOrEqual(100);
  });
});
