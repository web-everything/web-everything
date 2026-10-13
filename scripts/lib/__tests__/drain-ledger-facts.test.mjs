import { describe, it, expect } from 'vitest';
import { drainReviewGateFact, planDrainLedgerFacts, recordDrainLedgerFacts } from '../drain-ledger-facts.mjs';
import { decideReviewGate } from '../review-escalation.mjs';
import { appendVerdict, buildLedgerEvent, buildVerdictRecord } from '../verdict-ledger.mjs';
import { recordDrainHold } from '../../merge-ai-prs.mjs';
const repo = 'o/r', head = 'a'.repeat(40), old = 'b'.repeat(40), now = '2026-10-13T12:00:00.000Z';
const base = { repo, pr: 1, at: now, source: 'test', declaredActor: 'test' };
const event = (type, extra) => buildLedgerEvent({ ...base, type, ...extra });
const verdict = (v, sha = old) => buildVerdictRecord({ ...base, verdict: v, headSha: sha, reason: 'test' });
const v = { repo, num: 1, listedHeadSha: head, decision: 'merge', reviewGate: { reviewExempt: true } };
const plan = (events = [], overrides = {}) => planDrainLedgerFacts({ verdicts: [{ ...v, ...overrides }], repo, events, now });
describe('drain ledger facts', () => {
  it('recognizes only the real no-review branch', () => {
    expect(drainReviewGateFact(decideReviewGate({ escalate: false, labels: [] })).reviewExempt).toBe(true);
    for (const labels of [['review:accepted'], ['review:changes'], ['review:human'], ['review:pending']]) {
      expect(drainReviewGateFact(decideReviewGate({ escalate: false, labels })).reviewExempt).toBe(false);
    }
    expect(drainReviewGateFact(decideReviewGate({ escalate: true, labels: [] })).reviewExempt).toBe(false);
    expect(drainReviewGateFact({ action: 'merge', reason: 'review:accepted — reviewer accepted, merge' }).acceptedMerge).toBe(true);
    expect(drainReviewGateFact(null)).toEqual({ reviewExempt: false, acceptedMerge: false });
  });
  it('writes exemption once per head and never over a bearing verdict', () => {
    const rows = plan();
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ type: 'review-exempt', headSha: head });
    expect(plan(rows)).toEqual([]);
    expect(plan(rows, { listedHeadSha: old })).toHaveLength(1);
    for (const kind of ['pending', 'changes', 'human', 'accepted']) expect(plan([verdict(kind)])).toEqual([]);
  });
  it('restamps only a clearing acceptance on a different head', () => {
    const gate = { reviewGate: { acceptedMerge: true } };
    expect(plan([verdict('accepted')], gate)[0]).toMatchObject({ verdict: 'restamped', coverage: { headSha: head } });
    expect(plan([verdict('accepted', head)], gate)).toEqual([]);
    expect(plan([verdict('accepted', null)], gate)).toHaveLength(1);
    for (const kind of ['pending', 'changes', 'human']) expect(plan([verdict(kind)], gate)).toEqual([]);
    expect(plan([], gate)).toEqual([]);
  });
  it('releases only open drain holds, only on merge', () => {
    const hold = (reasonCode, holdSource = 'drain') => event('hold', { reasonCode, holdSource });
    const events = [hold('review'), hold('ci'), event('release', { reasonCode: 'ci', holdSource: 'drain' }), hold('other', 'operator')];
    expect(plan(events, { reviewGate: {} })).toMatchObject([{ type: 'release', reasonCode: 'review', holdSource: 'drain' }]);
    expect(plan(events, { decision: 'skip', reviewGate: {} })).toEqual([]);
  });
  it('rejects foreign repos and invalid heads or PR numbers', () => {
    for (const overrides of [{ repo: 'other/r' }, { num: 'x' }, { num: 0 }, { listedHeadSha: 'abc' }]) expect(plan([], overrides)).toEqual([]);
  });
  it('fails softly on unreadable reads and continues after append failures', () => {
    const writes = [];
    const bad = recordDrainLedgerFacts({ verdicts: [v], read: () => { throw new Error('denied'); }, append: r => writes.push(r) });
    expect(bad.ok).toBe(false); expect(bad.errors.join()).toContain('denied'); expect(writes).toEqual([]);
    const holds = [event('hold', { reasonCode: 'review', holdSource: 'drain' })];
    const result = recordDrainLedgerFacts({ verdicts: [v], now: () => now, read: () => holds, append: r => { writes.push(r); if (r.type === 'review-exempt') throw new Error('append failed'); return { ok: true }; } });
    expect(result).toMatchObject({ ok: false, appended: { exempt: 0, restamped: 0, released: 1 } });
    expect(writes).toHaveLength(2);
    expect(() => recordDrainLedgerFacts(null)).not.toThrow();
    expect(recordDrainLedgerFacts({ verdicts: [v], read: () => null }).ok).toBe(false);
  });
  it('treats a missing file as empty and malformed records as unreadable', () => {
    const writes = [], append = row => { writes.push(row); return { ok: true }; };
    expect(recordDrainLedgerFacts({ verdicts: [v], now: () => now, append,
      read: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } })).toMatchObject({ ok: true, appended: { exempt: 1 } });
    writes.length = 0;
    expect(recordDrainLedgerFacts({ verdicts: [v], append, read: () => [{ repo, pr: 1, type: 'unknown' }] }).ok).toBe(false);
    expect(writes).toEqual([]);
  });
  it('allows non-bearing observations and scopes grouped repos without changing decisions', () => {
    expect(plan([verdict('observed')])).toHaveLength(1);
    const verdicts = [v, { ...v, repo: 'O/R', num: 2 }, { ...v, repo: null, num: 3 }];
    const before = JSON.stringify(verdicts), reads = [], writes = [];
    const result = recordDrainLedgerFacts({ verdicts, localSlug: repo, now: () => now,
      read: r => { reads.push(r); return []; }, append: row => { writes.push(row); return { ok: true }; } });
    expect(result).toMatchObject({ ok: true, appended: { exempt: 3, restamped: 0, released: 0 } });
    expect(reads).toEqual([repo]); expect(writes.map(r => r.pr)).toEqual([1, 2, 3]);
    expect(JSON.stringify(verdicts)).toBe(before);
  });
  it('an exemption uses git-first F4 ordering and never spills on a git miss', () => {
    const calls = [];
    const result = appendVerdict(plan()[0], { store: 'dual', board: '/board', warn: () => {},
      gitAppend: () => { calls.push('git'); throw new Error('push refused'); },
      homeAppend: () => { calls.push('home'); return { ok: true }; } });
    expect(result).toMatchObject({ ok: false, ledgerWriteMiss: true });
    expect(calls).toEqual(['git']);
  });
  it('dedupes a live drain hold but records it again after release', () => {
    const hold = event('hold', { reasonCode: 'review', holdSource: 'drain' });
    const writes = [], append = row => { writes.push(row); return { ok: true }; };
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: () => [hold], append }).appended).toBe(false);
    expect(recordDrainHold({ repo, pr: 1, reason: 'review', read: () => [hold, event('release', { reasonCode: 'review', holdSource: 'drain' })], append }).appended).toBe(true);
    expect(writes).toHaveLength(1);
  });
});

describe('drain ledger facts — head prefixes and numeric strings', () => {
  it('does not restamp when the clearing row names an abbreviation of the live head', () => {
    const rows = planDrainLedgerFacts({ verdicts: [{ ...v, reviewGate: { acceptedMerge: true } }], repo, now,
      events: [verdict('accepted', head.slice(0, 12))] });
    expect(rows).toEqual([]);
  });
  it('accepts a numeric-string PR number', () => {
    expect(planDrainLedgerFacts({ verdicts: [{ ...v, num: '1' }], repo, events: [], now })).toHaveLength(1);
  });
});
