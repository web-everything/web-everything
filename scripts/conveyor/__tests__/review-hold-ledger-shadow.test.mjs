import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildLedgerEvent, EVENT_TYPES } from '../../lib/verdict-ledger.mjs';
import { derivePrState } from '../../lib/pr-state.mjs';
import { runReconcilePass, enrichPrsWithLedgerHolds } from '../reconcile-pass.mjs';
import {
  resolveReadSource, resolveReadSources, compareHolds, applyLedgerHolds, ledgerHoldStep, ledgerSnapshot,
  journalChanges, resetLedgerSnapshots, renderLedgerShadowSummary, readStoreName, defaultJournalWriter, ledgerDeciding,
} from '../review-hold-ledger-shadow.mjs';

const repo = 'web-everything/web-everything';
const head = 'a'.repeat(40);
const newHead = 'b'.repeat(40);
const at = Date.parse('2026-10-08T12:00:00Z');
const iso = n => new Date(n).toISOString();
const dirs = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), 'ledger-shadow-')); dirs.push(d); return d; };
beforeEach(() => resetLedgerSnapshots());
afterEach(() => { vi.unstubAllEnvs(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const ev = (type, fields, n = 0) => buildLedgerEvent({ type, repo, pr: 3988, at: iso(at - 60_000 + n), source: 'test', ...fields });
const run = (sha = head, n = 0) => ev(EVENT_TYPES.REVIEW_RUN, { headSha: sha, phase: 'completed', posted: false }, n);
const rawKey = '["judge","scripts/a.mjs",1,"broken"]';
const hashed = `sha256:${createHash('sha256').update(rawKey).digest('hex')}`;
const referral = (sha = head) => ev(EVENT_TYPES.REFERRAL, { headSha: sha, findingKeys: [hashed] }, 1);
const ruling = (findingKey, r = 'not-real') => ev(EVENT_TYPES.RULING, { findingKey, ruling: r }, 2);
const pr = (o = {}) => ({ number: 3988, headRefOid: head, headRefName: 'lane/x', body: '', createdAt: iso(at - 3_600_000),
  labels: [{ name: 'review:human' }], comments: [], mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }], referralHold: null, blockRuledReferrals: [], ...o });
const env = (o = {}) => ({ ...o });
const sources = o => resolveReadSources(env(o));
const noRuling = () => false;

describe('verdictLedger.readSource.<family>', () => {
  it('defaults every family to both (shadow) and reads the per-family env before the global one', () => {
    expect(resolveReadSource('sameHeadHold', {})).toBe('both');
    expect(resolveReadSource('sameHeadHold', { WE_VERDICT_LEDGER_READ_SOURCE: 'labels' })).toBe('labels');
    expect(resolveReadSource('sameHeadHold', { WE_VERDICT_LEDGER_READ_SOURCE: 'labels', WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' })).toBe('ledger');
    expect(resolveReadSource('referralHold', { WE_VERDICT_LEDGER_READ_SOURCE_REFERRAL_HOLD: 'bogus' })).toBe('both');
  });
  it('a family the ledger cannot decide yet acts as both when set to ledger', () => {
    const s = sources({ WE_VERDICT_LEDGER_READ_SOURCE: 'ledger' });
    expect(s.sameHeadHold.effective).toBe('ledger');
    expect(s.referralHold.effective).toBe('ledger');
    expect(s.blockRuled).toEqual({ configured: 'ledger', effective: 'both' });
    expect(s.rulingNeeded).toEqual({ configured: 'ledger', effective: 'both' });
  });
  it('reads the shared git store when the ledger writes dual', () => {
    expect(readStoreName({ WE_VERDICT_LEDGER_STORE: 'dual' })).toBe('git');
    expect(readStoreName({ WE_VERDICT_LEDGER_STORE: 'home' })).toBe('home');
    expect(readStoreName({ WE_VERDICT_LEDGER_READ_STORE: 'home', WE_VERDICT_LEDGER_STORE: 'dual' })).toBe('home');
  });
});

describe('compareHolds (shadow)', () => {
  it('agrees when both sources hold the same head', () => {
    const p = pr({ referralHold: { kind: 'same-head', head, why: 'x' } });
    const rows = compareHolds([p], [run()], { repo, sources: sources({}), now: at, needRuling: noRuling });
    expect(rows.find(r => r.family === 'sameHeadHold')).toMatchObject({ old: true, ledger: true, agree: true, cause: null });
  });
  it('#3988: a review-run row on an unchanged head that the local run store does not show is a named disagreement', () => {
    const rows = compareHolds([pr()], [run()], { repo, sources: sources({}), now: at, needRuling: noRuling });
    expect(rows.find(r => r.family === 'sameHeadHold')).toMatchObject({ old: false, ledger: true, agree: false, cause: 'old-released-or-retried' });
  });
  it('a ruling row with the raw finding key never closes the hashed referral: cause ruling-key-unhashed', () => {
    const rows = compareHolds([pr()], [referral(), ruling(rawKey)], { repo, sources: sources({}), now: at, needRuling: noRuling });
    expect(rows.find(r => r.family === 'referralHold')).toMatchObject({ old: false, ledger: true, cause: 'ruling-key-unhashed' });
  });
  it('a ruling with the hashed key closes it, so the sources agree', () => {
    const rows = compareHolds([pr()], [referral(), ruling(hashed)], { repo, sources: sources({}), now: at, needRuling: noRuling });
    expect(rows.find(r => r.family === 'referralHold')).toMatchObject({ old: false, ledger: false, agree: true });
  });
  it('a referral on an older head does not pause the new head (a push owes a fresh review)', () => {
    const rows = compareHolds([pr({ headRefOid: newHead })], [referral(head)], { repo, sources: sources({}), now: at, needRuling: noRuling });
    expect(rows.find(r => r.family === 'referralHold')).toMatchObject({ ledger: false, agree: true });
  });
  it('no rows for the PR, and an unreadable ledger, are causes, never a ledger clear', () => {
    const p = pr({ referralHold: { kind: 'referral', head, why: 'x' } });
    expect(compareHolds([p], [], { repo, sources: sources({}), now: at, needRuling: noRuling })
      .find(r => r.family === 'referralHold')).toMatchObject({ old: true, ledger: false, cause: 'no-ledger-rows' });
    expect(compareHolds([p], null, { repo, sources: sources({}), now: at, needRuling: noRuling })
      .find(r => r.family === 'referralHold')).toMatchObject({ ledger: null, agree: null, cause: 'ledger-unreadable' });
  });
  it('an invalid row is an unreadable ledger (the derive holds), never trusted', () => {
    const bad = { ...run(), type: 'Review-Run' };
    expect(compareHolds([pr()], [bad], { repo, sources: sources({}), now: at, needRuling: noRuling })[0]).toMatchObject({ agree: null, cause: 'ledger-unreadable' });
  });
  it('labels mode reads nothing and compares nothing', () => {
    expect(compareHolds([pr()], [run()], { repo, sources: sources({ WE_VERDICT_LEDGER_READ_SOURCE: 'labels' }), now: at })).toEqual([]);
  });
});

describe('applyLedgerHolds', () => {
  it('both mode never changes a decision', () => {
    const prs = [pr(), pr({ number: 1, referralHold: { kind: 'referral', head, why: 'old' } })];
    expect(applyLedgerHolds(prs, [run()], { repo, sources: sources({}), now: at })).toBe(prs);
  });
  it('ledger mode (sameHeadHold): a second review on an unchanged head is refused with the reason recorded', () => {
    const [out] = applyLedgerHolds([pr()], [run()], { repo, sources: sources({ WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' }), now: at });
    expect(out.referralHold).toMatchObject({ kind: 'same-head', head, count: 1, source: 'ledger' });
    expect(out.referralHold.why).toMatch(/already reviewed 1 time\(s\) \(ledger: 1 completed review run\(s\) on aaaaaaaa \(cap 1\)\)/);
  });
  it('ledger mode releases a same-head pause the ledger saw end (runs under the cap), and leaves a new head free', () => {
    const s = sources({ WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' });
    const [a] = applyLedgerHolds([pr({ referralHold: { kind: 'same-head', head, why: 'old' } })], [run()], { repo, sources: s, now: at, sameHeadMaxReviews: 2 });
    expect(a.referralHold).toBeNull();
    const [b] = applyLedgerHolds([pr({ headRefOid: newHead })], [run(head)], { repo, sources: s, now: at });
    expect(b.referralHold).toBeNull();
  });
  it('ledger mode (referralHold): an open referral on this head pauses; a referral pause wins over same-head', () => {
    const s = sources({ WE_VERDICT_LEDGER_READ_SOURCE: 'ledger' });
    const [out] = applyLedgerHolds([pr()], [run(), referral()], { repo, sources: s, now: at });
    expect(out.referralHold).toMatchObject({ kind: 'referral', count: 1, source: 'ledger' });
  });
  it('ledger mode fails closed: unreadable, pending or invalid rows hold the review', () => {
    const s = sources({ WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' });
    for (const [events, unreadable] of [[null, 'ledger-unreadable:transport-read-failed'], [[], 'ledger-read-pending'], [[{ ...run(), type: 'bogus' }], null]]) {
      const [out] = applyLedgerHolds([pr()], events, { repo, sources: s, now: at, unreadable });
      expect(out.referralHold).toMatchObject({ kind: 'same-head', count: 0 });
      expect(out.referralHold.why).toMatch(/cannot answer/);
    }
  });
});

describe('#3771 / #3988 replay through the shared planner', () => {
  const reconcile = (p, stepEnv, captured) => runReconcilePass({ repo, now: at + 1, readPrs: () => [p], readAgents: () => [], enrich: x => x,
    enrichMainRed: prs => ({ prs }), enrichAlreadyLanded: x => x, enrichBaseRef: x => x,
    enrichSystemFix: x => x, enrichFixClaims: x => x, enrichTimeouts: x => x,
    resolveMainSha: () => null, readRequiredChecks: () => ({ checks: ['test'] }),
    enrichLedgerHolds: (prs, o) => enrichPrsWithLedgerHolds(prs, { ...o, env: stepEnv, log: l => captured.logs.push(l),
      step: (ps, oo) => ledgerHoldStep(ps, { ...oo, env: stepEnv, snapshot: () => ({ status: 'ok', rows: [run()], at }),
        journal: rows => captured.journal.push(...rows), needRuling: noRuling }) }),
  });
  it('both (default): the daemon still dispatches exactly as today, and the disagreement is journaled once', () => {
    vi.stubEnv('OPERATION_RUNS_DIR', temp());
    const captured = { logs: [], journal: [] };
    for (let tick = 0; tick < 2; tick++) {
      const plan = reconcile(pr(), {}, captured);
      expect(plan.dispatch).toContainEqual(expect.objectContaining({ kind: 'review', prNumber: 3988 }));
    }
    expect(captured.journal.filter(r => r.family === 'sameHeadHold')).toEqual([
      expect.objectContaining({ pr: 3988, old: false, ledger: true, agree: false, cause: 'old-released-or-retried', mode: 'both' })]);
    expect(captured.logs[0]).toMatch(/^ledger-shadow web-everything\/web-everything: store ok; \d+ agree, 1 disagree/);
  });
  it('ledger: the second review on an unchanged head is refused, with the reason recorded', () => {
    vi.stubEnv('OPERATION_RUNS_DIR', temp());
    const captured = { logs: [], journal: [] };
    const plan = reconcile(pr(), { WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' }, captured);
    expect(plan.dispatch.filter(d => d.kind === 'review')).toEqual([]);
    const refusal = plan.refusals.find(r => r.kind === 'review-referrals-pending' && r.prNumber === 3988);
    expect(refusal.why).toMatch(/already reviewed 1 time\(s\)/);
    expect(refusal.referralHold).toMatchObject({ kind: 'same-head', source: 'ledger' });
  });
  it('a step that throws leaves today\'s decision untouched and says so', () => {
    const logs = [];
    const prs = [pr()];
    expect(enrichPrsWithLedgerHolds(prs, { repo, env: {}, log: l => logs.push(l), step: () => { throw new Error('boom'); } })).toBe(prs);
    expect(logs[0]).toMatch(/step failed \(decisions unchanged\): boom/);
  });
  it('the default step is off under a test run (it reads a real store)', () => {
    const prs = [pr()];
    expect(enrichPrsWithLedgerHolds(prs, { repo })).toBe(prs);
  });
});

describe('IO: snapshot and journal', () => {
  it('a synchronous store answers at once and is cached for the TTL', () => {
    let reads = 0;
    const read = () => { reads++; return { sync: { status: 'ok', rows: [run()] } }; };
    expect(ledgerSnapshot(repo, { now: at, read })).toMatchObject({ status: 'ok' });
    ledgerSnapshot(repo, { now: at + 1000, read });
    expect(reads).toBe(1);
    ledgerSnapshot(repo, { now: at + 61_000, read });
    expect(reads).toBe(2);
  });
  it('an async store is read behind: pending first, then the completed read', async () => {
    const read = () => ({ promise: Promise.resolve({ status: 'ok', rows: [run()] }) });
    expect(ledgerSnapshot(repo, { now: at, read })).toMatchObject({ status: 'pending' });
    await new Promise(r => setTimeout(r, 0));
    expect(ledgerSnapshot(repo, { now: Date.now(), read })).toMatchObject({ status: 'ok' });
  });
  it('a failed read is unreadable, never empty', async () => {
    expect(ledgerSnapshot('x/y', { now: at, read: () => ({ sync: { status: 'unreadable', reason: 'transport-read-failed' } }) }))
      .toEqual({ status: 'unreadable', reason: 'transport-read-failed' });
    resetLedgerSnapshots();
    ledgerSnapshot('x/y', { now: at, read: () => ({ promise: Promise.reject(new Error('net down')) }) });
    await new Promise(r => setTimeout(r, 0));
    expect(ledgerSnapshot('x/y', { now: Date.now(), read: () => ({ promise: new Promise(() => {}) }) })).toMatchObject({ status: 'unreadable', reason: 'read-rejected: net down' });
  });
  it('journals a PR + family only when its signature changes', () => {
    const row = { pr: 1, head, family: 'sameHeadHold', mode: 'both', old: false, ledger: true, agree: false, cause: 'c', detail: {} };
    expect(journalChanges([row], { repo, at: 't', proc: 'p' })).toHaveLength(1);
    expect(journalChanges([row], { repo, at: 't', proc: 'p' })).toHaveLength(0);
    expect(journalChanges([{ ...row, head: newHead }], { repo, at: 't', proc: 'p' })).toHaveLength(1);
  });
  it('the journal writer appends JSONL where WE_LEDGER_SHADOW_JOURNAL points', () => {
    const path = join(temp(), 'j', 'review-holds.jsonl');
    defaultJournalWriter({ WE_LEDGER_SHADOW_JOURNAL: path, VITEST: 'true' })([{ a: 1 }, { b: 2 }]);
    expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });
  it('the summary line names counts, causes and modes', () => {
    const { summary } = ledgerHoldStep([pr()], { repo, env: {}, now: at, snapshot: () => ({ status: 'ok', rows: [run()], at }), journal: () => {}, needRuling: noRuling });
    expect(renderLedgerShadowSummary(summary)).toMatch(/causes: sameHeadHold:old-released-or-retried=1; modes referralHold=both sameHeadHold=both blockRuled=both rulingNeeded=both$/);
    expect(ledgerHoldStep([pr()], { repo, env: { WE_VERDICT_LEDGER_READ_SOURCE: 'labels' } }).summary).toBeNull();
  });
});


describe('review fixes (PR 4495): ledger mode never fails open', () => {
  const sameLedger = { WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' };
  const refLedger = { WE_VERDICT_LEDGER_READ_SOURCE_REFERRAL_HOLD: 'ledger' };
  const oldSame = { kind: 'same-head', head, why: 'old' };
  const oldRef = { kind: 'referral', head, why: 'old' };

  it('a step that throws holds a ledger-mode review; a thrown derive holds and says why; default mode stays unchanged', () => {
    const logs = [];
    const prs = [null, pr()];
    const out = enrichPrsWithLedgerHolds(prs, { repo, env: sameLedger, log: l => logs.push(l), step: () => { throw new Error('boom'); } });
    expect(out[0]).toBeNull();
    expect(out[1].referralHold).toMatchObject({ kind: 'same-head', cause: 'derive-crashed', source: 'ledger' });
    expect(logs[0]).toMatch(/step failed \(ledger families held\): boom/);
    const same = [pr()];
    expect(enrichPrsWithLedgerHolds(same, { repo, env: {}, log: () => {}, step: () => { throw new Error('boom'); } })).toBe(same);
  });
  it('a thrown derive holds ledger-mode reviews and preserves shadow decisions', () => {
    const derive = () => { throw new Error('derive exploded'); };
    const { prs: out, summary } = ledgerHoldStep([pr()], { repo, env: sameLedger, now: at, derive, needRuling: noRuling,
      snapshot: () => ({ status: 'ok', rows: [run()], at }), journal: () => {} });
    expect(out[0].referralHold).toMatchObject({ kind: 'same-head', cause: 'derive-crashed' });
    expect(out[0].referralHold.why).toMatch(/cannot answer/);
    expect(summary.error).toMatch(/derive exploded/);
    const { prs: shadow } = ledgerHoldStep([pr()], { repo, env: {}, now: at, derive, needRuling: noRuling,
      snapshot: () => ({ status: 'ok', rows: [run()], at }), journal: () => {} });
    expect(shadow[0].referralHold).toBeNull();
  });

  it('ledger mode: no rows for the PR never releases the hold today\'s reader keeps (and never invents one)', () => {
    const s = sources(sameLedger);
    expect(applyLedgerHolds([pr({ referralHold: oldSame })], [], { repo, sources: s, now: at })[0].referralHold).toBe(oldSame);
    expect(applyLedgerHolds([pr({ referralHold: oldSame })], [{ ...run(), pr: 1 }], { repo, sources: s, now: at })[0].referralHold).toBe(oldSame);
    expect(applyLedgerHolds([pr()], [], { repo, sources: s, now: at })[0].referralHold).toBeNull();
    const r = sources(refLedger);
    expect(applyLedgerHolds([pr({ referralHold: oldRef })], [], { repo, sources: r, now: at })[0].referralHold).toBe(oldRef);
  });
  it('ledger mode: rows with no run (or no referral) on THIS head are missing evidence, not a release', () => {
    expect(applyLedgerHolds([pr({ referralHold: oldSame })], [run(newHead)], { repo, sources: sources(sameLedger), now: at })[0].referralHold).toBe(oldSame);
    expect(applyLedgerHolds([pr({ referralHold: oldRef })], [run()], { repo, sources: sources(refLedger), now: at,
      sameHeadToday: () => null })[0].referralHold).toBe(oldRef);
  });
  it('ledger mode releases a pause only on ledger evidence (runs under the cap; a closed referral)', () => {
    const [a] = applyLedgerHolds([pr({ referralHold: oldSame })], [run()], { repo, sources: sources(sameLedger), now: at, sameHeadMaxReviews: 2 });
    expect(a.referralHold).toBeNull();
    const [b] = applyLedgerHolds([pr({ referralHold: oldRef })], [referral(), ruling(hashed)], { repo, sources: sources(refLedger), now: at, sameHeadToday: () => null });
    expect(b.referralHold).toBeNull();
  });

  it('releasing a ledger referral preserves the default same-head cap', () => {
    const today = { kind: 'same-head', head, count: 1, why: 'review paused: already reviewed' };
    const [held] = applyLedgerHolds([pr({ referralHold: oldRef })], [run(), referral(), ruling(hashed)],
      { repo, sources: sources(refLedger), now: at, sameHeadToday: () => today });
    expect(held.referralHold).toBe(today);
    const [noGuard] = applyLedgerHolds([pr({ referralHold: oldRef })], [run(), referral(), ruling(hashed)], { repo, sources: sources(refLedger), now: at });
    expect(noGuard.referralHold).toBe(oldRef); // the guard cannot be asked: the pause stays
    const [free] = applyLedgerHolds([pr({ referralHold: oldRef })], [run(), referral(), ruling(hashed)],
      { repo, sources: sources(refLedger), now: at, sameHeadToday: () => null });
    expect(free.referralHold).toBeNull();
  });
  it('the step asks today\'s run store for the guard when a ledger referral release leaves sameHeadHold in both', () => {
    const readRuns = () => [{ repo, pr: 3988, head, startedAt: at - 120_000, completedAt: at - 60_000, persistenceFailed: false, rulings: [] }];
    const opts = { repo, env: refLedger, now: at, needRuling: noRuling, readRuns, snapshot: () => ({ status: 'ok', rows: [run(), referral(), ruling(hashed)], at }), journal: () => {} };
    const { prs: out } = ledgerHoldStep([pr({ referralHold: oldRef })], opts);
    expect(out[0].referralHold).toMatchObject({ kind: 'same-head', head });
  });

  it('empty PR history is journaled as no-ledger-rows and kept out of the agreement counts', () => {
    const rows = compareHolds([pr()], [], { repo, sources: sources({}), now: at, needRuling: noRuling });
    expect(rows.find(r => r.family === 'sameHeadHold')).toMatchObject({ old: false, ledger: false, agree: null, cause: 'no-ledger-rows' });
    expect(rows.find(r => r.family === 'referralHold')).toMatchObject({ agree: null, cause: 'no-ledger-rows' });
    const { summary } = ledgerHoldStep([pr()], { repo, env: {}, now: at, snapshot: () => ({ status: 'ok', rows: [], at }), journal: () => {}, needRuling: noRuling });
    expect(summary).toMatchObject({ agree: 0, disagree: 0 });
    expect(summary.causes['sameHeadHold:no-ledger-rows']).toBe(1);
  });

  it('ledger mode reads fresh: a run row written after the last tick is seen on the next one', () => {
    const rowsNow = [run(newHead)];
    let reads = 0;
    const read = () => { reads++; return { sync: { status: 'ok', rows: [...rowsNow] } }; };
    const opts = { repo, env: sameLedger, needRuling: noRuling, journal: () => {}, snapshot: (r, o) => ledgerSnapshot(r, { ...o, read }) };
    expect(ledgerHoldStep([pr()], { ...opts, now: at }).prs[0].referralHold).toBeNull();
    rowsNow.push(run(head, 5)); // the review that tick N dispatched has completed
    expect(ledgerHoldStep([pr()], { ...opts, now: at + 1000 }).prs[0].referralHold).toMatchObject({ kind: 'same-head', count: 1 });
    expect(reads).toBe(2);
    const both = { ...opts, env: {} };
    ledgerHoldStep([pr()], { ...both, now: at + 2000 });
    expect(reads).toBe(2); // the shadow keeps the cached read
  });
  it('a fresh read from an async store is read-behind, so it cannot decide', async () => {
    const read = () => ({ promise: Promise.resolve({ status: 'ok', rows: [run()] }) });
    expect(ledgerSnapshot(repo, { now: at, read, fresh: true })).toEqual({ status: 'unreadable', reason: 'async-store-read-behind' });
    await new Promise(r => setTimeout(r, 0));
    expect(ledgerSnapshot(repo, { now: Date.now(), read, fresh: true })).toEqual({ status: 'unreadable', reason: 'async-store-read-behind' });
    expect(ledgerSnapshot(repo, { now: Date.now(), read })).toMatchObject({ status: 'ok' }); // the shadow still reads behind
  });
});

describe('review fixes (PR 4495), self-review variants', () => {
  const sameLedger = { WE_VERDICT_LEDGER_READ_SOURCE_SAME_HEAD_HOLD: 'ledger' };
  const refLedger = { WE_VERDICT_LEDGER_READ_SOURCE_REFERRAL_HOLD: 'ledger' };
  it('a release needs the ledger to have seen at least as many rows as the pause counts', () => {
    const oldSame = { kind: 'same-head', head, count: 2, why: 'old' };
    const [a] = applyLedgerHolds([pr({ referralHold: oldSame })], [run()], { repo, sources: sources(sameLedger), now: at, sameHeadMaxReviews: 2 });
    expect(a.referralHold).toBe(oldSame); // today counts 2 runs, the ledger saw 1
    const [b] = applyLedgerHolds([pr({ referralHold: { ...oldSame, count: 1 } })], [run()], { repo, sources: sources(sameLedger), now: at, sameHeadMaxReviews: 2 });
    expect(b.referralHold).toBeNull();
    const oldRef = { kind: 'referral', head, count: 3, why: 'old' };
    const [c] = applyLedgerHolds([pr({ referralHold: oldRef })], [referral(), ruling(hashed)], { repo, sources: sources(refLedger), now: at, sameHeadToday: () => null });
    expect(c.referralHold).toBe(oldRef); // 3 pending referrals today, 1 in the ledger
  });
  it('one PR that crashes the derive holds that PR only', () => {
    const derive = (events, facts, ...rest) => { if (facts.pr === 7) throw new Error('bad pr'); return derivePrState(events, facts, ...rest); };
    const out = applyLedgerHolds([pr({ number: 7 }), pr()], [run(newHead)], { repo, sources: sources(sameLedger), now: at, derive });
    expect(out[0].referralHold).toMatchObject({ kind: 'same-head', cause: 'derive-crashed' });
    expect(out[1].referralHold).toBeNull();
  });
  it('a stray VITEST in the environment never switches a deciding ledger family off', () => {
    const logs = [];
    const out = enrichPrsWithLedgerHolds([pr()], { repo, env: { ...sameLedger, VITEST: 'true' }, log: l => logs.push(l) });
    expect(out).toHaveLength(1);
    expect(logs[0]).toMatch(/^ledger-shadow web-everything\/web-everything: store /); // the default step ran under VITEST
    expect(ledgerDeciding({})).toBe(false);
    expect(ledgerDeciding(sameLedger)).toBe(true);
    const same = [pr()];
    expect(enrichPrsWithLedgerHolds(same, { repo, env: { VITEST: 'true' } })).toBe(same);
  });
});
