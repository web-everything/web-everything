import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { decideLedgerGate, DEFAULT_REVIEW_AUTHORITY, REVIEW_AUTHORITIES } from '../pr-merge-gate.mjs';

const clearFolded = { clears: true, current: { coverage: { headSha: 'aaa' } } };
const clearDerived = { clears: true, holds: [] };
const heldFolded = { clears: false, current: {} };
const heldDerived = { clears: false, holds: [{ code: 'verdict:changes' }] };
const sha = { sha: 'aaa' };

const ledgers = {
  clear: { folded: clearFolded, derived: clearDerived, head: sha },
  held: { folded: heldFolded, derived: heldDerived, head: sha },
  stale: { folded: clearFolded, derived: clearDerived, head: { sha: 'bbb' } },
  unreadableNull: { folded: null, derived: null, head: sha },
  unreadableFlag: { folded: { unreadable: true }, derived: clearDerived, head: sha },
  unreadableHold: { folded: clearFolded, derived: { clears: false, holds: [{ code: 'ledger-unreadable' }] }, head: sha },
  holdDespiteClears: { folded: clearFolded, derived: { clears: true, holds: [{ code: 'same-head-cap' }] }, head: sha },
};

describe('decideLedgerGate table', () => {
  // [authority, ledger, labelsClear, clear, defer]
  const rows = [
    ['labels', 'clear', true, true, false], ['labels', 'clear', false, false, false],
    ['labels', 'held', true, true, false], ['labels', 'unreadableNull', true, true, false],
    ['labels', 'unreadableNull', false, false, false],
    ['both', 'clear', true, true, false], ['both', 'clear', false, false, false],
    ['both', 'held', true, false, false], ['both', 'held', false, false, false],
    ['both', 'stale', true, false, false], ['both', 'holdDespiteClears', true, false, false],
    ['both', 'unreadableNull', true, false, true], ['both', 'unreadableFlag', true, false, true],
    ['both', 'unreadableHold', true, false, true], ['both', 'unreadableNull', false, false, true],
    ['ledger', 'clear', false, true, false], ['ledger', 'clear', true, true, false],
    ['ledger', 'held', true, false, false], ['ledger', 'stale', true, false, false],
    ['ledger', 'unreadableNull', true, false, true],
    ['bogus', 'clear', false, false, false], ['bogus', 'held', true, false, false], ['bogus', 'clear', true, true, false],
    [undefined, 'held', true, true, false],
  ];
  it.each(rows)('%s / %s / labelsClear=%s -> clear=%s defer=%s', (authority, l, labelsClear, clear, defer) => {
    const r = decideLedgerGate({ ...ledgers[l], labelsClear, authority });
    expect(r.clear).toBe(clear);
    expect(r.defer).toBe(defer);
    expect(r.reason).toBeTruthy();
  });

  it('both never clears what labels holds, for every ledger shape', () => {
    for (const l of Object.values(ledgers)) {
      expect(decideLedgerGate({ ...l, labelsClear: false, authority: 'both' }).clear).toBe(false);
    }
  });

  it('both never clears more than labels would, with any inputs', () => {
    for (const l of Object.values(ledgers)) for (const lc of [true, false]) {
      const both = decideLedgerGate({ ...l, labelsClear: lc, authority: 'both' });
      const labels = decideLedgerGate({ ...l, labelsClear: lc, authority: 'labels' });
      if (both.clear) expect(labels.clear).toBe(true);
    }
  });

  it('never throws on empty input and defaults to labels', () => {
    expect(decideLedgerGate().clear).toBe(false);
    expect(decideLedgerGate().authority).toBe('labels');
  });
});

describe('mergeGate.reviewAuthority setting', () => {
  it('defaults to labels and is one of the declared values', () => {
    expect(DEFAULT_REVIEW_AUTHORITY).toBe('labels');
    expect(REVIEW_AUTHORITIES).toEqual(['labels', 'both', 'ledger']);
  });
  it('the mjs mirror matches config/platformDefaults.ts', () => {
    const ts = readFileSync(resolve(process.cwd(), 'config/platformDefaults.ts'), 'utf8');
    expect(ts).toMatch(/PLATFORM_MERGE_GATE_DEFAULTS = \{\s*reviewAuthority: 'labels' as 'labels' \| 'both' \| 'ledger'/);
  });
});

// ─── #5444 — the drain ledger shadow: decideLedgerGate beside the labels, every disagreement journaled ───────────
import { runLedgerShadow, shadowRow, SHADOW_OP } from '../drain-ledger-shadow.mjs';
import { buildVerdictRecord, VERDICTS } from '../verdict-ledger.mjs';
import { shadowDailyCounts } from '../review-ledger-history.mjs';

describe('drain ledger shadow (#5444)', () => {
  const repo = 'web-everything/web-everything';
  const H = 'a'.repeat(40);
  const AT = '2026-10-10T14:00:00.000Z';
  const row = (pr, verdict) => ({ type: 'verdict', ...buildVerdictRecord({ repo, pr, verdict, at: '2026-10-10T13:00:00.000Z', source: 'test', headSha: H, reason: 'r' }) });
  const v = (num, decision) => ({ num, repo, decision, headSha: H, listedHeadSha: H, reason: 'x' });
  // A drain pass: #1 labels clear + ledger accepted (agree); #2 labels clear + ledger changes (disagree);
  // #3 labels hold + ledger accepted (disagree, other direction); #4 labels clear, no ledger row (disagree).
  const verdicts = () => [v(1, 'merge'), v(2, 'merge'), v(3, 'skip'), v(4, 'merge')];
  const events = [row(1, VERDICTS.ACCEPTED), row(2, VERDICTS.CHANGES), row(3, VERDICTS.ACCEPTED)];

  it('journals every disagreement (PR, head, label verdict, ledger verdict, reason) as one run record', async () => {
    const written = [];
    const res = await runLedgerShadow({ verdicts: verdicts(), readEvents: async () => ({ status: 'ok', rows: events, store: { name: 'test', shared: true } }),
      write: (r) => { written.push(r); return '/x'; }, mintId: (p) => `${p}-1`, now: () => AT });
    expect(res.ok).toBe(true);
    expect(written).toHaveLength(1);
    const rec = written[0];
    expect(rec.op).toBe(SHADOW_OP);
    expect(rec.input).toMatchObject({ at: AT, authority: 'labels' });
    expect(rec.input.writer).toBeTruthy();
    expect(rec.findings.summary).toMatchObject({ compared: 4, agree: 1, disagree: 3, unreadable: 0, liveUnchanged: true,
      directions: { 'ledger-holds-label-clears': 2, 'ledger-clears-label-holds': 1 } });
    const byPr = Object.fromEntries(rec.findings.rows.map((r) => [r.pr, r]));
    expect(byPr[1]).toMatchObject({ status: 'agree', labelVerdict: 'clear', ledgerVerdict: 'clear' });
    expect(byPr[2]).toMatchObject({ status: 'disagree', head: H, labelVerdict: 'clear', ledgerVerdict: 'hold', direction: 'ledger-holds-label-clears' });
    expect(byPr[2].reason).toBeTruthy();
    expect(byPr[3]).toMatchObject({ status: 'disagree', labelVerdict: 'hold', ledgerVerdict: 'clear', direction: 'ledger-clears-label-holds' });
    expect(byPr[4]).toMatchObject({ status: 'disagree', ledgerVerdict: 'hold', reason: 'no ledger row for this PR' });
  });

  it('never changes what the drain lands: verdicts are untouched', async () => {
    const vs = verdicts();
    const before = JSON.stringify(vs);
    await runLedgerShadow({ verdicts: vs, readEvents: async () => ({ status: 'ok', rows: events }), write: () => '/x', now: () => AT });
    expect(JSON.stringify(vs)).toBe(before);
  });

  it('an unreadable ledger read is journaled as unreadable, never as agreement (A4)', async () => {
    const written = [];
    const res = await runLedgerShadow({ verdicts: verdicts(), readEvents: async () => ({ status: 'unreadable', reason: 'store-read-failed', error: 'boom' }),
      write: (r) => { written.push(r); return '/x'; }, now: () => AT });
    expect(res.summary).toMatchObject({ compared: 4, agree: 0, disagree: 0, unreadable: 4 });
    expect(written[0].findings.rows.every((r) => r.status === 'unreadable' && r.ledgerVerdict === 'unreadable')).toBe(true);
    // a hanging read is unreadable too, and a throwing reader never escapes
    const late = await runLedgerShadow({ verdicts: verdicts(), readEvents: () => new Promise(() => {}), write: () => '/x', timeoutMs: 5, now: () => AT });
    expect(late.summary.unreadable).toBe(4);
    const thrown = await runLedgerShadow({ verdicts: verdicts(), readEvents: () => { throw new Error('x'); }, write: () => '/x', now: () => AT });
    expect(thrown.summary.unreadable).toBe(4);
    // a malformed row for the repo is unreadable, never a clear
    expect(shadowRow({ verdict: v(1, 'merge'), repo, events: [{ junk: true }], now: AT }).status).toBe('unreadable');
  });

  it('a dry run computes but writes nothing; a write failure is reported, not thrown', async () => {
    let wrote = 0;
    const dry = await runLedgerShadow({ verdicts: verdicts(), dryRun: true, readEvents: async () => ({ status: 'ok', rows: events }), write: () => { wrote += 1; } });
    expect(dry.written).toBe(false);
    expect(wrote).toBe(0);
    const bad = await runLedgerShadow({ verdicts: verdicts(), readEvents: async () => ({ status: 'ok', rows: events }), write: () => { throw new Error('disk'); } });
    expect(bad).toMatchObject({ ok: false });
  });

  it('the checker history counts shadow disagreements per ET day', async () => {
    const written = [];
    await runLedgerShadow({ verdicts: verdicts(), readEvents: async () => ({ status: 'ok', rows: events }), write: (r) => { written.push(r); return '/x'; }, mintId: (p) => `${p}-1`, now: () => AT });
    const q = shadowDailyCounts(written, { now: new Date(AT), windowDays: 2 });
    expect(q.days.at(-1)).toMatchObject({ day: '2026-10-10', passes: 1, compared: 4, disagree: 3, ledgerHoldsLabelClears: 2, ledgerClearsLabelHolds: 1 });
    expect(q.days.at(-1).disagreeingPrs).toEqual([`${repo}#2`, `${repo}#3`, `${repo}#4`]);
    expect(shadowDailyCounts([{ input: { at: AT }, findings: {} }], { now: new Date(AT) }).corrupt).toBe(1);
  });

  it('the drain pass calls the shadow (wired in merge-ai-prs, after the pass decisions)', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../merge-ai-prs.mjs'), 'utf8');
    expect(src).toMatch(/await runLedgerShadow\(\{ verdicts, localSlug, dryRun: DRY_RUN \}\)/);
  });
});
