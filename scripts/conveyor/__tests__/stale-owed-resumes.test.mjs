import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeStoredAwaitVerify, listStoredAwaitVerify } from '../await-verify.mjs';
import { classifyStaleOwed } from '../fixer-slot-rules.mjs';
import { runSlotAwareAwaitPass } from '../await-verify-loop.mjs';
import { runAwaitVerifyPass, isHarnessRecord, defaultAwaitVerifyIo } from '../await-verify-pass.mjs';

const T0 = Date.parse('2026-10-08T19:30:00Z');
const entry = (key, pr, age = 0, extra = {}) => ({ key, record: {
  v: 1, sessionId: key, who: key, repo: 'web-everything/web-everything', pr,
  sha: 'a'.repeat(40), kind: 'fix', requestedAt: new Date(T0 + age).toISOString(),
  lane: `/lanes/${key}`, ref: `lane/${key}`, attempt: 1,
  pendingResume: { kind: 'green' }, ...extra,
} });

function harness(entries, state) {
  const store = new Map(entries.map(e => [e.key, e.record]));
  const resumed = [];
  const io = {
    listRecords: () => [...store].map(([key, record]) => ({ key, record })),
    clearRecord: vi.fn(key => { store.delete(key); }),
    clearStoredRecord: vi.fn(key => { store.delete(key); }),
    writeRecord: r => { store.set(r.sessionId, r); return { ok: true }; },
    listSessions: () => entries.map(({ key }) => ({ sessionId: key, name: key, status: 'idle', kind: 'background' })),
    resume: ({ session }) => { resumed.push(session.sessionId); return { resumed: true }; },
    ...(state ? { prState: state } : {}),
  };
  const pass = (cap = 1, claims = []) => runSlotAwareAwaitPass({ io, runPass: runAwaitVerifyPass,
    allowResume: true, settings: { parkedReleasesSlot: true }, claims,
    nowMs: T0 + 60_000, ttlMs: 3_600_000, cap });
  return { io, store, resumed, pass };
}

describe('stale owed resumes (R618)', () => {
  it.each(['lower-to-upper', 'upper-to-lower'])('retains the same commit across SHA case changes: %s', async mode => {
    const old = entry('case-old', 1, 0, { sha: (mode === 'upper-to-lower' ? 'A' : 'a').repeat(40) });
    const newer = entry('case-new', 1, 1000, { who: old.record.who,
      sha: (mode === 'upper-to-lower' ? 'a' : 'A').repeat(40) });
    expect(classifyStaleOwed({ owed: [old], records: [old, newer] })).toEqual([]);
    const h = harness([old, newer]);
    expect((await h.pass(0)).cleared).toEqual([]);
    expect(h.store.get(old.key)).toEqual(old.record);
  });

  it('stale cleanup uses only the shared-store port and never normal completion cleanup', async () => {
    const old = entry('store-only', 1);
    const h = harness([old], () => ({ open: false }));
    expect((await h.pass(0)).cleared).toEqual([old.key]);
    expect(h.io.clearStoredRecord).toHaveBeenCalledTimes(1);
    expect(h.io.clearStoredRecord).toHaveBeenCalledWith(old.key);
    expect(h.io.clearRecord).not.toHaveBeenCalled();
  });

  it.each([
    ['OPEN', { open: true }], ['MERGED', { open: false }], ['CLOSED', { open: false }],
    ['UNKNOWN', null], ['PENDING', null], ['', null],
  ])('real PR-state port retains unknown evidence and classifies %j explicitly', async (state, expected) => {
    const io = await defaultAwaitVerifyIo({
      exec: vi.fn(() => `${state} https://github.com/web-everything/web-everything/pull/1 false lane/test`),
      env: {}, dispatchIo: {}, stopSessionFn: () => {}, pushRefusalFn: () => null, readClaimFn: () => null,
    });
    expect(io.prState('web-everything/web-everything', 1)).toEqual(expected);
    const old = entry(`state-${state || 'missing'}`, 1);
    const h = harness([old], io.prState);
    expect((await h.pass(0)).cleared).toEqual(expected?.open === false ? [old.key] : []);
    expect(h.store.has(old.key)).toBe(expected?.open !== false);
  });

  it.each(['stored-only', 'same', 'sha-case', 'new-session', 'new-sha', 'missing-identity', 'unreadable'])
  ('real cleanup preserves lane-local waiter ownership: %s', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'stale-owed-'));
    const dir = join(root, 'store');
    const lane = join(root, 'lane');
    const localPath = join(lane, '.git', '.fix-await-verify');
    const old = entry('local-old', 1, 0, { lane });
    const local = { ...old.record };
    if (mode === 'new-session' || mode === 'stored-only') local.sessionId = 'new-session';
    if (mode === 'new-sha') local.sha = 'b'.repeat(40);
    if (mode === 'sha-case') local.sha = local.sha.toUpperCase();
    if (mode === 'missing-identity') delete local.sessionId;
    const contents = mode === 'unreadable' ? '{' : JSON.stringify(local);
    mkdirSync(join(lane, '.git'), { recursive: true });
    writeFileSync(localPath, contents);
    vi.stubEnv('WE_AWAIT_VERIFY_STORE', dir);
    try {
      expect(writeStoredAwaitVerify(old.record, { dir }).ok).toBe(true);
      const io = await defaultAwaitVerifyIo({ poolRoot: root, dispatchIo: {}, stopSessionFn: () => {},
        pushRefusalFn: () => null, readClaimFn: () => null });
      if (mode === 'stored-only') {
        // Exercise the loop with the real store ports, leaving the lane's newer waiter alone.
        const result = await runSlotAwareAwaitPass({ io: { ...io, prState: () => ({ open: false }) },
          runPass: async () => ({ rows: [] }), allowResume: true, settings: { parkedReleasesSlot: true },
          claims: [], nowMs: T0 + 60_000, ttlMs: 3_600_000, cap: 0 });
        expect(result.cleared).toEqual([old.key]);
      } else expect(io.clearRecord(old.key, old.record)).toEqual({ cleared: true });
      expect(listStoredAwaitVerify({ dir })).toEqual([]);
      if (mode === 'same' || mode === 'sha-case') {
        expect(() => readFileSync(localPath)).toThrow(/ENOENT/);
      } else expect(readFileSync(localPath, 'utf8')).toBe(contents);
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['MERGED', 'CLOSED'])('%s records are cleared without occupying admission slots', async () => {
    const old = entry('closed', 6360);
    const h = harness([old, entry('live', 6193, 1000)], (_repo, pr) => ({ open: pr !== 6360 }));
    const out = await h.pass();
    expect(h.io.clearStoredRecord).toHaveBeenCalledWith(old.key);
    expect(out.cleared).toEqual(['closed']);
    expect(out.admitted).toEqual(['live']);
    expect(h.resumed).toEqual(['live']);
  });

  it('clears a superseded SHA even without a PR-state port', async () => {
    const h = harness([entry('superseded', 6360), entry('newer', 6360, 1000, { who: 'superseded', sha: 'b'.repeat(40) })]);
    const out = await h.pass();
    expect(out.cleared).toEqual(['superseded']);
    expect(h.resumed).toEqual(['newer']);
  });

  it('keeps every claim counted conservatively after retiring its stale waiter', async () => {
    const h = harness([entry('claimed-stale', 6360), entry('claimed-live', 6193, 1000)], (_repo, pr) => ({ open: pr !== 6360 }));
    const claims = [{ meta: { repo: 'we', pr: 6360, kind: 'fix', sessionId: 'claimed-stale' } }];
    expect((await h.pass(1, claims)).admitted).toEqual([]);
    expect(h.resumed).toEqual([]);
  });

  it('retains an open PR with a moved head and no newer record', async () => {
    const h = harness([entry('moved', 6360)], () => ({ open: true, sha: 'b'.repeat(40) }));
    const out = await h.pass(0);
    expect(out.cleared).toEqual([]);
    expect(h.store.has('moved')).toBe(true);
    expect(h.io.clearStoredRecord).not.toHaveBeenCalled();
    expect(h.io.clearRecord).not.toHaveBeenCalled();
  });

  it('retains unknown PR state and reports the real admission counts', async () => {
    const h = harness([entry('old', 1), entry('young', 2, 1000)], () => null);
    const out = await h.pass();
    expect(out.cleared).toEqual([]);
    expect(h.store.has('young')).toBe(true);
    expect(out.rows.find(r => r.key === 'young').result).toBe('resume-deferred (fix slot full: 1 owed ahead, 1 admitted, 0 working, cap 1)');
  });

  it('admits and wakes live records oldest-first even when the store is reversed', async () => {
    const h = harness([entry('youngest', 3, 2000), entry('oldest', 1), entry('middle', 2, 1000)]);
    const out = await h.pass(2);
    expect(out.admitted).toEqual(['oldest', 'middle']);
    expect(h.resumed).toEqual(['oldest', 'middle']);
  });

  it('keeps a busy owed claim oldest-first after repeated misses so later passes cannot exceed the cap', async () => {
    const h = harness([entry('stuck-r618', 1), entry('ready-r618', 2, 1000)]);
    h.io.listSessions = () => [
      { sessionId: 'stuck-r618', name: 'stuck-r618', status: 'working', kind: 'background' },
      { sessionId: 'ready-r618', name: 'ready-r618', status: 'idle', kind: 'background' },
    ];
    const claims = [{ meta: { repo: 'we', pr: 1, kind: 'fix', sessionId: 'stuck-r618' } }];
    for (let i = 1; i <= 4; i++) {
      const out = await h.pass(1, claims);
      expect(out.admitted).toEqual(['stuck-r618']);
      expect(out.deferred).toEqual(['ready-r618']);
      expect.soft(out.rows.find(r => r.key === 'stuck-r618').result)
        .toBe(`session-busy${i >= 3 ? `; missed ${i}x` : ''}`);
      expect(out.rows.find(r => r.key === 'ready-r618').result).not.toContain('missed');
      expect(h.resumed).toEqual([]);
    }
    // Deferral is not a miss; a successful wake resets consecutive misses.
    expect((await h.pass(0, claims)).admitted).toEqual([]);
    expect((await h.pass(1, claims)).rows.find(r => r.key === 'stuck-r618').result).toBe('session-busy; missed 5x');
    h.io.listSessions = () => [{ sessionId: 'stuck-r618', name: 'stuck-r618', status: 'idle', kind: 'background' }];
    const success = await h.pass(1, claims);
    expect(success.rows.find(r => r.key === 'stuck-r618').result).not.toContain('missed');
    expect(h.resumed).toEqual(['stuck-r618']);
    h.store.set('stuck-r618', entry('stuck-r618', 1).record);
    h.io.listSessions = () => [];
    expect((await h.pass(1, claims)).rows.find(r => r.key === 'stuck-r618').result).not.toContain('missed');
  });

  it.each([
    ['version', { v: 2 }], ['SHA', { sha: 'invalid' }],
    ['relative lane', { lane: 'relative/lane' }], ['missing lane', { lane: undefined }],
    ['unsafe ref', { ref: 'lane/../main' }], ['missing ref', { ref: undefined }],
    ['timestamp', { requestedAt: 'invalid' }],
  ])('a newer record with malformed %s never retires a valid pending waiter', async (_field, malformed) => {
    const key = _field.replaceAll(' ', '-');
    const old = entry(`valid-${key}`, 1);
    const newer = entry(`malformed-${key}`, 1, 1000, {
      who: old.record.who, sha: 'b'.repeat(40), pendingResume: undefined, ...malformed,
    });
    expect(isHarnessRecord(old.record)).toBe(true);
    expect(isHarnessRecord(newer.record)).toBe(false);
    expect(classifyStaleOwed({ owed: [old], records: [old, newer] })).toEqual([]);
    const h = harness([old, newer]);
    const out = await h.pass(0);
    expect(out.cleared).toEqual([]);
    expect(h.store.get(old.key)).toEqual(old.record);
    expect(h.io.clearStoredRecord).not.toHaveBeenCalled();
    expect(h.io.clearRecord).not.toHaveBeenCalled();
  });

  it.each(['missing', 'throws', 'refuses'])('cleanup %s never blocks live admission', async mode => {
    const h = harness([entry('stale-error', 1), entry('live-error', 2, 1000)], (_repo, pr) => ({ open: pr !== 1 }));
    if (mode === 'missing') delete h.io.clearStoredRecord;
    else h.io.clearStoredRecord = () => { if (mode === 'throws') throw Error('unreadable'); return { cleared: false }; };
    // Keep the live record pending so this test isolates stale cleanup from normal wake cleanup.
    h.io.listSessions = () => [];
    const out = await h.pass();
    expect(out.admitted).toEqual(['live-error']);
    expect(out.cleared).toEqual([]);
  });

  it('a failed PR-state read retains the owed record', async () => {
    const h = harness([entry('unknown-error', 1)], () => { throw Error('offline'); });
    expect((await h.pass(0)).cleared).toEqual([]);
    expect(h.store.has('unknown-error')).toBe(true);
  });

  it('pure classification requires a later time, different SHA, and the same repo and PR', () => {
    const owed = [entry('original', 1), entry('equal-time', 1, 0, { sha: 'b'.repeat(40) }),
      entry('same-sha', 1, 1000, { who: 'equal-time' }), entry('other-pr', 2, 2000, { sha: 'c'.repeat(40) }),
      entry('other-repo', 1, 2000, { repo: 'other/repo', sha: 'c'.repeat(40) })];
    expect(classifyStaleOwed({ owed, prFacts: new Map() })).toEqual(['equal-time']);
  });

  it.each(['who', 'sessionId', 'lane'])('supersedes only with a matching %s lineage', field => {
    const old = entry('lineage-old', 1);
    const newer = entry('lineage-new', 1, 1000, { sha: 'b'.repeat(40) });
    expect(classifyStaleOwed({ owed: [old], records: [old, newer] })).toEqual([]);
    newer.record[field] = old.record[field];
    expect(classifyStaleOwed({ owed: [old], records: [old, newer] })).toEqual([old.key]);
  });

  it('missing lineage and a different kind cannot supersede a waiter', () => {
    const old = entry('kind-old', 1, 0, { who: undefined, sessionId: undefined, lane: undefined });
    const newer = entry('kind-new', 1, 1000, { ...old.record, requestedAt: new Date(T0 + 1000).toISOString(), sha: 'b'.repeat(40) });
    expect(classifyStaleOwed({ owed: [old], records: [old, newer] })).toEqual([]);
    old.record.who = newer.record.who = 'shared-worker';
    newer.record.kind = 'ci-heal';
    expect(classifyStaleOwed({ owed: [old], records: [old, newer] })).toEqual([]);
  });

  it.each([null, { open: true }, { open: false }])('retains previousCi inventory unless PR closure is confirmed: %j', state => {
    const old = entry('inventory-old', 1, 0, { pendingResume: { kind: 'red', delivered: true },
      previousCi: { ready: { ciFailures: [{ name: 'unit', conclusion: 'FAILURE' }] } } });
    const newer = entry('inventory-new', 1, 1000, { who: old.record.who, sha: 'b'.repeat(40) });
    expect(classifyStaleOwed({ owed: [old], records: [old, newer], prFacts: new Map([[old.key, state]]) }))
      .toEqual(state?.open === false ? [old.key] : []);
  });

  it.each(['expired', 'future', 'invalid'])('a stale waiter with an %s time cannot hide an active claim', async mode => {
    const requestedAt = mode === 'expired' ? new Date(T0 - 7_200_000).toISOString()
      : mode === 'future' ? new Date(T0 + 7_200_000).toISOString() : 'unknown';
    const old = entry(`active-${mode}`, 1, 0, { requestedAt });
    const h = harness([old, entry(`waiting-${mode}`, 2)], (_repo, pr) => ({ open: pr !== 1 }));
    const out = await h.pass(1, [{ meta: { repo: 'we', pr: 1, kind: 'fix', sessionId: old.record.sessionId } }]);
    expect(out.cleared).toEqual([old.key]);
    expect(out.admitted).toEqual([]);
    expect(h.resumed).toEqual([]);
  });

  it.each(['sha', 'requestedAt', 'pendingResume', 'pendingResume-kind', 'pendingResume-detail', 'previousCi', 'missing', 'unreadable'])('fresh cleanup read retains a concurrent change to %s', async field => {
    const old = entry(`concurrent-${field}`, 1);
    const h = harness([old], () => ({ open: false }));
    const replacement = { ...old.record };
    if (field === 'sha') replacement.sha = 'b'.repeat(40);
    if (field === 'requestedAt') replacement.requestedAt = new Date(T0 + 1000).toISOString();
    if (field === 'pendingResume') delete replacement.pendingResume;
    if (field === 'pendingResume-kind') replacement.pendingResume = { kind: 'red' };
    if (field === 'pendingResume-detail') replacement.pendingResume = { ...old.record.pendingResume, detail: 'new repair work' };
    if (field === 'previousCi') replacement.previousCi = { ready: { ciFailures: [{ name: 'unit', conclusion: 'FAILURE' }] } };
    const list = h.io.listRecords;
    h.io.prState = () => {
      h.store.set(old.key, replacement);
      if (field === 'missing') h.store.delete(old.key);
      if (field === 'unreadable') h.io.listRecords = vi.fn().mockImplementationOnce(() => { throw Error('unreadable'); }).mockImplementation(list);
      return { open: false };
    };
    expect((await h.pass(0)).cleared).toEqual([]);
    expect(h.io.clearStoredRecord).not.toHaveBeenCalled();
    expect(h.io.clearRecord).not.toHaveBeenCalled();
    expect(h.store.get(old.key)).toBe(field === 'missing' ? undefined : replacement);
  });

  it('cleanup preserves an in-place change to nested previousCi inventory', async () => {
    const old = entry('concurrent-nested-inventory', 1, 0, {
      previousCi: { ready: { ciFailures: [] } },
    });
    const h = harness([old], () => {
      old.record.previousCi.ready.ciFailures.push({ name: 'unit', conclusion: 'FAILURE' });
      return { open: false };
    });
    expect((await h.pass(0)).cleared).toEqual([]);
    expect(h.io.clearStoredRecord).not.toHaveBeenCalled();
    expect(h.io.clearRecord).not.toHaveBeenCalled();
    expect(h.store.get(old.key).previousCi.ready.ciFailures).toHaveLength(1);
  });
});
