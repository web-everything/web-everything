/**
 * Slice 3 of the #5492 rebuild: the BINDING SHADOW. `pr-state` computes the head-binding fold's answer beside today's,
 * the drain's ledger shadow journals every place they disagree plus the count of legacy approvals (no `seen`), and
 * NOTHING decides on it: today's derive result, the drain shadow's own summary and its readiness inputs are unchanged.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Count (and on demand crash) every fold the shadow runs, wrapping the REAL fold.
const fold = vi.hoisted(() => ({ calls: 0, crash: false, inner: false, busyMs: 0 }));
vi.mock('../ledger-binding.mjs', async () => {
  const real = await vi.importActual('../ledger-binding.mjs');
  return { ...real, ledgerAt: (rows, head, opts) => {
    fold.calls += 1;
    if (fold.crash) throw new Error('boom');
    // The real fold's own contained crash: poison a row so its canonical hash throws INSIDE `ledgerAt`.
    if (fold.inner) { const loop = {}; loop.self = loop; return real.ledgerAt([...rows, { type: 'author', author: 'x', loop }], head, opts); }
    const until = Date.now() + fold.busyMs; while (Date.now() < until) { /* simulate a slow fold */ }
    return real.ledgerAt(rows, head, opts);
  } };
});
beforeEach(() => { Object.assign(fold, { calls: 0, crash: false, inner: false, busyMs: 0 }); });
import { buildVerdictRecord, buildLedgerEvent, parseLedgerEvents, serializeLedgerEvent, EVENT_TYPES, VERDICTS } from '../verdict-ledger.mjs';
import { derivePrState, bindingShadow, BINDING_SHADOW_MAX_BYTES } from '../pr-state.mjs';
import { measureReadiness } from '../ledger-promotion-readiness.mjs';
import { shadowRow, summarizeShadow, summarizeBinding, bindingCompare, buildShadowRunRecord, formatShadowLine, runLedgerShadow, MAX_ROWS } from '../drain-ledger-shadow.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40);
const AT = '2026-10-21T12:00:00.000Z', NOW = '2026-10-21T13:00:00.000Z';
const base = { repo: 'o/n', pr: 7, source: 'test' };
let n = 0;
const stamp = (r) => ({ ...r, id: `row-${String(++n).padStart(5, '0')}` });
const rt = (rows) => parseLedgerEvents(rows.map((r) => serializeLedgerEvent(r).line).join('\n'));
const V = (verdict, head, extra = {}) => stamp(buildVerdictRecord({ ...base, at: AT, verdict, headSha: head, ...extra }));
const E = (type, extra) => stamp(buildLedgerEvent({ ...base, at: AT, type, ...extra }));
const facts = (head) => ({ pr: 7, repo: 'o/n', head: { sha: head }, now: NOW, state: 'OPEN', requiredChecks: [], sessions: [], handoffs: [], refusals: [] });
const ON = { bindingShadow: true };

describe('pr-state carries the binding answer beside today\'s, decided by nothing', () => {
  it('agrees on a plain accepted head', () => {
    const r = derivePrState(rt([V(VERDICTS.ACCEPTED, A)]), facts(A), ON);
    expect(r.clears).toBe(true);
    expect(r.binding).toMatchObject({ clears: true, base: 'review', legacyApprovals: 0 });
  });
  it('disagrees where the rule tightens: a legacy approval (no seen) no longer answers a human hold', () => {
    const rows = rt([V(VERDICTS.HUMAN, A), V(VERDICTS.CLEAR_HUMAN, A), E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]);
    const r = derivePrState(rows, facts(A), ON);
    expect(r.binding.clears).toBe(false);
    expect(r.binding.legacyApprovals).toBe(1);
    expect(r.clears).toBe(true); // today's answer is unchanged by the shadow
  });
  it('OPT-IN: without the setting NO fold runs and the result has no binding key; with it, everything else is equal', () => {
    const rows = rt([V(VERDICTS.CHANGES, A), V(VERDICTS.ACCEPTED, B), E(EVENT_TYPES.SEND_BACK, { cause: 'changes' })]);
    for (const head of [A, B]) {
      const off = derivePrState(rows, facts(head));
      expect(fold.calls).toBe(0);
      expect('binding' in off).toBe(false);
      const { binding, ...on } = derivePrState(rows, facts(head), ON);
      expect(fold.calls).toBe(1);
      expect(binding).toBeTruthy();
      expect(on).toEqual(off);
      fold.calls = 0;
    }
  });
  it('a fold that throws INSIDE a derive is contained: the derive is otherwise identical and the fold is reported skipped', () => {
    const rows = rt([V(VERDICTS.ACCEPTED, A)]);
    const off = derivePrState(rows, facts(A));
    fold.crash = true;
    const { binding, ...on } = derivePrState(rows, facts(A), ON);
    expect(on).toEqual(off);
    expect(binding).toMatchObject({ skipped: 'crashed', legacyApprovals: 0 });
    fold.crash = false; fold.inner = true;
    const inner = derivePrState(rows, facts(A), ON);
    expect(fold.calls).toBe(2);
    expect(inner.binding).toMatchObject({ skipped: 'crashed' });
    const row = shadowRow({ verdict: { num: 7, headSha: A, decision: 'merge' }, repo: 'o/n', events: rows, now: NOW });
    expect(row.binding).toMatchObject({ status: 'skipped', skipped: 'crashed' });
  });
  it('the shadow reads facts only AFTER today\'s answer: a clock that throws on its next read cannot change that answer', () => {
    const rows = rt([V(VERDICTS.ACCEPTED, A)]);
    const withClock = (limit) => {
      const f = { ...facts(A) }; let reads = 0;
      Object.defineProperty(f, 'now', { configurable: true, enumerable: true, get() { reads += 1; if (reads > limit) throw new Error('clock gone'); return NOW; } });
      return { f, reads: () => reads };
    };
    const probe = withClock(Infinity);
    derivePrState(rows, probe.f);
    const todayReads = probe.reads();
    expect(todayReads).toBeGreaterThan(0);
    const off = derivePrState(rows, withClock(todayReads).f);
    const { binding, ...on } = derivePrState(rows, withClock(todayReads).f, ON);
    expect(off.clears).toBe(true);
    expect(on).toEqual(off);
    expect(binding).toBeUndefined(); // the shadow's own read failed: no answer, today's untouched
  });
  it('default mode reads the head and clock exactly as before; opt-in adds one read of each', () => {
    const counted = () => {
      const c = { head: 0, now: 0 };
      const f = { ...facts(A) };
      Object.defineProperty(f, 'now', { get() { c.now += 1; return NOW; }, enumerable: true });
      const h = { sha: A };
      Object.defineProperty(f, 'head', { get() { c.head += 1; return h; }, enumerable: true });
      return { f, c };
    };
    const a = counted(); derivePrState(rt([V(VERDICTS.ACCEPTED, A)]), a.f);
    const b = counted(); derivePrState(rt([V(VERDICTS.ACCEPTED, A)]), b.f, ON);
    expect(b.c).toEqual({ head: a.c.head + 1, now: a.c.now + 1 });
  });
  it('is bounded by BYTES: huge keys or huge reasons are skipped without folding (the scan stops at the cap), legacy count exact', () => {
    const keys = Array.from({ length: 20_000 }, (_, i) => `sha256:${String(i).padStart(64, '0')}`);
    const big = rt([V(VERDICTS.ACCEPTED, A), E(EVENT_TYPES.REFERRAL, { headSha: A, findingKeys: keys }), E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]);
    const huge = Array.from({ length: 50 }, () => ({ ...V(VERDICTS.ACCEPTED, A), reason: 'x'.repeat(BINDING_SHADOW_MAX_BYTES) }));
    expect(bindingShadow(huge, A, NOW)).toEqual({ skipped: 'too-large', legacyApprovals: 0 });
    // UTF-8 bytes, not UTF-16 units: 600,000 two-byte characters are 1.2 MB.
    expect(bindingShadow([{ ...V(VERDICTS.ACCEPTED, A), reason: '\u00e9'.repeat(600_000) }], A, NOW)).toMatchObject({ skipped: 'too-large' });
    const t = Date.now();
    expect(bindingShadow(big, A, NOW)).toEqual({ skipped: 'too-large', legacyApprovals: 1 });
    expect(fold.calls).toBe(0);
    expect(Date.now() - t).toBeLessThan(1000);
  });
  it('an unreadable or out-of-scope derive carries no binding answer', () => {
    expect(derivePrState(null, facts(A), ON).binding).toBeUndefined();
    expect(bindingShadow(null, A, NOW)).toMatchObject({ skipped: 'crashed' });
    expect(derivePrState([], { ...facts(A), repo: undefined }, ON).binding).toBeUndefined();
  });
});

describe('the drain shadow journals binding disagreements and legacy approvals', () => {
  const verdict = (head, decision = 'merge') => ({ num: 7, headSha: head, decision, reason: 'x' });
  it('a row carries both answers, the direction and the holds behind the new one', () => {
    const rows = rt([V(VERDICTS.HUMAN, A), V(VERDICTS.CLEAR_HUMAN, A), E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]);
    const row = shadowRow({ verdict: verdict(A), repo: 'o/n', events: rows, now: NOW });
    expect(row.binding).toMatchObject({ status: 'disagree', direction: 'binding-holds-old-clears', oldClears: true, clears: false, legacyApprovals: 1 });
    expect(row.binding.holds).toContain('verdict:human');
  });
  it('a skipped fold is unscored: neither agreement nor disagreement, and its legacy approvals still count', () => {
    const keys = Array.from({ length: 20_000 }, (_, i) => `sha256:${String(i).padStart(64, '0')}`);
    const big = rt([V(VERDICTS.ACCEPTED, A), E(EVENT_TYPES.REFERRAL, { headSha: A, findingKeys: keys }), E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]);
    const row = shadowRow({ verdict: verdict(A), repo: 'o/n', events: big, now: NOW });
    expect(row.binding).toEqual({ status: 'skipped', skipped: 'too-large', legacyApprovals: 1 });
    expect(summarizeBinding([row])).toMatchObject({ compared: 0, agree: 0, disagree: 0, skipped: 1, legacyApprovals: 1 });
  });
  it('the pass budget: once spent, later PRs are journaled skipped (not folded), with their legacy count', async () => {
    const rows = rt([V(VERDICTS.ACCEPTED, A), E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]);
    const res = await runLedgerShadow({ verdicts: [{ ...verdict(A), repo: 'o/n' }], dryRun: true, bindingBudgetMs: -1,
      readEvents: async () => ({ status: 'ok', rows, store: { name: 'git' } }), readiness: () => ({ ok: true, measure: {} }) });
    expect(fold.calls).toBe(0);
    expect(res.rows[0].binding).toEqual({ status: 'skipped', skipped: 'pass-budget', legacyApprovals: 1 });
  });
  it('a non-numeric budget falls back to the default instead of failing the pass', async () => {
    const res = await runLedgerShadow({ verdicts: [{ ...verdict(A), repo: 'o/n' }], dryRun: true, bindingBudgetMs: Symbol('x'),
      readEvents: async () => ({ status: 'ok', rows: rt([V(VERDICTS.ACCEPTED, A)]), store: { name: 'git' } }), readiness: () => ({ ok: true, measure: {} }) });
    expect(res.ok).toBe(true);
    expect(res.rows[0].binding.status).toBe('agree');
  });
  it('the budget clock starts at the first fold, not before a slow store read (live drain: every pass skipped)', async () => {
    const rows = rt([V(VERDICTS.ACCEPTED, A)]);
    const slowRead = () => new Promise((done) => { setTimeout(() => done({ status: 'ok', rows, store: { name: 'git' } }), 80); });
    const res = await runLedgerShadow({ verdicts: [{ ...verdict(A), repo: 'o/n' }], dryRun: true, bindingBudgetMs: 30,
      readEvents: slowRead, readiness: () => ({ ok: true, measure: {} }) });
    expect(fold.calls).toBe(1);
    expect(res.rows[0].binding.status).toBe('agree');
  });
  it('the pass budget is shared: a slow first fold spends it and the next PR is skipped, not folded', async () => {
    const rows = rt([V(VERDICTS.ACCEPTED, A), { ...V(VERDICTS.ACCEPTED, A), pr: 8 }]);
    fold.busyMs = 40;
    const res = await runLedgerShadow({ verdicts: [{ ...verdict(A), repo: 'o/n' }, { ...verdict(A), num: 8, repo: 'o/n' }], dryRun: true, bindingBudgetMs: 20,
      readEvents: async () => ({ status: 'ok', rows, store: { name: 'git' } }), readiness: () => ({ ok: true, measure: {} }) });
    expect(fold.calls).toBe(1);
    expect(res.rows.map((r) => r.binding.status)).toEqual(['agree', 'skipped']);
  });
  it('contains malformed input: a throwing settings getter or a hostile row never changes today\'s answer or throws', () => {
    const rows = rt([V(VERDICTS.ACCEPTED, A)]);
    const settings = {}; Object.defineProperty(settings, 'bindingShadow', { get() { throw new Error('no'); } });
    const { binding, ...r } = derivePrState(rows, facts(A), settings);
    expect(binding).toBeUndefined();
    expect(r).toEqual(derivePrState(rows, facts(A)));
    const hostile = [...rows, { type: 'approval', pr: 7, repo: { toString: 0 } }];
    expect(() => shadowRow({ verdict: verdict(A), repo: 'o/n', events: hostile, now: NOW })).not.toThrow();
  });
  it('skips (does not fold) a PR with more carried rows than the cap', () => {
    const T = 'd'.repeat(40);
    const many = Array.from({ length: 9 }, () => ({ type: 'verdict', pr: 7, repo: 'o/n', verdict: 'carried', coverage: { headSha: B }, fromHead: A,
      source: 'merge-ai-prs', proof: { v: 1, rule: 'tree-identical', fromHead: A, toHead: B, fromTree: T, toTree: T } }));
    expect(bindingShadow(many, B, NOW)).toMatchObject({ skipped: 'too-large' });
    expect(fold.calls).toBe(0);
  });
  it('a derive with no binding answer (held outright) is skipped, and its legacy approvals still count', () => {
    const rows = [...rt([E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]), { type: 'verdict', pr: 7, repo: 'o/n', verdict: 'nonsense' }];
    const row = shadowRow({ verdict: verdict(A), repo: 'o/n', events: rows, now: NOW });
    expect(row.binding).toEqual({ status: 'skipped', skipped: 'no-binding-answer', legacyApprovals: 1 });
  });
  it('an unreadable ledger has no binding comparison (never "agree")', () => {
    expect(shadowRow({ verdict: verdict(A), repo: 'o/n', events: null, now: NOW }).binding).toBe(null);
    expect(bindingCompare(null)).toBe(null);
  });
  it('rolls up counts, directions, hold codes and legacy approvals; the label-vs-ledger summary is untouched', () => {
    const agree = shadowRow({ verdict: verdict(A), repo: 'o/n', events: rt([V(VERDICTS.ACCEPTED, A)]), now: NOW });
    const dis = shadowRow({ verdict: verdict(A), repo: 'o/n', now: NOW,
      events: rt([V(VERDICTS.HUMAN, A), V(VERDICTS.CLEAR_HUMAN, A), E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]) });
    const s = summarizeBinding([agree, dis]);
    expect(s).toMatchObject({ compared: 2, agree: 1, disagree: 1, legacyApprovals: 1 });
    expect(s.directions['binding-holds-old-clears']).toBe(1);
    expect(s.holdCodes['verdict:human']).toBe(1);
    const strip = (r) => { const { binding: _b, ...rest } = r; return rest; };
    expect(summarizeShadow([agree, dis])).toEqual(summarizeShadow([agree, dis].map(strip)));
  });
  it('the run record keeps EVERY binding disagreement even past the row bound, and the old fields as they were', () => {
    const dis = shadowRow({ verdict: verdict(A), repo: 'o/n', now: NOW,
      events: rt([V(VERDICTS.HUMAN, A), V(VERDICTS.CLEAR_HUMAN, A), E(EVENT_TYPES.APPROVAL, { approval: 'clear-human' })]) });
    const rows = Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ ...dis, pr: i + 1 }));
    const rec = buildShadowRunRecord({ id: 'drain-ledger-shadow-x', at: NOW, repos: ['o/n'], rows, summary: summarizeShadow(rows) });
    expect(rec.findings.binding.summary.disagree).toBe(MAX_ROWS + 5);
    expect(rec.findings.binding.disagreements).toHaveLength(MAX_ROWS + 5);
    expect(rec.findings.summary).toEqual(summarizeShadow(rows));
    const strip = ({ binding: _x, ...r }) => r;
    const plainRec = buildShadowRunRecord({ id: 'drain-ledger-shadow-x', at: NOW, repos: ['o/n'], rows: rows.map(strip), summary: summarizeShadow(rows.map(strip)) });
    expect(rec.verdict).toBe(plainRec.verdict);
    expect(rec.findings.rows.map(strip)).toEqual(plainRec.findings.rows);
    // The promotion readiness that reads these records computes the same with and without EVERY binding field.
    const { binding: _b, ...withoutBinding } = rec.findings;
    const bare = { ...rec, findings: { ...withoutBinding, rows: withoutBinding.rows.map(({ binding: _x, ...r }) => r) } };
    expect(measureReadiness([rec], { now: new Date(NOW) })).toEqual(measureReadiness([bare], { now: new Date(NOW) }));
  });
  it('prints a binding line beside the existing one', () => {
    const row = shadowRow({ verdict: verdict(A), repo: 'o/n', events: rt([V(VERDICTS.ACCEPTED, A)]), now: NOW });
    const line = formatShadowLine({ ok: true, summary: summarizeShadow([row]), rows: [row], written: false });
    expect(line).toMatch(/^merge-ai-prs · ledger shadow: compared 1/);
    expect(line).toMatch(/ · binding shadow: agree 1 · disagree 0 · skipped 0 · legacy approvals 0$/);
  });
});
