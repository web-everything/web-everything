import { describe, it, expect } from 'vitest';
import { isLoadShapedRow } from '../daemon-rebuild/smoke-classify/load-shaped.mjs';

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
  });

  it('an aggregated row that also carries a code failure is not load-shaped', () => {
    const detail = 'dispatch dry-run failed (2/7): review: gh-throttle: throttled — no gh slot within 8.1s (class=background); retry next tick; fix: TypeError: x is not a function';
    expect(isLoadShapedRow({ ok: false, detail })).toBe(false);
  });

  it('a row marked mayBeTransient:false is not load-shaped by the throttle text', () => {
    expect(isLoadShapedRow({ ok: false, mayBeTransient: false, detail: 'x: gh-throttle: throttled — no gh slot within 8s' })).toBe(false);
  });

  it('throttle text followed by a code failure on a new line is not load-shaped', () => {
    const detail = 'gh-throttle: throttled — no gh slot within 8s (class=read); retry next tick\nTypeError: x is not a function';
    expect(isLoadShapedRow({ ok: false, detail })).toBe(false);
  });

  it('a passing row is never load-shaped', () => {
    expect(isLoadShapedRow({ ok: true, detail: 'gh-throttle: throttled — no gh slot within 8s' })).toBe(false);
  });
});
