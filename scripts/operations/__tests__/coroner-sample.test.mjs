import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendRankingRow, halve, initialState, main, minutesLost, pickWorst, rankFrictions, readRankingRows, redactRecord, replay, resolveKnobs, runSample, sessionInput, step, validateSample } from '../coroner-sample.mjs';

const knobs = resolveKnobs({ values: {}, env: {} });
const good = () => ({ outcome: 'done', summary: 'Lane was leased, so the worker waited.', blocker: { kind: 'tooling-defect', component: 'lane-pool acquire', evidence: { text: 'lane-already-leased twice', refs: ['scripts/lane-pool.mjs'] }, proposedFix: { summary: 'Retry another lane.', scope: ['we:scripts/lane-pool.mjs'], size: 3 }, retryable: true } });
const rec = (session, lostMin, extra = {}) => ({ session, kind: 'build', executor: 'claude', friction: 1, reruns: 0, retriesAfterError: 0, gaps: { verifyWait: lostMin * 60000 }, examples: [], ...extra });

describe('stability rule (state machine)', () => {
  const A = ['a', 'b', 'c', 'd', 'e'], B = ['b', 'a', 'c', 'd', 'e'];
  it('defaults to a large N', () => { expect(knobs.sampleSize).toBeGreaterThanOrEqual(25); expect(knobs.sampleSize).toBeLessThanOrEqual(30); expect(initialState(knobs).n).toBe(knobs.sampleSize); });
  it('keeps the large N for two unchanged runs and halves on the third', () => {
    let s = step(initialState(knobs), A, knobs); expect(s.n).toBe(knobs.sampleSize);
    s = step(s, A, knobs); expect(s.n).toBe(knobs.sampleSize);
    s = step(s, A, knobs); expect(s.n).toBe(Math.floor(knobs.sampleSize / 2));
  });
  it('needs three more unchanged runs at the new N before halving again, and stops at the floor', () => {
    let s = initialState(knobs); for (let i = 0; i < 3; i++) s = step(s, A, knobs);
    const half = s.n; s = step(s, A, knobs); s = step(s, A, knobs); expect(s.n).toBe(half);
    s = step(s, A, knobs); expect(s.n).toBe(halve(half, 5));
    for (let i = 0; i < 40; i++) s = step(s, A, knobs);
    expect(s.n).toBe(5);
  });
  it('goes back to the large N when the ranking changes', () => {
    let s = initialState(knobs); for (let i = 0; i < 3; i++) s = step(s, A, knobs);
    expect(s.n).toBeLessThan(knobs.sampleSize);
    s = step(s, B, knobs); expect(s.n).toBe(knobs.sampleSize); expect(s.streak).toBe(1);
  });
  it('replays from persisted rows and skips rows with no ranking', () => {
    const rows = [{ top: A }, { top: [] }, { top: A }, { top: A }];
    expect(replay(rows, knobs).n).toBe(Math.floor(knobs.sampleSize / 2));
    expect(replay([], knobs).n).toBe(knobs.sampleSize);
  });
  it('honours the knobs', () => {
    const k = resolveKnobs({ values: { 'sample-size': '10', 'stable-runs': '2' }, env: {} });
    let s = initialState(k); s = step(s, A, k); s = step(s, A, k); expect(s.n).toBe(5);
    expect(resolveKnobs({ values: {}, env: { WE_CORONER_SAMPLE_SIZE: '3' } }).sampleSize).toBe(5);
  });
});

describe('record schema validation', () => {
  it('accepts a good record', () => expect(validateSample(good())).toEqual({ ok: true, errors: [] }));
  it('accepts null proposedFix', () => { const v = good(); v.blocker.proposedFix = null; expect(validateSample(v).ok).toBe(true); });
  it.each([
    ['unknown outcome', (v) => { v.outcome = 'fine'; }],
    ['unknown kind', (v) => { v.blocker.kind = 'bad-vibes'; }],
    ['null blocker', (v) => { v.blocker = null; }],
    ['extra key', (v) => { v.extra = 1; }],
    ['extra blocker key', (v) => { v.blocker.extra = 1; }],
    ['missing evidence', (v) => { delete v.blocker.evidence; }],
    ['long summary', (v) => { v.summary = 'x'.repeat(281); }],
    ['bad size', (v) => { v.blocker.proposedFix.size = 4; }],
    ['non-boolean retryable', (v) => { v.blocker.retryable = 'yes'; }],
    ['refs not strings', (v) => { v.blocker.evidence.refs = [1]; }],
  ])('rejects %s', (_n, mutate) => { const v = good(); mutate(v); expect(validateSample(v).ok).toBe(false); });
  it('rejects non-objects without throwing', () => { for (const v of [null, 'x', 3, [], undefined]) expect(validateSample(v).ok).toBe(false); });
  it('redacts token-like strings in a kept record', () => {
    const v = good(); v.summary = 'used ghp_abcdefghijklmnopqrstuvwxyz0123 here';
    expect(JSON.stringify(redactRecord(v))).not.toContain('ghp_abcdef');
  });
});

describe('picking and ranking', () => {
  it('picks the worst by minutes lost and ignores sessions with no friction signal', () => {
    const rs = [rec('a', 5), rec('b', 30), rec('c', 99, { friction: 0 }), rec('d', 12)];
    expect(pickWorst(rs, 2).map((p) => p.rec.session)).toEqual(['b', 'd']);
    expect(minutesLost(rs[2])).toBe(0);
  });
  it('ranks kinds by deterministic minutes lost', () => {
    const mk = (kind, session, lost) => ({ rec: { session, kind: 'build', executor: 'claude' }, lost, record: { ...good(), blocker: { ...good().blocker, kind } } });
    const top = rankFrictions([mk('gate-red', 's1', 3), mk('tooling-defect', 's2', 20), mk('gate-red', 's3', 4)]);
    expect(top.map((t) => [t.kind, t.minutesLost, t.sessions])).toEqual([['tooling-defect', 20, 1], ['gate-red', 7, 2]]);
  });
  it('bounds and redacts the model input', () => {
    const text = sessionInput(rec('s', 3, { outcomeLine: 'key sk-abcdefghijklmnopqrstuvwxyz1234 ' + 'y'.repeat(20000) }));
    expect(text.length).toBeLessThanOrEqual(6000); expect(text).not.toContain('sk-abcdef');
  });
});

describe('runSample', () => {
  it('drops invalid and failed answers with counts and sums cost', async () => {
    const records = [rec('a', 30), rec('b', 20), rec('c', 10)];
    const answers = { a: good(), b: { ...good(), outcome: 'weird' } };
    const out = await runSample({ records, n: 3, knobs, summarise: async (r) => { if (r.session === 'c') throw new Error('timeout'); return { value: answers[r.session], costUsd: 0.01 }; } });
    expect(out).toMatchObject({ sampled: 3, valid: 1, dropped: { invalid: 1, failed: 1, total: 2 } });
    expect(out.cost.usd).toBe(0.02);
    expect(out.top[0].kind).toBe('tooling-defect');
  });
});

describe('persistence and end to end', () => {
  let dir; beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'coroner-sample-')); }); afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  it('round-trips rows, skipping torn and foreign lines', () => {
    const f = join(dir, 'r.jsonl');
    appendRankingRow(f, { v: 1, top: ['a'] }); fs.appendFileSync(f, '{torn\n{"v":2,"top":["x"]}\n'); appendRankingRow(f, { v: 1, top: ['b'] });
    expect(readRankingRows(f).map((r) => r.top)).toEqual([['a'], ['b']]);
    expect(readRankingRows(join(dir, 'missing'))).toEqual([]);
  });
  it('a run with an empty window persists nothing and keeps the large N', async () => {
    const env = { WE_CORONER_SAMPLE_STORE: join(dir, 'r.jsonl'), WE_CORONER_JOBS: join(dir, 'j'), WE_CORONER_JOBS_ARCHIVE: join(dir, 'ja'), WE_CORONER_PROJECTS: join(dir, 'p'), WE_CORONER_NO_EXECUTORS: '1', WE_CORONER_DAEMON_DIR: join(dir, 'd'), WE_CORONER_VERIFY_LOG: join(dir, 'v'), WE_CORONER_ADMISSION: join(dir, 'a'), WE_CORONER_COORD: join(dir, 'c'), WE_CORONER_LANES: join(dir, 'l') };
    const out = await main(['--hours=1'], { env, home: dir, summarise: async () => { throw new Error('unused'); } });
    expect(out.sampled).toBe(0); expect(out.stability.after.n).toBe(knobs.sampleSize); expect(fs.existsSync(env.WE_CORONER_SAMPLE_STORE)).toBe(false);
  });
});
