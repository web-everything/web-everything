import { describe, it, expect } from 'vitest';
import { isLoadShapedRow, LOAD_CONTENTION_SIGNATURES } from '../daemon-rebuild/smoke-classify/load-shaped.mjs';

describe('isLoadShapedRow: gh-throttle refusal', () => {
  it('treats the real gh-throttle refusal detail as load-shaped', () => {
    const row = {
      ok: false,
      detail: 'dispatch dry-run failed (1/7): reconcile-fix-pass: gh-throttle: throttled — no gh slot within 8.158s (class=background); retry next tick',
    };
    expect(isLoadShapedRow(row)).toBe(true);
  });

  it('does not treat a real code failure as load-shaped', () => {
    expect(isLoadShapedRow({ ok: false, mayBeTransient: false, detail: 'unparsable output: Unexpected token' })).toBe(false);
  });

  it('does not match loosely: other gh-throttle text without the slot refusal is not load-shaped', () => {
    expect(isLoadShapedRow({ ok: false, mayBeTransient: false, detail: 'gh-throttle: config invalid' })).toBe(false);
    expect(LOAD_CONTENTION_SIGNATURES.length).toBeGreaterThan(2);
  });

  it('a passing row is never load-shaped', () => {
    expect(isLoadShapedRow({ ok: true, detail: 'gh-throttle: throttled — no gh slot within 8s' })).toBe(false);
  });
});
