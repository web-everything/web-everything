import { describe, it, expect } from 'vitest';
import { isLoadShapedRow } from '../daemon-rebuild/smoke-classify/load-shaped.mjs';
import { runLiveSmoke } from '../daemon-live-smoke.mjs';

describe('isLoadShapedRow: gh-throttle refusal', () => {
  it('treats the production non-transient dispatch-dry-run refusal as load-shaped', () => {
    const row = {
      name: 'dispatch-dry-run',
      ok: false,
      ms: 8200,
      mayBeTransient: false,
      detail: 'dispatch dry-run failed (1/7): reconcile-fix-pass: gh-throttle: throttled — no gh slot within 8.158s (class=background); retry next tick — review 12ms, reconcile-fix-pass 8.2s',
    };
    expect(isLoadShapedRow(row)).toBe(true);
  });

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

  it.each([undefined, true, false])('mixed code failures stay rejected with mayBeTransient=%s', (mayBeTransient) => {
    const detail = 'dispatch dry-run failed (2/7): review: gh-throttle: throttled — no gh slot within 8.1s (class=background); retry next tick; fix: TypeError: x is not a function';
    expect(isLoadShapedRow({ ok: false, mayBeTransient, detail })).toBe(false);
  });

  it.each([undefined, true, false])('slot refusals are load-shaped with mayBeTransient=%s', (mayBeTransient) => {
    const detail = 'x: gh-throttle: throttled — no gh slot within 8s';
    expect(isLoadShapedRow({ ok: false, mayBeTransient, detail })).toBe(true);
    expect(isLoadShapedRow({ ok: false, mayBeTransient, detail: `${detail}; ${detail}` })).toBe(true);
  });

  it('generic transient errors still respect the non-transient flag', () => {
    const detail = 'HTTP 503';
    expect(isLoadShapedRow({ ok: false, mayBeTransient: true, detail })).toBe(true);
    expect(isLoadShapedRow({ ok: false, mayBeTransient: false, detail })).toBe(false);
  });

  it('classifies the real live-smoke dispatch result including its non-transient flag', async () => {
    const smoke = await runLiveSmoke({
      root: '.', env: {}, repos: [], shadow: () => null, admit: () => null,
      load: () => 0, cores: () => 1,
      runChild: async (cmd, args, opts) => {
        if (opts.env.GH_CALLER === 'rebuild-smoke:dispatch-dry-run') {
          return JSON.stringify([
            { kind: 'review', ok: true, ms: 12 },
            { kind: 'reconcile-fix-pass', ok: false, ms: 8200,
              error: 'gh-throttle: throttled — no gh slot within 8.158s (class=background); retry next tick' },
          ]);
        }
        if (args[1] === 'list') return '[]';
        if (args[1] === 'acquire') return JSON.stringify({ lane: 2 });
        return cmd === 'node' ? JSON.stringify({ ok: true }) : '';
      },
    });
    const row = smoke.results.find(({ name }) => name === 'dispatch-dry-run');
    expect(row).toMatchObject({ ok: false, mayBeTransient: false });
    expect(row.detail).toBe('dispatch dry-run failed (1/2): reconcile-fix-pass: gh-throttle: throttled — no gh slot within 8.158s (class=background); retry next tick — review 12ms, reconcile-fix-pass 8.2s');
    expect(isLoadShapedRow(row)).toBe(true);
  });

  it('throttle text followed by a code failure on a new line is not load-shaped', () => {
    const detail = 'gh-throttle: throttled — no gh slot within 8s (class=read); retry next tick\nTypeError: x is not a function';
    expect(isLoadShapedRow({ ok: false, detail })).toBe(false);
  });

  it('arbitrary text after the timings dash is not load-shaped', () => {
    const detail = 'gh-throttle: throttled — no gh slot within 8s (class=read); retry next tick — TypeError: x is not a function';
    expect(isLoadShapedRow({ ok: false, detail })).toBe(false);
  });

  it('the real detail with a timings suffix is load-shaped', () => {
    const detail = 'dispatch dry-run failed (1/7): reconcile-fix-pass: gh-throttle: throttled — no gh slot within 8.158s (class=background); retry next tick — review 12ms, reconcile-fix-pass 8.2s';
    expect(isLoadShapedRow({ ok: false, detail })).toBe(true);
  });

  it('a passing row is never load-shaped', () => {
    expect(isLoadShapedRow({ ok: true, detail: 'gh-throttle: throttled — no gh slot within 8s' })).toBe(false);
  });
});
