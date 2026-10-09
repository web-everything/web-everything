/**
 * @file scripts/__tests__/review-ledger-check.test.mjs
 * @description The #3007 Phase-1 CHECKER's assembly + report, tested without the network.
 *
 * The COMPARISON logic lives in `we:scripts/lib/verdict-ledger.mjs` and is tested next to it. What is tested
 * here is the part the CLI owns and could get wrong on its own: which PRs it sweeps, the `gh` argv, and
 * whether the rendered report actually tells a human what to do. A checker whose output cannot be acted on is
 * the Phase-1 failure mode — the whole slice exists to produce evidence a person reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeRun } from '../operations/run-store.mjs';

import {
  runCheck, readRepoEventsFromStore, buildRows, renderReport, renderRow, readOpenPrs, LABEL_FAMILIES, unfamilied, labelsByFamily, compareDerivedLabels,
  deriveRow, summarizeDerived, renderDerived, readRepoEvents, buildCheckRunRecord, appendCheckRun, buildDerivedRows,
  runAllRepos, runHistory,
} from '../review-ledger-check.mjs';
import { DEFAULT_REPOS } from '../lib/review-ledger-history.mjs';
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


// ── Slice F (#3930): derived vs live labels, per mirrored family ─────────────────────────────────────────────
describe('slice F — derived vs live labels', () => {
  let savedBoard;
  beforeEach(() => { savedBoard = process.env.WE_VERDICT_LEDGER_BOARD; delete process.env.WE_VERDICT_LEDGER_BOARD; });
  afterEach(() => { if (savedBoard === undefined) delete process.env.WE_VERDICT_LEDGER_BOARD; else process.env.WE_VERDICT_LEDGER_BOARD = savedBoard; });

  const facts = (over = {}) => ({ pr: 7, state: 'OPEN', isDraft: false, labels: [], head: { sha: 'a'.repeat(40), committedAt: '2026-08-10T10:00:00.000Z' },
    requiredChecks: [{ name: 'test', state: 'green' }], sessions: [], referrals: { pending: [], ruled: [] },
    handoffs: [], refusals: [], probeErrors: [], now: '2026-10-08T12:00:00.000Z', ...over });
  const accepted = { ...rec({ pr: 7, verdict: VERDICTS.ACCEPTED, headSha: 'a'.repeat(40), reason: 'r' }), type: 'verdict' };

  it('every label a lifecycle state renders belongs to a mirrored family', () => {
    expect(unfamilied()).toEqual([]);
    expect(LABEL_FAMILIES.map((f) => f.family)).toEqual(['review', 'ruling-needed', 'ready-to-merge', 'ci-failed']);
  });

  it('splits labels by family and ignores labels the mirror does not own', () => {
    expect(labelsByFamily(L('review:human', 'advisory:ruling-needed', 'bug', 'ci:failed')))
      .toEqual({ review: ['review:human'], 'ruling-needed': ['advisory:ruling-needed'], 'ready-to-merge': [], 'ci-failed': ['ci:failed'] });
  });

  it('does not score review labels the mirror never renders', () => {
    expect(labelsByFamily(L('review:awaiting-advisory')).review).toEqual([]);
  });

  it('reports ruling-needed drift per family: derived holds it, live does not', () => {
    const rows = compareDerivedLabels({ derived: ['review:human', 'advisory:ruling-needed'], live: ['review:human'] });
    const ruling = rows.find((r) => r.family === 'ruling-needed');
    expect(ruling).toMatchObject({ agree: false, missing: ['advisory:ruling-needed'], extra: [] });
    expect(rows.find((r) => r.family === 'review').agree).toBe(true);
  });

  it('reports a stale live label the derive would remove', () => {
    const rows = compareDerivedLabels({ derived: [], live: ['advisory:ruling-needed'] });
    expect(rows.find((r) => r.family === 'ruling-needed')).toMatchObject({ agree: false, extra: ['advisory:ruling-needed'] });
  });

  it('a PR whose derived labels equal its live labels agrees', () => {
    const row = deriveRow({ pr: 7, repo: REPO, events: [accepted], facts: facts(), liveLabels: ['review:accepted', 'ready-to-merge'] });
    expect(row.status).toBe('agree');
    expect(row.lifecycleState).toBe('READY-TO-MERGE');
  });

  it('a live accepted label with no ledger row is a mismatch, in the review and ready-to-merge families', () => {
    const row = deriveRow({ pr: 7, repo: REPO, events: [], facts: facts(), liveLabels: ['review:accepted', 'ready-to-merge'] });
    expect(row.status).toBe('mismatch');
    const bad = summarizeDerived([row]).mismatches.map((m) => m.family).sort();
    expect(bad).toEqual(['ready-to-merge', 'review']);
  });

  it('an unreadable ledger or unreadable facts is `unreadable`, never agree and never drift', () => {
    expect(deriveRow({ pr: 7, repo: REPO, events: null, facts: facts(), liveLabels: [] }).status).toBe('unreadable');
    expect(deriveRow({ pr: 7, repo: REPO, events: [], facts: null, liveLabels: [] }).status).toBe('unreadable');
    expect(deriveRow({ pr: 7, repo: REPO, events: [], facts: facts({ probeErrors: ['GitHub PR unavailable'] }), liveLabels: [] }).status).toBe('unreadable');
    const s = summarizeDerived([deriveRow({ pr: 7, repo: REPO, events: null, facts: facts(), liveLabels: [] })]);
    expect(s).toMatchObject({ unreadable: 1, agree: 0, mismatch: 0 });
    expect(s.perFamily.review.compared).toBe(0);
  });

  it('another PR\'s ledger rows never leak into this PR', () => {
    const other = { ...accepted, pr: 8 };
    const withOther = deriveRow({ pr: 7, repo: REPO, events: [other], facts: facts(), liveLabels: [] });
    const without = deriveRow({ pr: 7, repo: REPO, events: [], facts: facts(), liveLabels: [] });
    expect(withOther).toEqual(without);
  });

  it('readRepoEvents: a missing file is empty, any other read failure is unreadable (null)', () => {
    const enoent = () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); };
    const eio = () => { throw Object.assign(new Error('x'), { code: 'EIO' }); };
    expect(readRepoEvents(REPO, { read: enoent, pathOf: () => '/nope' })).toEqual([]);
    expect(readRepoEvents(REPO, { read: eio, pathOf: () => '/nope' })).toBeNull();
  });

  it('buildDerivedRows treats a throwing facts reader as unreadable', () => {
    const rows = buildDerivedRows({ repo: REPO, prs: [{ number: 9, labels: [] }], events: [], readFacts: () => { throw new Error('gh down'); } });
    expect(rows).toEqual([expect.objectContaining({ pr: 9, status: 'unreadable' })]);
  });

  it('renders per-family agreement and each mismatch', () => {
    const row = deriveRow({ pr: 7, repo: REPO, events: [], facts: facts(), liveLabels: ['advisory:ruling-needed'] });
    const text = renderDerived(summarizeDerived([row]));
    expect(text).toMatch(/ruling-needed\s+compared 1 · agree 0 · disagree 1/);
    expect(text).toMatch(/mismatch #7 ruling-needed/);
  });

  describe('the run record', () => {
    let dir;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rlc-runs-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    it('appends exactly one valid run record to the folder it is given', () => {
      const summary = summarizeDerived([deriveRow({ pr: 7, repo: REPO, events: [], facts: facts(), liveLabels: ['advisory:ruling-needed'] })]);
      const res = appendCheckRun({ repo: REPO, summary, phase1: { total: 0 }, write: (r) => writeRun(r, dir) });
      expect(res.ok).toBe(true);
      const files = readdirSync(dir);
      expect(files).toHaveLength(1);
      const saved = JSON.parse(readFileSync(join(dir, files[0]), 'utf8'));
      expect(saved).toMatchObject({ op: 'review-ledger-check', verdict: 'drift' });
      expect(saved.findings.derived.mismatches.find((m) => m.family === 'ruling-needed')).toMatchObject({ pr: 7, family: 'ruling-needed' });
    });

    it('a clean run is verdict clean; a failed write is reported, never thrown', () => {
      expect(buildCheckRunRecord({ id: 'review-ledger-check-1', repo: REPO, at: AT, summary: summarizeDerived([]), phase1: {} }).verdict).toBe('clean');
      const res = appendCheckRun({ repo: REPO, summary: summarizeDerived([]), phase1: {}, write: () => { throw new Error('disk full'); } });
      expect(res).toEqual({ ok: false, error: 'disk full' });
    });

    it('default write honours OPERATION_RUNS_DIR', () => {
      const prior = process.env.OPERATION_RUNS_DIR;
      process.env.OPERATION_RUNS_DIR = dir;
      try {
        expect(appendCheckRun({ repo: REPO, summary: summarizeDerived([]), phase1: {} }).ok).toBe(true);
        expect(readdirSync(dir)).toHaveLength(1);
      } finally {
        if (prior === undefined) delete process.env.OPERATION_RUNS_DIR; else process.env.OPERATION_RUNS_DIR = prior;
      }
    });
  });
});


describe('configured store check run', () => {
  const store = { name: 'git', shared: true, durable: true, ordering: 'total', singleWriter: 'push-race-retry' };
  it.each([false, true])('unreadable exits 2, scores nothing and appends no record (json=%s)', async (json) => {
    let writes = 0;
    let out = '';
    let err = '';
    const result = await runCheck({ repo: REPO, store: 'git', json,
      readEvents: async () => ({ status: 'unreadable', store, reason: 'no-board', error: 'no board configured' }),
      listPrs: () => [{ number: 1, labels: L('review:accepted') }],
      appendRun: () => { writes += 1; }, stdout: (s) => { out += s; }, stderr: (s) => { err += s; } });
    expect(result.exitCode).toBe(2);
    expect(writes).toBe(0);
    expect(out).not.toContain('agree');
    expect(err).toContain('review-ledger-check: ledger store git unreadable (no-board): no board configured - nothing scored');
    if (json) expect(JSON.parse(out)).toEqual({ repo: REPO, store, status: 'unreadable', reason: 'no-board', error: 'no board configured' });
  });

  it('reads once and uses the same verdict/event snapshot for both comparisons', async () => {
    let reads = 0;
    let output = '';
    let recorded;
    const rows = [{ ...rec(), type: 'verdict' }, { type: 'ruling', repo: REPO, pr: 1, ruling: 'block', findingKey: 'f1' }];
    const result = await runCheck({ repo: REPO, store: 'git', json: true,
      readEvents: async (repo, opts) => { reads += 1; expect([repo, opts]).toEqual([REPO, { store: 'git' }]); return { status: 'ok', rows, store }; },
      listPrs: async () => [{ number: 1, labels: L('review:accepted') }],
      readFacts: () => ({ headSha: 'a'.repeat(40), labels: [], checks: [], requiredChecks: [], probeErrors: [] }),
      appendRun: (r) => { recorded = r; return { ok: true }; }, stdout: (s) => { output += s; } });
    expect(reads).toBe(1);
    expect(result.exitCode).toBe(0);
    const report = JSON.parse(output);
    expect(report).toMatchObject({ store, ledgerRows: 2, summary: { total: 1 } });
    expect(report.rows[0].ledgerVerdict).toBe('accepted');
    expect(report.derived.rows).toEqual(buildDerivedRows({ repo: REPO, prs: [{ number: 1, labels: L('review:accepted') }], events: rows,
      readFacts: () => ({ headSha: 'a'.repeat(40), labels: [], checks: [], requiredChecks: [], probeErrors: [] }) }));
    expect(recorded).toBeDefined();
  });

  it.each([true, false])('report names the store and shared=%s', (shared) => {
    const text = renderReport({ repo: REPO, rows: [], summary: summarizeAgreement([]), store: { ...store, name: shared ? 'git' : 'home', shared } });
    expect(text).toContain(shared ? 'ledger store: git (shared)' : 'ledger store: home (NOT shared - rows written on other machines are invisible here)');
  });

  it('the async event convenience reader returns null on an unreadable store', async () => {
    expect(await readRepoEventsFromStore(REPO, { store: 'missing-store' })).toBeNull();
  });
});


describe('#3930 — every constellation repo, and the run history as a query', () => {
  it('runAllRepos checks each constellation repo once and returns the worst exit code', async () => {
    const seen = [];
    const res = await runAllRepos({ stdout: () => {}, run: async ({ repo }) => { seen.push(repo); return { exitCode: repo === DEFAULT_REPOS[1] ? 1 : 0 }; } });
    expect(seen).toEqual([...DEFAULT_REPOS]);
    expect(res.exitCode).toBe(1);
  });

  it('runAllRepos --json prints ONE document holding every repo report', async () => {
    let out = '';
    await runAllRepos({ json: true, stdout: (t) => { out += t; },
      run: async ({ repo, stdout }) => { stdout(`${JSON.stringify({ repo, ok: true })}\n`); return { exitCode: 0 }; } });
    expect(JSON.parse(out).repos.map((r) => r.repo)).toEqual([...DEFAULT_REPOS]);
  });

  it('runHistory answers clean days per family from run records and exits 0 only when every family is ready', () => {
    const now = new Date('2026-10-09T18:00:00Z');
    const runs = [];
    for (let i = 0; i < 7; i += 1) {
      const day = new Date(Date.UTC(2026, 9, 9 - i, 15)).toISOString();
      for (const repo of DEFAULT_REPOS) runs.push(buildCheckRunRecord({ id: `review-ledger-check-h${i}${repo.length}`, repo, at: day, summary: summarizeDerived([]), phase1: {} }));
    }
    let out = '';
    const ok = runHistory({ now, read: () => ({ runs, corrupt: 0 }), stdout: (t) => { out += t; } });
    expect(ok).toMatchObject({ ready: true, exitCode: 0, runCount: 21 });
    expect(out).toContain('ALL FAMILIES READY');
    const short = runHistory({ now, read: () => ({ runs: runs.slice(3), corrupt: 0 }), json: true, stdout: () => {} });
    expect(short).toMatchObject({ ready: false, exitCode: 1 });
    expect(runHistory({ now, read: () => ({ runs: [], corrupt: 0 }), stdout: () => {} }).exitCode).toBe(1);
  });
});
