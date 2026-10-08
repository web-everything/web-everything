/**
 * @file verdict-ledger-store-conformance.mjs - the suite EVERY ledger store adapter must pass (card xsij7u6).
 *   Not a test file itself (no `.test.`): an adapter's own test calls `runLedgerStoreConformance` with a harness.
 *
 * A harness is `async (use) => ...` that builds a fresh, isolated store and hands `use` an object:
 *   { store, appendCtx, readCtx, repo, breakStore(), }
 *   - `appendCtx` / `readCtx`: extra context the adapter needs (e.g. `{board}`); `repo` is passed on top.
 *   - `breakStore()`: make the backing medium unreachable, so the failure rules can be exercised.
 */
import { describe, it, expect } from 'vitest';
import { validateLedgerStore, LEDGER_ORDERINGS } from '../verdict-ledger-store.mjs';
import { buildVerdictRecord, buildLedgerEvent } from '../verdict-ledger.mjs';

const REPO = 'web-everything/web-everything';
const AT = '2026-10-07T12:00:00.000Z';
const verdict = (pr) => buildVerdictRecord({ repo: REPO, pr, verdict: 'accepted', at: AT, source: 'test' });
const ruling = (pr) => buildLedgerEvent({ type: 'ruling', repo: REPO, pr, at: AT, source: 'test', findingKey: `f${pr}`, ruling: 'block' });

export function runLedgerStoreConformance(label, harness) {
  const withStore = (fn) => async () => { await harness(fn); };
  describe(`ledger store conformance: ${label}`, () => {
    it('has the contract shape and a capabilities descriptor', withStore(async (h) => {
      expect(validateLedgerStore(h.store)).toEqual({ ok: true, errors: [] });
      expect(typeof h.store.capabilities.durable).toBe('boolean');
      expect(typeof h.store.capabilities.shared).toBe('boolean');
      expect(LEDGER_ORDERINGS).toContain(h.store.capabilities.ordering);
    }));

    it('an untouched ledger reads as ok with no rows', withStore(async (h) => {
      const r = h.store.read({ ...h.readCtx, repo: h.repo });
      expect(r.status).toBe('ok');
      expect(r.rows).toEqual([]);
    }));

    it('append then read returns the rows in append order, v1 verdicts and v2 events alike', withStore(async (h) => {
      const a = h.store.append([verdict(1), ruling(2)], { ...h.appendCtx, repo: h.repo });
      expect(a).toMatchObject({ ok: true, appended: 2 });
      const b = h.store.append([verdict(3)], { ...h.appendCtx, repo: h.repo });
      expect(b).toMatchObject({ ok: true, appended: 1 });
      const r = h.store.read({ ...h.readCtx, repo: h.repo });
      expect(r.status).toBe('ok');
      expect(r.rows.map((x) => x.pr)).toEqual([1, 2, 3]);
      expect(r.rows[1].type).toBe('ruling');
    }));

    it('read({from}) skips that many leading rows', withStore(async (h) => {
      h.store.append([verdict(1), verdict(2), verdict(3)], { ...h.appendCtx, repo: h.repo });
      const r = h.store.read({ ...h.readCtx, repo: h.repo, from: 2 });
      expect(r.rows.map((x) => x.pr)).toEqual([3]);
    }));

    it('an invalid row refuses the whole call and writes nothing', withStore(async (h) => {
      const bad = { ...ruling(5), ruling: 'maybe' };
      const a = h.store.append([verdict(4), bad], { ...h.appendCtx, repo: h.repo });
      expect(a.ok).toBe(false);
      expect(a.appended).toBe(0);
      expect(typeof a.error).toBe('string');
      expect(h.store.read({ ...h.readCtx, repo: h.repo }).rows ?? []).toEqual([]);
    }));

    it('an empty append is refused, not a quiet success', withStore(async (h) => {
      expect(h.store.append([], { ...h.appendCtx, repo: h.repo }).ok).toBe(false);
    }));

    it('a read that fails is `unreadable`, NEVER an empty ok', withStore(async (h) => {
      h.store.append([verdict(1)], { ...h.appendCtx, repo: h.repo });
      h.breakStore();
      const r = h.store.read({ ...h.readCtx, repo: h.repo });
      expect(r.status).toBe('unreadable');
      expect(r.rows).toBeUndefined();
      expect(typeof r.error).toBe('string');
    }));

    it('an append that fails returns ok:false and never throws', withStore(async (h) => {
      h.breakStore();
      let a;
      expect(() => { a = h.store.append([verdict(1)], { ...h.appendCtx, repo: h.repo }); }).not.toThrow();
      expect(a.ok).toBe(false);
      expect(a.appended).toBe(0);
      expect(typeof a.error).toBe('string');
    }));
  });
}
