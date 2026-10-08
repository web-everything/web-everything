/**
 * @file verdict-ledger-store-conformance.mjs - the suite EVERY ledger store adapter must pass (card xsij7u6).
 *   Not a test file itself (no `.test.`): an adapter's own test calls `runLedgerStoreConformance` with a harness.
 *
 * A harness is `async (use) => ...` that builds a fresh, isolated store and hands `use` an object:
 *   { store, appendCtx, readCtx, repo, breakStore(), }
 *   - `appendCtx` / `readCtx`: extra context the adapter needs (e.g. `{board}`); `repo` is passed on top.
 *   - `breakStore()`: make the backing medium unreachable, so the failure rules can be exercised.
 *   - `failMidBatch(n)`: arm a failure of the next append once `n` rows of it are on the medium. A store that writes
 *     row by row then holds a prefix of `n` rows; a store whose batch is atomic holds none.
 *   - `healStore()`: undo `breakStore` / `failMidBatch`, so what really persisted can be read back.
 *   - `atomicBatch`: boolean. `true` when a failed batch persists no rows at all (one commit, one push).
 */
import { describe, it, expect } from 'vitest';
import { validateLedgerStore, LEDGER_ORDERINGS, LEDGER_SINGLE_WRITER } from '../verdict-ledger-store.mjs';
import { buildVerdictRecord, buildLedgerEvent, ledgerEventId } from '../verdict-ledger.mjs';

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
      expect(LEDGER_SINGLE_WRITER).toContain(h.store.capabilities.singleWriter);
    }));

    it('append and read return promises', withStore(async (h) => {
      const a = h.store.append([verdict(1)], { ...h.appendCtx, repo: h.repo });
      expect(a).toBeInstanceOf(Promise);
      await a;
      const r = h.store.read({ ...h.readCtx, repo: h.repo });
      expect(r).toBeInstanceOf(Promise);
      await r;
    }));

    it('deduplicates repeat calls and repeats within a batch, stamping every event id', withStore(async (h) => {
      const rows = [verdict(1), ruling(2)];
      expect(await h.store.append([...rows, rows[0]], { ...h.appendCtx, repo: h.repo }))
        .toEqual({ ok: true, appended: 2, duplicates: 1 });
      expect(await h.store.append(rows, { ...h.appendCtx, repo: h.repo }))
        .toEqual({ ok: true, appended: 0, duplicates: 2 });
      const r = await h.store.read({ ...h.readCtx, repo: h.repo });
      expect(r.rows.map((r) => r.id)).toEqual(rows.map(ledgerEventId));
    }));

    it('an untouched ledger reads as ok with no rows', withStore(async (h) => {
      const r = (await h.store.read({ ...h.readCtx, repo: h.repo }));
      expect(r.status).toBe('ok');
      expect(r.rows).toEqual([]);
    }));

    it('append then read returns the rows in append order, v1 verdicts and v2 events alike', withStore(async (h) => {
      const a = (await h.store.append([verdict(1), ruling(2)], { ...h.appendCtx, repo: h.repo }));
      expect(a).toMatchObject({ ok: true, appended: 2 });
      const b = (await h.store.append([verdict(3)], { ...h.appendCtx, repo: h.repo }));
      expect(b).toMatchObject({ ok: true, appended: 1 });
      const r = (await h.store.read({ ...h.readCtx, repo: h.repo }));
      expect(r.status).toBe('ok');
      expect(r.rows.map((x) => x.pr)).toEqual([1, 2, 3]);
      expect(r.rows[1].type).toBe('ruling');
    }));

    it('read({from}) skips that many leading rows', withStore(async (h) => {
      (await h.store.append([verdict(1), verdict(2), verdict(3)], { ...h.appendCtx, repo: h.repo }));
      const r = (await h.store.read({ ...h.readCtx, repo: h.repo, from: 2 }));
      expect(r.rows.map((x) => x.pr)).toEqual([3]);
    }));

    it('an invalid row refuses the whole call and writes nothing', withStore(async (h) => {
      const bad = { ...ruling(5), ruling: 'maybe' };
      const a = (await h.store.append([verdict(4), bad], { ...h.appendCtx, repo: h.repo }));
      expect(a.ok).toBe(false);
      expect(a.appended).toBe(0);
      expect(typeof a.error).toBe('string');
      expect((await h.store.read({ ...h.readCtx, repo: h.repo })).rows ?? []).toEqual([]);
    }));

    // The row's own repo is its identity: a store never repairs it from `ctx.repo`, and never files a row under a repo
    // it does not carry. Missing, malformed and different repos all refuse the WHOLE call, in either batch position.
    const OTHER = 'web-everything/other-repo';
    const strayRows = () => [
      ['a missing repo', { ...verdict(11), repo: undefined }],
      ['a blank repo', { ...verdict(12), repo: '' }],
      ['a malformed repo', { ...verdict(13), repo: 'not a repo' }],
      ['a different repo', { ...verdict(14), repo: OTHER }],
      ['a different repo on a v2 event', { ...ruling(15), repo: OTHER }],
      ['a different case of the same repo', { ...verdict(16), repo: REPO.toUpperCase() }],
    ];
    for (const [what, stray] of strayRows()) {
      for (const position of ['first', 'last']) {
        it(`${what} (${position} in the batch) refuses the whole call and writes nothing, under either repo`, withStore(async (h) => {
          const rows = position === 'first' ? [stray, verdict(21)] : [verdict(21), stray];
          const a = (await h.store.append(rows, { ...h.appendCtx, repo: h.repo }));
          expect(a.ok).toBe(false);
          expect(a.appended).toBe(0);
          expect(typeof a.error).toBe('string');
          expect((await h.store.read({ ...h.readCtx, repo: h.repo })).rows ?? []).toEqual([]);
          expect((await h.store.read({ ...h.readCtx, repo: OTHER })).rows ?? []).toEqual([]);
        }));
      }
    }

    for (const bad of ['not a repo', '', 7, {}, ['a/b']]) {
      it(`a malformed \`ctx.repo\` (${JSON.stringify(bad)}) is refused, never used as a destination`, withStore(async (h) => {
        const a = (await h.store.append([verdict(22)], { ...h.appendCtx, repo: bad }));
        expect(a.ok).toBe(false);
        expect(a.appended).toBe(0);
        expect((await h.store.read({ ...h.readCtx, repo: h.repo })).rows ?? []).toEqual([]);
      }));
    }

    it('with no `ctx.repo` the rows name the destination, and a mixed-repo batch is still refused whole', withStore(async (h) => {
      const mixed = (await h.store.append([verdict(23), { ...verdict(24), repo: OTHER }], { ...h.appendCtx }));
      expect(mixed).toMatchObject({ ok: false, appended: 0 });
      expect((await h.store.read({ ...h.readCtx, repo: h.repo })).rows ?? []).toEqual([]);
      expect((await h.store.read({ ...h.readCtx, repo: OTHER })).rows ?? []).toEqual([]);
      const one = (await h.store.append([verdict(25), verdict(26)], { ...h.appendCtx }));
      expect(one).toMatchObject({ ok: true, appended: 2 });
      expect((await h.store.read({ ...h.readCtx, repo: h.repo })).rows.map((x) => x.pr)).toEqual([25, 26]);
    }));

    it('a read answers only with rows that carry the asked repo, even when two repo names share a file', withStore(async (h) => {
      // `a/b-c` and `a-b/c` both slug to `a-b-c`: placement must never stand in for identity.
      const rowFor = (repo, pr) => buildVerdictRecord({ repo, pr, verdict: 'accepted', at: AT, source: 'test' });
      (await h.store.append([rowFor('a/b-c', 41)], { ...h.appendCtx, repo: 'a/b-c' }));
      (await h.store.append([rowFor('a-b/c', 42)], { ...h.appendCtx, repo: 'a-b/c' }));
      expect((await h.store.read({ ...h.readCtx, repo: 'a/b-c' })).rows.map((x) => x.pr)).toEqual([41]);
      expect((await h.store.read({ ...h.readCtx, repo: 'a-b/c' })).rows.map((x) => x.pr)).toEqual([42]);
    }));

    for (const [n, size] of [[0, 3], [1, 3], [2, 3], [1, 2]]) {
      it(`a partial append (fails after ${n} of ${size} rows) reports exactly the persisted prefix`, withStore(async (h) => {
        const prs = Array.from({ length: size }, (_, i) => 31 + i);
        h.failMidBatch(n); // the medium fails once `n` rows of the next append are on it (an atomic store persists none)
        let a;
        a = (await h.store.append(prs.map(verdict), { ...h.appendCtx, repo: h.repo }));
        h.healStore();
        expect(a.ok).toBe(false);
        expect(typeof a.error).toBe('string');
        const persisted = (await h.store.read({ ...h.readCtx, repo: h.repo }));
        expect(persisted.status).toBe('ok');
        // The count is what is really on the medium, never a constant, never the requested size unless that is the truth ...
        expect(a.appended).toBe(persisted.rows.length);
        // ... what is there is a prefix of the batch, in order ...
        expect(persisted.rows.map((x) => x.pr)).toEqual(prs.slice(0, a.appended));
        // ... and the store says which kind it is: a row-by-row store keeps the prefix, an atomic one keeps nothing.
        expect(a.appended).toBe(h.atomicBatch ? 0 : n);
      }));
    }

    it('an empty append is refused, not a quiet success', withStore(async (h) => {
      expect((await h.store.append([], { ...h.appendCtx, repo: h.repo })).ok).toBe(false);
    }));

    it('a read that fails is `unreadable`, NEVER an empty ok', withStore(async (h) => {
      (await h.store.append([verdict(1)], { ...h.appendCtx, repo: h.repo }));
      h.breakStore();
      const r = (await h.store.read({ ...h.readCtx, repo: h.repo }));
      expect(r.status).toBe('unreadable');
      expect(r.rows).toBeUndefined();
      expect(typeof r.error).toBe('string');
    }));

    it('an append that fails returns ok:false and never throws', withStore(async (h) => {
      h.breakStore();
      let a;
      a = (await h.store.append([verdict(1)], { ...h.appendCtx, repo: h.repo }));
      expect(a.ok).toBe(false);
      expect(a.appended).toBe(0);
      expect(typeof a.error).toBe('string');
    }));
  });
}
