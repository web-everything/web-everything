import { describe, it, expect, afterEach } from 'vitest';
import { setProcessTitle, formatProcessTitle, PROCESS_TITLE_MAX } from '../process-title.mjs';

describe('process-title', () => {
  const orig = process.title;
  afterEach(() => { try { process.title = orig; } catch { /* ignore */ } });

  it('formats role and detail', () => {
    expect(formatProcessTitle('review-loop', '#6330')).toBe('we:review-loop #6330');
    expect(formatProcessTitle('health-watch', 'tick')).toBe('we:health-watch tick');
    expect(formatProcessTitle('verify', 'lane-21')).toBe('we:verify lane-21');
  });
  it('omits a missing or non-string detail', () => {
    expect(formatProcessTitle('drain')).toBe('we:drain');
    expect(formatProcessTitle('drain', null)).toBe('we:drain');
    expect(formatProcessTitle('drain', { a: 1 })).toBe('we:drain');
  });
  it('accepts a numeric detail', () => {
    expect(formatProcessTitle('drain', 6288)).toBe('we:drain 6288');
  });
  it('truncates to the max length', () => {
    const t = formatProcessTitle('review-extra-seats', 'x'.repeat(100));
    expect(t.length).toBe(PROCESS_TITLE_MAX);
    expect(t.startsWith('we:review-extra-seats ')).toBe(true);
  });
  it('sets process.title and never touches argv', () => {
    const argv = [...process.argv];
    const argv0 = process.argv0;
    const r = setProcessTitle('drain', '#6288');
    expect(r).toBe('we:drain #6288');
    expect(process.argv).toEqual(argv);
    expect(process.argv0).toBe(argv0);
  });
  it('never throws on bad input', () => {
    expect(() => setProcessTitle()).not.toThrow();
    expect(() => setProcessTitle(null, undefined)).not.toThrow();
    expect(() => setProcessTitle(Symbol('x'), Symbol('y'))).not.toThrow();
    expect(() => setProcessTitle({ toString() { throw new Error('boom'); } }, 1)).not.toThrow();
  });
});
