/**
 * @file scripts/__tests__/review-ledger-check.test.mjs
 * @description The #3007 Phase-1 CHECKER's assembly + report, tested without the network.
 *
 * The COMPARISON logic lives in `we:scripts/lib/verdict-ledger.mjs` and is tested next to it. What is tested
 * here is the part the CLI owns and could get wrong on its own: which PRs it sweeps, the `gh` argv, and
 * whether the rendered report actually tells a human what to do. A checker whose output cannot be acted on is
 * the Phase-1 failure mode — the whole slice exists to produce evidence a person reads.
 */
import { describe, it, expect } from 'vitest';

import { buildRows, renderReport, renderRow, readOpenPrs } from '../review-ledger-check.mjs';
import {
  VERDICTS, AGREEMENT, DISAGREE_DIRECTION, buildVerdictRecord, foldVerdictLedger, summarizeAgreement,
} from '../lib/verdict-ledger.mjs';
import { REVIEW_LABELS } from '../lib/review-escalation.mjs';

const REPO = 'web-everything/web-everything';
const AT = '2026-08-10T12:00:00.000Z';
const rec = (over) => buildVerdictRecord({ repo: REPO, pr: 1, verdict: VERDICTS.ACCEPTED, at: AT, source: 'test', ...over });
const L = (...names) => names.map((name) => ({ name }));

describe('readOpenPrs — one gh read, open PRs only', () => {
  it('asks gh for exactly the fields the comparison needs, and parses the array', () => {
    let seen = null;
    const out = readOpenPrs({
      repo: REPO,
      limit: 50,
      exec: (cmd, args) => { seen = { cmd, args }; return JSON.stringify([{ number: 5, labels: L(REVIEW_LABELS.pending) }]); },
    });
    expect(seen.cmd).toBe('gh');
    expect(seen.args).toEqual(['pr', 'list', '--repo', REPO, '--state', 'open', '--limit', '50', '--json', 'number,labels,title']);
    expect(out).toEqual([{ number: 5, labels: [{ name: REVIEW_LABELS.pending }] }]);
  });

  it('tolerates a non-array payload rather than crashing the sweep', () => {
    expect(readOpenPrs({ repo: REPO, exec: () => 'null' })).toEqual([]);
  });
});

describe('buildRows — the swept set is the UNION of labelled PRs and ledgered PRs', () => {
  const folded = foldVerdictLedger([
    rec({ pr: 10, verdict: VERDICTS.ACCEPTED }),
    rec({ pr: 11, verdict: VERDICTS.HUMAN }),
    rec({ pr: 99, verdict: VERDICTS.ACCEPTED }), // a ledgered PR that is NOT open any more
  ]);

  it('includes a PR with a review label and no ledger row', () => {
    const rows = buildRows({ prs: [{ number: 20, labels: L(REVIEW_LABELS.pending) }], folded });
    expect(rows.map((r) => r.pr)).toEqual([20]);
    expect(rows[0].status).toBe(AGREEMENT.UNLEDGERED);
  });

  it('includes a PR with a ledger row and NO review label — the orphan a label-only sweep would hide', () => {
    const rows = buildRows({ prs: [{ number: 10, labels: L('size/S') }], folded });
    expect(rows.map((r) => r.pr)).toEqual([10]);
    expect(rows[0].status).toBe(AGREEMENT.UNLABELED);
  });

  it('skips a PR that is neither labelled nor ledgered', () => {
    expect(buildRows({ prs: [{ number: 77, labels: L('size/M') }], folded })).toEqual([]);
  });

  it('skips a ledger row whose PR is no longer open — a decided PR cannot merge twice', () => {
    const rows = buildRows({ prs: [{ number: 10, labels: L(REVIEW_LABELS.accepted) }], folded });
    expect(rows.map((r) => r.pr)).toEqual([10]);
    expect(rows.some((r) => r.pr === 99)).toBe(false);
  });

  it('returns PR-ascending rows and ignores malformed gh entries', () => {
    const rows = buildRows({
      prs: [{ number: 11, labels: L(REVIEW_LABELS.human) }, null, { labels: [] }, { number: 10, labels: L(REVIEW_LABELS.accepted) }],
      folded,
    });
    expect(rows.map((r) => r.pr)).toEqual([10, 11]);
  });
});

describe('renderReport — output a human can act on', () => {
  const folded = foldVerdictLedger([
    rec({ pr: 10, verdict: VERDICTS.HUMAN, reason: 'gate-self' }),
    rec({ pr: 12, verdict: VERDICTS.ACCEPTED }),
  ]);
  const rows = buildRows({
    prs: [
      { number: 10, labels: L(REVIEW_LABELS.accepted) },  // DANGEROUS: ledger holds, label clears
      { number: 11, labels: L(REVIEW_LABELS.pending) },   // unledgered
      { number: 12, labels: L(REVIEW_LABELS.accepted) },  // agrees
    ],
    folded,
  });
  const summary = summarizeAgreement(rows);
  const text = renderReport({ repo: REPO, rows, summary, path: '/tmp/ledger.jsonl' });

  it('classifies the three rows the way the gate would read them', () => {
    expect(rows.find((r) => r.pr === 10).direction).toBe(DISAGREE_DIRECTION.LEDGER_HOLDS_LABEL_CLEARS);
    expect(rows.find((r) => r.pr === 11).status).toBe(AGREEMENT.UNLEDGERED);
    expect(rows.find((r) => r.pr === 12).status).toBe(AGREEMENT.AGREE);
  });

  it('names the PRs to act on, not just a count', () => {
    expect(text).toMatch(/ACT NOW — 1 PR\(s\)/);
    expect(text).toMatch(/#10/);
  });

  it('reports the unledgered count as a PHASE-2 precondition, never as a disagreement', () => {
    expect(text).toMatch(/OWED BEFORE PHASE 2 — 1 PR\(s\)/);
    expect(text).toMatch(/drain-applied hold/);
    expect(summary.counts.disagree).toBe(1); // the unledgered row is NOT counted here
  });

  it('states the Phase-2 readiness verdict explicitly, and refuses it on this input', () => {
    expect(text).toMatch(/PHASE 2 READINESS: not yet/);
    expect(summary.phase2Safe).toBe(false);
  });

  it('hides agreeing rows by default and shows them under --all', () => {
    expect(text).not.toMatch(/#12/);
    expect(renderReport({ repo: REPO, rows, summary, path: '/tmp/x', showAll: true })).toMatch(/#12/);
  });

  it('a clean sweep says so, and says one clean day is not the evidence Phase 2 needs', () => {
    const cleanRows = buildRows({ prs: [{ number: 12, labels: L(REVIEW_LABELS.accepted) }], folded });
    const clean = summarizeAgreement(cleanRows);
    const out = renderReport({ repo: REPO, rows: cleanRows, summary: clean, path: '/tmp/x' });
    expect(clean.phase2Safe).toBe(true);
    expect(out).toMatch(/all 1 compared PR\(s\) agree/);
    expect(out).toMatch(/RUN OF such days, not one/);
  });

  it('an empty sweep is not an error', () => {
    const empty = summarizeAgreement([]);
    expect(renderReport({ repo: REPO, rows: [], summary: empty, path: '/tmp/x' })).toMatch(/nothing to compare/);
  });

  it('marks the dangerous direction distinctly from the safe one in the per-PR line', () => {
    expect(renderRow(rows.find((r) => r.pr === 10))).toMatch(/BLOCKER/);
    const safe = buildRows({
      prs: [{ number: 12, labels: L(REVIEW_LABELS.human) }],
      folded,
    })[0];
    expect(safe.direction).toBe(DISAGREE_DIRECTION.LEDGER_CLEARS_LABEL_HOLDS);
    expect(renderRow(safe)).not.toMatch(/BLOCKER/);
    expect(renderRow(safe)).toMatch(/differs/);
  });
});
