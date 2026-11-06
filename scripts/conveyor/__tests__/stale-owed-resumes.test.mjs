import { describe, it, expect, vi } from 'vitest';
import { classifyStaleOwed } from '../fixer-slot-rules.mjs';
import { runSlotAwareAwaitPass } from '../await-verify-loop.mjs';
import { runAwaitVerifyPass } from '../await-verify-pass.mjs';

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
  it.each(['MERGED', 'CLOSED'])('%s records are cleared without occupying admission slots', async () => {
    const old = entry('closed', 6360);
    const h = harness([old, entry('live', 6193, 1000)], (_repo, pr) => ({ open: pr !== 6360 }));
    const out = await h.pass();
    expect(h.io.clearRecord).toHaveBeenCalledWith(old.key, old.record);
    expect(out.cleared).toEqual(['closed']);
    expect(out.admitted).toEqual(['live']);
    expect(h.resumed).toEqual(['live']);
  });

  it('clears a superseded SHA even without a PR-state port', async () => {
    const h = harness([entry('superseded', 6360), entry('newer', 6360, 1000, { sha: 'b'.repeat(40) })]);
    const out = await h.pass();
    expect(out.cleared).toEqual(['superseded']);
    expect(h.resumed).toEqual(['newer']);
  });

  it('a cleared stale waiter does not turn its claim into a working slot', async () => {
    const h = harness([entry('claimed-stale', 6360), entry('claimed-live', 6193, 1000)], (_repo, pr) => ({ open: pr !== 6360 }));
    const claims = [{ meta: { repo: 'we', pr: 6360, kind: 'fix', sessionId: 'claimed-stale' } }];
    expect((await h.pass(1, claims)).admitted).toEqual(['claimed-live']);
  });

  it('retains an open PR with a moved head and no newer record', async () => {
    const h = harness([entry('moved', 6360)], () => ({ open: true, sha: 'b'.repeat(40) }));
    const out = await h.pass(0);
    expect(out.cleared).toEqual([]);
    expect(h.store.has('moved')).toBe(true);
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

  it('moves an admitted record still pending after three misses behind live work', async () => {
    const h = harness([entry('stuck-r618', 1), entry('ready-r618', 2, 1000)]);
    h.io.listSessions = () => [
      { sessionId: 'stuck-r618', name: 'stuck-r618', status: 'working', kind: 'background' },
      { sessionId: 'ready-r618', name: 'ready-r618', status: 'idle', kind: 'background' },
    ];
    for (let i = 0; i < 3; i++) expect((await h.pass()).admitted).toEqual(['stuck-r618']);
    expect((await h.pass()).admitted).toEqual(['ready-r618']);
    expect(h.resumed).toEqual(['ready-r618']);
  });

  it.each(['missing', 'throws', 'refuses'])('cleanup %s never blocks live admission', async mode => {
    const h = harness([entry('stale-error', 1), entry('live-error', 2, 1000)], (_repo, pr) => ({ open: pr !== 1 }));
    if (mode === 'missing') delete h.io.clearRecord;
    else h.io.clearRecord = () => { if (mode === 'throws') throw Error('unreadable'); return { cleared: false }; };
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
      entry('same-sha', 1, 1000), entry('other-pr', 2, 2000, { sha: 'c'.repeat(40) }),
      entry('other-repo', 1, 2000, { repo: 'other/repo', sha: 'c'.repeat(40) })];
    expect(classifyStaleOwed({ owed, prFacts: new Map() })).toEqual(['equal-time']);
  });
});
