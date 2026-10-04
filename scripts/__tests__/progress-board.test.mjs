/**
 * @file progress-board.test.mjs — the derivation + the CLI behind the operator's published board (item `x9t5i5a`).
 *
 * Two surfaces, both load-bearing and both cheap to get wrong:
 *   • `classifyPr` — the whole "who is holding the ball" reduction. A mis-ranked label puts the ONE pull request
 *     that needs the operator underneath five that do not, which is precisely the failure the board exists to fix.
 *   • The CLI — the only writer of the state file. If a verb is not idempotent, a second identical run silently
 *     rewrites a date or duplicates a row, and the board starts lying about when work moved.
 *
 * The CLI tests SPAWN the real script against a temp state + out path with `--no-gh`, so nothing here touches the
 * network or the repo's own board. `WE_BOARD_NOW` freezes the stamp so renders are comparable byte-for-byte.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyPr,
  ciFailed,
  ciPending,
  buildModel,
  renderPage,
  applyVerb,
  slugify,
  loadState,
  assertWritablePath,
  ensureRulingNumbers,
  findDecision,
  verifyPage,
  decisionGaps,
  validateDecisions,
  rulingFloor,
  PR_STATUS,
  STATE_ERROR,
  STATE_UNREADABLE,
  DECISION_FIELDS,
  DECISION_STATUSES,
} from '../progress-board.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'progress-board.mjs');
const NOW = '2026-08-08T12:00:00.000Z';
process.env.WE_BOARD_NOW = NOW; // freeze the stamp for the in-process `renderPage` cases too

const sandbox = mkdtempSync(join(tmpdir(), 'progress-board-'));
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

let statePath;
let outPath;
let seq = 0;

const SEED = {
  title: 'Test board',
  repo: 'web-everything/web-everything',
  artifactUrl: null,
  phases: { 1: 'First' },
  items: [
    { id: 'alpha', title: 'Alpha', phase: 1, status: 'todo' },
    { id: 'beta', title: 'Beta', phase: 1, status: 'in-progress', pr: 1099 },
  ],
  // Complete on purpose: the board REFUSES to render an `awaiting` decision that cannot be answered from the
  // page, so a seed with a bare title would fail every CLI case here for the wrong reason.
  decisions: [
    {
      id: '2978',
      title: 'A decision',
      status: 'awaiting',
      question: 'Do we take the decision?',
      options: [
        { label: 'Yes', detail: 'take it', recommended: true },
        { label: 'No', detail: 'leave it' },
      ],
      ifNothing: 'nothing moves',
    },
  ],
};

beforeEach(() => {
  seq += 1;
  statePath = join(sandbox, `state-${seq}.json`);
  outPath = join(sandbox, `board-${seq}.html`);
  writeFileSync(statePath, JSON.stringify(SEED, null, 2));
});

/** Run the real CLI. Never throws — exit code + stdout are the assertion surface. */
function cli(...args) {
  const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${outPath}`, '--no-gh', ...args], {
    encoding: 'utf8',
    env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
  });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

const state = () => JSON.parse(readFileSync(statePath, 'utf8'));
const page = () => readFileSync(outPath, 'utf8');

const pr = (over = {}) => ({
  number: 1,
  title: 'A pull request',
  state: 'OPEN',
  mergeStateStatus: 'CLEAN',
  statusCheckRollup: [],
  labels: [],
  ...over,
  labels: (over.labels ?? []).map((name) => ({ name })),
});

// ── The derivation ────────────────────────────────────────────────────────────

describe('classifyPr', () => {
  it('flags a human-hold pull request as the operator\'s', () => {
    expect(classifyPr(pr({ labels: ['ready-to-merge', 'review:human'] }))).toBe('needs-human');
  });

  it('ranks a changes-requested pull request as the AUTHOR\'s, even when it also carries the human hold', () => {
    // The ball is with the author lane. Surfacing it to the operator would bury the PRs that truly await them.
    expect(classifyPr(pr({ labels: ['review:changes', 'review:human'] }))).toBe('bounced');
  });

  it('lets review:accepted supersede review:human', () => {
    expect(classifyPr(pr({ labels: ['review:human', 'review:accepted'] }))).toBe('queued');
  });

  it('reports a failed required check ahead of any queue label', () => {
    expect(classifyPr(pr({ labels: ['ready-to-merge'], statusCheckRollup: [{ conclusion: 'FAILURE' }] }))).toBe('ci-red');
  });

  it('reports a dirty or behind merge state as conflicted', () => {
    expect(classifyPr(pr({ mergeStateStatus: 'DIRTY', labels: ['ready-to-merge'] }))).toBe('conflicted');
    expect(classifyPr(pr({ mergeStateStatus: 'BEHIND', labels: ['ready-to-merge'] }))).toBe('conflicted');
  });

  it('distinguishes parked-for-review from reviewed-and-queued', () => {
    expect(classifyPr(pr({ labels: ['ready-to-merge', 'review:pending'] }))).toBe('needs-review');
    expect(classifyPr(pr({ labels: ['ready-to-merge', 'review:accepted'] }))).toBe('queued');
  });

  it('does not let review-gate\'s own by-design pre-review failure mask needs-review as ci-red (x3hg6h2)', () => {
    // The exact live rollup shape confirmed 2026-09-05 on PRs #1928/#1929/#1933/#1926/etc: every real check
    // (test, smoke, every test-shard) is green; ONLY `review-gate` is red, because that check's whole job is
    // to report FAILURE for as long as the PR is un-reviewed. Before the fix this read `ci-red` and the
    // review-dispatch loop could never reach it — a permanent self-referential deadlock.
    const rollup = [
      { name: 'review-gate', conclusion: 'FAILURE' },
      { name: 'test', conclusion: 'SUCCESS' },
      { name: 'smoke', conclusion: 'SUCCESS' },
      { name: 'test-shard (1)', conclusion: 'SUCCESS' },
      { name: 'test-shard (2)', conclusion: 'SUCCESS' },
    ];
    expect(ciFailed(rollup)).toBe(false);
    expect(classifyPr(pr({ labels: ['review:pending'], statusCheckRollup: rollup }))).toBe('needs-review');
    // A REAL broken required check (any name other than review-gate) must still read ci-red.
    expect(classifyPr(pr({ labels: ['review:pending'], statusCheckRollup: [...rollup, { name: 'test-shard (3)', conclusion: 'FAILURE' }] }))).toBe('ci-red');
  });

  // #2748 false-red follow-up (soak-replay-gate, PR #2775) — LIVE INCIDENT 2026-09-26: `chalbert/web-
  // everything#2748`'s real rollup (`gh pr view 2748 --repo web-everything/web-everything --json
  // statusCheckRollup`) has every REQUIRED check (`test`/`smoke`/`daemon-soak`) green and ONLY the new
  // advisory `soak-replay-gate` check red — the exclusion-list-only `ciFailed(rollup)` (no second arg,
  // BEFORE `soak-replay-gate` was added to `CI_TRUTH_EXCLUDED_CHECKS`) misread this as `ci-red`. Passing the
  // repo's REQUIRED set fixes it structurally: only a check IN that set can fail this read, so a brand-new
  // advisory check can never do this again even before anyone remembers to update an exclusion list.
  it('does not let a NEW advisory check (soak-replay-gate) read as ci-red when a required set is supplied ' +
    '— PR #2748\'s real rollup, 2026-09-26', () => {
    const pr2748Rollup = [
      { name: 'review-gate', conclusion: 'FAILURE' },
      { name: 'soak-replay-gate', conclusion: 'FAILURE' },
      { name: 'test-shard (1)', conclusion: 'SUCCESS' },
      { name: 'test-shard (2)', conclusion: 'SUCCESS' },
      { name: 'test-shard (3)', conclusion: 'SUCCESS' },
      { name: 'test-shard (4)', conclusion: 'SUCCESS' },
      { name: 'daemon-soak', conclusion: 'SUCCESS' },
      { name: 'smoke', conclusion: 'SUCCESS' },
      { name: 'test', conclusion: 'SUCCESS' },
    ];
    const requiredChecks = ['test', 'smoke', 'daemon-soak'];
    // Even carrying the SAME stale `ci:failed` label the live incident had, the rollup now positively proves
    // every required check green, so the fallback in the `ci:failed` branch below correctly stands down too.
    expect(ciFailed(pr2748Rollup, requiredChecks)).toBe(false);
    expect(
      classifyPr(pr({ labels: ['review:pending', 'ci:failed'], mergeStateStatus: 'UNSTABLE', statusCheckRollup: pr2748Rollup }), requiredChecks),
    ).toBe('needs-review');
    // A REAL required-check failure must still read ci-red when a required set is supplied.
    expect(ciFailed([...pr2748Rollup, { name: 'test', conclusion: 'FAILURE' }], requiredChecks)).toBe(true);
  });

  it('with no required set supplied, ciFailed/classifyPr still fall back to the exclusion list unchanged '
    + '(soak-replay-gate is now IN that list too — see CI_TRUTH_EXCLUDED_CHECKS)', () => {
    const rollup = [
      { name: 'soak-replay-gate', conclusion: 'FAILURE' },
      { name: 'test', conclusion: 'SUCCESS' },
    ];
    expect(ciFailed(rollup)).toBe(false);
    expect(classifyPr(pr({ labels: ['review:pending'], statusCheckRollup: rollup }))).toBe('needs-review');
  });

  // we:backlog/fix-review-ciheal-deadlock (LIVE DEADLOCK 2026-09-28/29, PR #2878, web-everything/web-everything) —
  // the REAL rollup read live off PR #2878 via `gh pr view 2878 --repo web-everything/web-everything --json
  // statusCheckRollup` at the moment of the incident (trimmed to the fields `ciFailed`/`classifyPr` read).
  // `soak-replay-gate` is a REQUIRED check (`gh api repos/web-everything/web-everything/branches/main/protection
  // --jq .required_status_checks.contexts` confirmed live: `["test","smoke","daemon-soak","soak-replay-gate"]`
  // — added to branch protection after the #2748 fix above landed, when only `test`/`smoke`/`daemon-soak`
  // were required) and, like `review-gate`, it RE-RUNS on more than one event for the SAME head — leaving a
  // stale `FAILURE` run beside a later `SUCCESS` rerun in the very same fetch. Before the
  // `collapseRollupToLatestPerName` fix (see `ciFailed`'s own header), a flat `.some()` found that stale run
  // and read `ci-red` forever, even though every required check's LATEST run (and `review-gate`, excluded by
  // design) was green — dispatching a ci-heal that could only ever escalate "not a CI break — the only red
  // check is review-gate", which then durably blocked review dispatch too.
  it('collapses to the latest run per check name — PR #2878\'s real live rollup, 2026-09-28/29 '
    + '(we:backlog/fix-review-ciheal-deadlock)', () => {
    const pr2878Rollup = [
      { __typename: 'CheckRun', name: 'review-gate', conclusion: 'FAILURE' }, // stale — superseded below
      { __typename: 'CheckRun', name: 'review-gate', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'soak-replay-gate', conclusion: 'FAILURE' }, // stale — superseded below
      { __typename: 'CheckRun', name: 'test-shard (1)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'review-gate', conclusion: 'SUCCESS' }, // the LATEST review-gate run
      { __typename: 'CheckRun', name: 'soak-replay-gate', conclusion: 'SUCCESS' }, // the LATEST run — this counts
      { __typename: 'CheckRun', name: 'test-shard (2)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-shard (3)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-shard (4)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'daemon-soak-scope', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'smoke', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-selection-measure', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'visual', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'test', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'soak-shard (1)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'soak-shard (2)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'soak-shard (3)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'soak-shard (4)', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'daemon-soak', conclusion: 'SUCCESS' },
    ];
    const requiredChecks = ['test', 'smoke', 'daemon-soak', 'soak-replay-gate'];
    expect(ciFailed(pr2878Rollup, requiredChecks)).toBe(false);
    expect(
      classifyPr(pr({ labels: ['review:pending'], mergeStateStatus: 'UNSTABLE', statusCheckRollup: pr2878Rollup }), requiredChecks),
    ).toBe('needs-review');
  });

  it('treats a merged pull request as landed whatever its labels say', () => {
    expect(classifyPr(pr({ state: 'MERGED', labels: ['review:human'] }))).toBe('landed');
  });

  it('falls back to plain open with no signal at all', () => {
    expect(classifyPr(pr())).toBe('open');
  });

  it('separates a pending check from a failed one', () => {
    expect(ciPending([{ conclusion: '', state: 'PENDING' }])).toBe(true);
    expect(ciFailed([{ conclusion: '', state: 'PENDING' }])).toBe(false);
    expect(ciFailed([{ conclusion: 'TIMED_OUT' }])).toBe(true);
  });

  // #xznd5za (epic #3383/#4075) — LIVE INCIDENT 2026-09-25: `web-everything/web-everything#2636`'s required check
  // `test-shard (1)` concluded CANCELLED (the daemon's own hung-ci-recovery cancel, applied only once ITS OWN
  // hung-recovery cap was exhausted — never re-run). `ciFailed` used to hand-roll its own conclusion list
  // (`FAILURE`/`TIMED_OUT`/`ACTION_REQUIRED`/`STARTUP_FAILURE`) that OMITTED `CANCELLED` — so `classifyPr` read
  // this exact rollup as having no failing check and returned `'open'`, never `'ci-red'`, and
  // `reconcile-core.mjs`'s entire ci-heal branch (dispatch AND its cap-exhausted escalation) was skipped. This
  // is the REAL rollup read live off PR #2636 via `gh pr view 2636 --repo web-everything/web-everything --json
  // statusCheckRollup` at the moment of the incident (trimmed to the fields `ciFailed`/`classifyPr` read).
  it('reads a CANCELLED required check as ci-red — PR #2636\'s real live rollup, 2026-09-25 (#xznd5za)', () => {
    const pr2636Rollup = [
      { __typename: 'CheckRun', name: 'test-shard (1)', status: 'COMPLETED', conclusion: 'CANCELLED' },
      { __typename: 'CheckRun', name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-shard (2)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-shard (3)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-shard (4)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test-selection-measure', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'CheckRun', name: 'visual', status: 'COMPLETED', conclusion: 'SKIPPED' },
    ];
    expect(ciFailed(pr2636Rollup)).toBe(true);
    expect(classifyPr(pr({ labels: ['ci:failed'], mergeStateStatus: 'BLOCKED', statusCheckRollup: pr2636Rollup }))).toBe('ci-red');
  });

  // xx6kg3f (epic #3383/#4075) — LIVE INCIDENT 2026-09-26 13:52 ET, PR #2739 (web-everything/web-everything):
  // `review:accepted` + the durable `ci:failed` label, but the reconcile tick that logged
  // `reconcile-refused nothing-owed … phase queued` for it had fetched a rollup that did not (yet, or due to
  // a `gh` hiccup) show the failing `test` check — `ciFailed([])` reads `false`, and with no OTHER signal
  // `classifyPr` fell through to `queued`. The durable `ci:failed` label is exactly the fact this rollup read
  // missed; trusting it as a fallback is what closes the gap. Fixture: PR #2739's REAL labels
  // (`gh pr view 2739 --repo web-everything/web-everything --json labels`), with the rollup this ONE degraded read
  // would have returned (empty — the shape a rate-limited/partial `gh` response takes, per this file's own
  // "degradation is a feature" header).
  it('trusts the durable ci:failed label when this read\'s own rollup came back empty — PR #2739, 2026-09-26 (xx6kg3f)', () => {
    const pr2739Labels = ['review:accepted', 'ci:failed', 'review-round:2', 'review-status:reviewing'];
    expect(classifyPr(pr({ labels: pr2739Labels, mergeStateStatus: 'BLOCKED', statusCheckRollup: [] }))).toBe('ci-red');
  });

  // The full real rollup (`gh pr view 2739 --repo web-everything/web-everything --json statusCheckRollup`, at the
  // moment its `test` check had already concluded) already classified correctly BEFORE the fix above — pinned
  // here so a future change to `ciFailed`/`FAILING_CONCLUSIONS` cannot quietly regress the non-degraded path.
  it('reads PR #2739\'s real, undegraded rollup as ci-red too (xx6kg3f)', () => {
    const pr2739Labels = ['review:accepted', 'ci:failed', 'review-round:2', 'review-status:reviewing'];
    const pr2739Rollup = [
      { name: 'test-shard (1)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'review-gate', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test-shard (2)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test-shard (3)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test-shard (4)', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'daemon-soak', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'smoke', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { name: 'test-selection-measure', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'visual', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
    ];
    expect(classifyPr(pr({ labels: pr2739Labels, mergeStateStatus: 'BLOCKED', statusCheckRollup: pr2739Rollup }))).toBe('ci-red');
  });

  it('ranks the operator\'s status above every other', () => {
    const ranks = Object.entries(PR_STATUS).map(([k, v]) => [k, v.rank]);
    expect(Math.min(...ranks.map(([, r]) => r))).toBe(PR_STATUS['needs-human'].rank);
  });
});

describe('buildModel', () => {
  const prs = {
    fresh: true,
    fetchedAt: NOW,
    reason: null,
    rows: [
      { number: 1099, title: 'Needs the operator', labels: [], status: 'needs-human', detail: '' },
      { number: 1092, title: 'Bounced', labels: [], status: 'bounced', detail: '' },
      { number: 1090, title: 'Landed', labels: [], status: 'landed', detail: '' },
    ],
  };

  it('puts decisions, human-hold PRs and blocked items in the operator\'s section', () => {
    const s = { ...SEED, items: [{ id: 'x', title: 'X', phase: 1, status: 'blocked', blocker: 'waiting' }] };
    const m = buildModel(s, prs);
    expect(m.needsYou.decisions).toHaveLength(1);
    expect(m.needsYou.prs.map((r) => r.number)).toEqual([1099]);
    expect(m.needsYou.items.map((i) => i.id)).toEqual(['x']);
    expect(m.counts.needsYou).toBe(3);
  });

  it('does not list an in-progress item twice when its pull request is already on the board', () => {
    const m = buildModel(SEED, prs); // `beta` is pinned to PR #1099, which IS in the rows
    expect(m.inFlight.items.map((i) => i.id)).not.toContain('beta');
    expect(m.plan[0].items.map((i) => i.id)).toContain('beta'); // the plan table still enumerates it
  });

  it('joins a plan item to its live pull-request row', () => {
    const m = buildModel(SEED, prs);
    const beta = m.plan[0].items.find((i) => i.id === 'beta');
    expect(beta.prRow.status).toBe('needs-human');
  });

  it('sorts pull rows by consequence, not by number', () => {
    const m = buildModel(SEED, prs);
    expect(m.prs.rows.map((r) => r.status)).toEqual(['needs-human', 'bounced', 'landed']);
  });
});

// ── The page ──────────────────────────────────────────────────────────────────

describe('renderPage', () => {
  const html = () => renderPage(buildModel(SEED, { fresh: true, fetchedAt: NOW, reason: null, rows: [] }));

  it('emits an Artifact-ready fragment — a provenance marker, then a title, no document skeleton', () => {
    const h = html();
    expect(h).toMatch(/^<!-- progress-board:generated /);
    expect(h.split('\n').slice(1).join('\n')).toMatch(/^<title>/);
    expect(h).not.toMatch(/<!doctype/i);
    expect(h).not.toMatch(/<html[\s>]/i);
    expect(h).not.toMatch(/<body[\s>]/i);
  });

  it('is self-contained — the strict CSP blocks every external host', () => {
    const h = html();
    expect(h).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(h).not.toMatch(/<link\b/i);
    expect(h).not.toMatch(/<script\b/i);
    expect(h).not.toMatch(/@import/i);
    expect(h).not.toMatch(/url\(\s*["']?https?:/i);
  });

  it('defines the palette in all four theme places so the viewer\'s toggle wins both ways', () => {
    const h = html();
    expect(h).toContain('@media (prefers-color-scheme: dark)');
    expect(h).toContain(':root[data-theme="dark"]');
    expect(h).toContain(':root[data-theme="light"]');
    expect(h.match(/--bg:/g).length).toBe(4); // :root + media + both toggles
  });

  it('scrolls wide content in its own container, never the body', () => {
    const h = html();
    expect(h).toContain('.scroll { overflow-x: auto');
    expect(h).toMatch(/body\s*\{[^}]*overflow-x: hidden/);
  });

  it('carries a refresh stamp and an honest note that pull-request state moves', () => {
    const h = html();
    expect(h).toContain('Last refreshed');
    expect(h).toContain('2026-08-08 12:00 UTC');
    expect(h).toMatch(/Pull-request state moves continuously/);
  });

  it('leads with what needs the operator', () => {
    const h = html();
    expect(h.indexOf('Needs you')).toBeLessThan(h.indexOf('In flight'));
    expect(h.indexOf('In flight')).toBeLessThan(h.indexOf('Landed'));
  });

  it('escapes hostile content out of pull-request titles', () => {
    const rows = [{ number: 7, title: '<img src=x onerror=alert(1)>', labels: [], status: 'open', detail: '' }];
    const h = renderPage(buildModel(SEED, { fresh: true, fetchedAt: NOW, reason: null, rows }));
    expect(h).not.toContain('<img src=x');
    expect(h).toContain('&lt;img src=x');
  });

  it('says so, loudly, when the pull-request half is stale', () => {
    const h = renderPage(buildModel(SEED, { fresh: false, fetchedAt: NOW, reason: 'GitHub was unreachable', rows: [] }));
    expect(h).toContain('class="banner"');
    expect(h).toContain('GitHub was unreachable');
  });
});

// ── The weekly output mix (#3012) ─────────────────────────────────────────────

/**
 * The board's THIRD derived half: product vs machinery lines added this week, with the four completed weeks
 * beside it. The derivation itself is proved in `scripts/lib/__tests__/output-mix.test.mjs`; what matters
 * here is that the page carries both numbers and the trend, and that a failed derivation degrades to an
 * honest note rather than an empty section that reads as "no work happened".
 */
describe('the output-mix section', () => {
  const PRS = { fresh: true, fetchedAt: NOW, reason: null, rows: [] };
  const MIX = {
    fresh: true,
    reason: null,
    weeks: [
      { start: '2026-07-06', end: '2026-07-12', product: 1106, machinery: 28757, other: 4041, total: 33904 },
      { start: '2026-07-13', end: '2026-07-19', product: 1883, machinery: 12638, other: 2024, total: 16545 },
      { start: '2026-07-20', end: '2026-07-26', product: 206, machinery: 26553, other: 989, total: 27748 },
      { start: '2026-07-27', end: '2026-08-02', product: 627, machinery: 36347, other: 757, total: 37731 },
      { start: '2026-08-03', end: '2026-08-09', product: 0, machinery: 47014, other: 1014, total: 48028 },
    ],
    get current() {
      return this.weeks[4];
    },
    get trend() {
      return this.weeks.slice(0, 4);
    },
  };

  it('renders the current week as two numbers, grouped and signed', () => {
    const h = renderPage(buildModel(SEED, PRS, MIX));
    expect(h).toContain('Output mix');
    expect(h).toContain('Product lines this week');
    expect(h).toContain('+47,014');
    expect(h).toContain('no product output at all');
  });

  it('puts the four completed weeks beside it, oldest first, with the current week marked', () => {
    const h = renderPage(buildModel(SEED, PRS, MIX));
    // Scoped to the trend table's BODY: week stamps also appear in the summary line above it and in item
    // dates elsewhere on the page, so an index comparison over anything wider proves nothing about row order.
    const from = h.indexOf('>Output mix<');
    const body = h.slice(h.indexOf('<tbody>', from), h.indexOf('</tbody>', from));
    for (const w of ['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27', '2026-08-03']) expect(body).toContain(w);
    expect(body).toContain('this week, still running');
    expect(body.indexOf('2026-07-06')).toBeLessThan(body.indexOf('2026-08-03'));
  });

  it('shows the unclassified remainder, so a reader can see how much the two numbers cover', () => {
    const h = renderPage(buildModel(SEED, PRS, MIX));
    expect(h).toContain('+4,041');
    expect(h).toContain('Other');
  });

  it('names the committed rule list on the page, so the classification is inspectable from it', () => {
    const h = renderPage(buildModel(SEED, PRS, MIX));
    expect(h).toContain('we:scripts/lib/output-mix-paths.json');
  });

  it('degrades to an honest note — never a silent empty section — when the derivation failed', () => {
    const h = renderPage(buildModel(SEED, PRS, { fresh: false, reason: 'the git history could not be read — boom', weeks: [], current: null, trend: [] }));
    expect(h).toContain('could not be computed');
    expect(h).toContain('the git history could not be read');
  });

  it('degrades the same way when no mix was supplied at all', () => {
    const h = renderPage(buildModel(SEED, PRS));
    expect(h).toContain('could not be computed');
  });

  /**
   * The one case that runs the REAL derivation through the CLI. Every other `cli()` call in this file forces
   * `WE_BOARD_NO_GIT=1` for runtime, which means `main()`'s own call into `computeOutputMix` — the ROOT it
   * resolves, the `today` it passes, the wiring into `buildModel` — is otherwise never executed under test:
   * the module could throw at that seam and 216 green tests would say nothing. Asserts SHAPE only, never a
   * number, because the number moves every week.
   */
  it('runs the real git derivation end to end when it is NOT disabled', () => {
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${outPath}`, '--no-gh'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '' },
    });
    expect(r.status, r.stderr).toBe(0);
    const h = readFileSync(outPath, 'utf8');
    expect(h).toContain('Output mix');
    expect(h).not.toContain('could not be computed');
    // A real read produces grouped, signed figures in the machinery column — not the honest-note fallback.
    expect(h).toMatch(/Machinery \+ bookkeeping/);
    expect(h).toMatch(/>\+[\d,]+<\/div>/);
  }, 30_000);
});

// ── Decisions: the page's only ask ────────────────────────────────────────────

/**
 * A decision has to be ANSWERABLE from the page — the question, why it is a judgment call, the real options
 * with one recommended, what breaks if nothing is done, and the grounding. Every field is optional, so the
 * fallback (a bare `{id, title, detail}`, the shape the board shipped with) has to keep rendering too.
 */
describe('decisions', () => {
  const RICH = {
    id: 'fork-b',
    title: 'Fork B — rebuild or drop',
    status: 'awaiting',
    question: 'Does the codification shortcut get one more attempt, or get dropped?',
    why: 'Broken three times by three independent reviewers.',
    options: [
      { label: 'One round rebuilt on markdown-it', detail: 'detection and rendering cannot disagree', recommended: true },
      { label: 'Drop Fork B now', detail: 'the status quo, and it costs little' },
    ],
    ifNothing: 'Fork A still ships; codification PRs keep needing a human.',
    evidence: ['three breaks: mid-rule splice', 'a working attack added autoLand:true'],
  };
  /** The shape the board shipped with — id, title, detail. It stays renderable for the states that are not asks. */
  const LEGACY = { id: '2691', title: 'Define a feature tier above epic', preparedDate: '2026-07-28', detail: 'prepared and ready to ratify' };
  const COMPLETE = { ...RICH, id: 'other', title: 'Another decision', question: 'Another question?' };

  const render = (decisions) =>
    renderPage(buildModel({ ...SEED, items: [], decisions }, { fresh: true, fetchedAt: NOW, reason: null, rows: [] }));

  /** The markup of ONE section, so "renders" and "renders IN THE RIGHT PLACE" are different assertions. */
  const section = (h, title) => {
    const start = h.indexOf(`<h2>${title}</h2>`);
    expect(start).toBeGreaterThan(-1);
    return h.slice(start, h.indexOf('</section>', start));
  };

  it('leads a rich decision with the question, not the title', () => {
    const h = section(render([RICH]), 'Needs you');
    expect(h).toContain('<div class="t">Does the codification shortcut get one more attempt, or get dropped?</div>');
    expect(h).toContain('Fork B — rebuild or drop'); // the title survives as the handle underneath
    expect(h.indexOf('get dropped?')).toBeLessThan(h.indexOf('Fork B — rebuild or drop'));
  });

  it('renders why it is a judgment call, every option, and marks exactly one recommended', () => {
    const h = section(render([RICH]), 'Needs you');
    expect(h).toContain('Broken three times by three independent reviewers.');
    expect(h).toContain('One round rebuilt on markdown-it');
    expect(h).toContain('Drop Fork B now');
    expect(h).toContain('detection and rendering cannot disagree');
    expect(h.match(/class="chip ok">recommended</g)).toHaveLength(1);
    expect(h.match(/<li class="rec">/g)).toHaveLength(1);
  });

  it('gives what-breaks and the grounding their own treatment', () => {
    const h = section(render([RICH]), 'Needs you');
    expect(h).toContain('<b>If nothing is done:</b> Fork A still ships');
    expect(h).toContain('<span class="mono e">three breaks: mid-rule splice</span>');
    expect(h).toContain('<span class="mono e">a working attack added autoLand:true</span>');
  });

  it('still renders a bare decision from `detail` alone — none of the new fields required to RENDER', () => {
    // The fields are required to ASK (see the enforcement cases); rendering keeps working for the states
    // that are not asks, so an old entry never becomes unprintable.
    const h = section(render([{ ...LEGACY, status: 'queued' }]), 'Ruled, queued');
    expect(h).toContain('Define a feature tier above epic');
    expect(h).toContain('prepared and ready to ratify · prepared 2026-07-28');
    expect(h).not.toContain('class="opts"');
    expect(h).not.toContain('class="breaks"');
  });

  it('keeps a RULED-and-queued decision visible but out of the operator\'s section and out of its count', () => {
    const queued = { id: '2572', title: 'Converge daemon scheduling', status: 'queued', ifNothing: 'every parked PR keeps waiting.' };
    const m = buildModel({ ...SEED, items: [], decisions: [COMPLETE, queued] }, { fresh: true, fetchedAt: NOW, reason: null, rows: [] });
    expect(m.needsYou.decisions.map((d) => d.id)).toEqual(['other']);
    expect(m.ruled.map((d) => d.id)).toEqual(['2572']);
    expect(m.counts.needsYou).toBe(1); // the ruling is already made; it is not an ask

    const h = renderPage(m);
    expect(section(h, 'Needs you')).not.toContain('Converge daemon scheduling');
    const ruled = section(h, 'Ruled, queued');
    expect(ruled).toContain('Converge daemon scheduling');
    expect(ruled).toContain('ruled · queued');
    expect(ruled).toContain('every parked PR keeps waiting.');
  });

  it('keeps a DRAFT far away from the operator, in its own low-emphasis section', () => {
    const draft = { id: 'half-built', title: 'Half-built', status: 'draft', question: 'Is this ready?', ifNothing: 'nothing' };
    const m = buildModel({ ...SEED, items: [], decisions: [COMPLETE, draft] }, { fresh: true, fetchedAt: NOW, reason: null, rows: [] });
    expect(m.needsYou.decisions.map((d) => d.id)).toEqual(['other']);
    expect(m.drafts.map((d) => d.id)).toEqual(['half-built']);
    expect(m.counts.needsYou).toBe(1);

    const h = renderPage(m);
    expect(section(h, 'Needs you')).not.toContain('Half-built');
    const drafts = section(h, 'Decisions being prepared');
    expect(drafts).toContain('Is this ready?');
    expect(drafts).toContain('<span class="chip muted">draft</span>');
    // Low emphasis means low ON THE PAGE too — it sits below the plan, not above it.
    expect(h.indexOf('<h2>The plan</h2>')).toBeLessThan(h.indexOf('<h2>Decisions being prepared</h2>'));
  });

  it('omits the ruled and draft sections entirely when there is nothing in them', () => {
    const h = render([COMPLETE]);
    expect(h).not.toContain('Ruled, queued');
    expect(h).not.toContain('Decisions being prepared');
  });

  it('treats a decision with no status recorded as still outstanding', () => {
    const m = buildModel({ ...SEED, decisions: [{ ...COMPLETE, status: undefined }] }, { fresh: true, fetchedAt: NOW, reason: null, rows: [] });
    expect(m.needsYou.decisions.map((d) => d.id)).toEqual(['other']);
  });

  it('escapes hostile content out of every new decision field', () => {
    const h = render([
      { id: 'x', title: 'X', question: '<img src=x>', why: '<img src=y>', options: [{ label: '<img src=z>', detail: '<b>d</b>' }], ifNothing: '<img src=w>', evidence: ['<img src=v>'] },
    ]);
    expect(h).not.toMatch(/<img src=[xyzwv]>/);
    expect(h).toContain('&lt;img src=v&gt;');
  });
});

/**
 * The operator answers these in chat — "R6 — as recommended". A number that comes from position means
 * nothing the next day, so the number has to be identity: assigned once, persisted, never renumbered, never
 * reused.
 */
describe('ruling numbers', () => {
  const st = (decisions, nextRuling) => ({ decisions, ...(nextRuling ? { nextRuling } : {}) });

  it('assigns R1, R2, … from the counter and records where the counter got to', () => {
    const s = st([{ id: 'a' }, { id: 'b' }]);
    expect(ensureRulingNumbers(s)).toBe(2);
    expect(s.decisions.map((d) => d.ruling)).toEqual(['R1', 'R2']);
    expect(s.nextRuling).toBe(3);
  });

  it('assigns ONCE — a second pass moves nothing, and reordering the list moves nothing either', () => {
    const s = st([{ id: 'a' }, { id: 'b' }]);
    ensureRulingNumbers(s);
    expect(ensureRulingNumbers(s)).toBe(0);
    s.decisions.reverse();
    ensureRulingNumbers(s);
    expect(s.decisions.find((d) => d.id === 'a').ruling).toBe('R1');
  });

  it('never reuses a retired number — a taken decision keeps R5 and the next one is R8', () => {
    const s = st([{ id: 'a', ruling: 'R5', status: 'taken' }, { id: 'b', ruling: 'R6' }, { id: 'c', ruling: 'R7' }], 8);
    s.decisions.push({ id: 'd' });
    ensureRulingNumbers(s);
    expect(s.decisions.at(-1).ruling).toBe('R8');
    expect(s.nextRuling).toBe(9);
  });

  // The counter used to be written back UNCONDITIONALLY from a default of 1, so a state file with R1/R2/R3
  // and no `nextRuling` key saved the counter as 1 — and the next three decisions were handed R1, R2, R3
  // again. The floor is the highest number present, always, whatever the counter says.
  it('never regresses the counter below the numbers already handed out', () => {
    const s = st([{ id: 'a', ruling: 'R1' }, { id: 'b', ruling: 'R2' }, { id: 'c', ruling: 'R3' }]); // no nextRuling key
    expect(ensureRulingNumbers(s)).toBe(0);
    expect(s.nextRuling).toBe(4);

    s.decisions.push({ id: 'd' });
    ensureRulingNumbers(s);
    expect(s.decisions.at(-1).ruling).toBe('R4');
  });

  // A hand-lowered counter is the same attack from the other side: the stored value is a FLOOR, never a
  // licence to reissue.
  it('ignores a counter that points below a number already in use', () => {
    const s = st([{ id: 'a', ruling: 'R7' }], 2);
    s.decisions.push({ id: 'b' });
    ensureRulingNumbers(s);
    expect(s.decisions.at(-1).ruling).toBe('R8');
    expect(s.nextRuling).toBe(9);
  });

  it('skips a number that is somehow already in use rather than minting a duplicate', () => {
    const s = st([{ id: 'a', ruling: 'R1' }, { id: 'b' }], 1);
    ensureRulingNumbers(s);
    expect(s.decisions[1].ruling).toBe('R2');
  });

  // Backfill goes ABOVE the highest number in use, in list order — it does not fill the gaps below it. A gap
  // is not free space: the most likely reason R1..R8 are absent while R9 is present is that they were used
  // and their decisions are gone, and handing R1 to something new is precisely the reuse the scheme forbids.
  // Numbers are identity, not a dense sequence, so skipping eight of them costs nothing.
  it('backfills entries that predate the scheme, in list order, above every number in use', () => {
    const s = st([{ id: '2978' }, { id: '2908', ruling: 'R9' }, { id: '2691' }]);
    ensureRulingNumbers(s);
    expect(s.decisions.map((d) => d.ruling)).toEqual(['R10', 'R9', 'R11']);
    expect(s.nextRuling).toBe(12);
  });

  it('resolves a decision by EITHER handle — the ruling number or the id it is filed under', () => {
    const s = st([{ id: '2978', ruling: 'R1' }]);
    expect(findDecision(s, 'R1').id).toBe('2978');
    expect(findDecision(s, 'r1').id).toBe('2978'); // the operator will not shift-key it
    expect(findDecision(s, '2978').ruling).toBe('R1');
    expect(findDecision(s, 'R9')).toBeNull();
  });

  it('renders BOTH handles — the number to answer with, the item number for the record', () => {
    const d = { id: '2691', ruling: 'R3', status: 'awaiting', question: 'Which tier?', options: [{ label: 'A', recommended: true }, { label: 'B' }], ifNothing: 'nothing' };
    const h = renderPage(buildModel({ ...SEED, items: [], decisions: [d] }, { fresh: true, fetchedAt: NOW, reason: null, rows: [] }));
    expect(h).toContain('<span class="rnum">R3</span>Which tier?');
    expect(h).toContain('answer as R3');
    expect(h).toContain('filed as #2691');
  });
});

/**
 * The template lives in exactly ONE place, and the realistic failure is not someone editing the HTML — it is
 * someone in a hurry hand-writing a page and publishing it to the board's URL. The marker makes that
 * detectable instead of merely forbidden.
 */
describe('the generated-page marker', () => {
  const real = () => renderPage(buildModel(SEED, { fresh: true, fetchedAt: NOW, reason: null, rows: [] }));

  it('accepts the script\'s own output', () => {
    const v = verifyPage(real());
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/fingerprint [0-9a-f]{16}/);
  });

  it('rejects a hand-written page outright', () => {
    const v = verifyPage('<title>Progress board</title><p>three clears and three rulings, trust me</p>');
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/NOT generated by the board script/);
  });

  it('rejects a page whose marker was copied onto edited content', () => {
    const h = real();
    const v = verifyPage(h.replace('Needs you', 'Needs you (hand-tweaked)'));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/does not match the marker and body/);
  });

  it('rejects a marker from a different schema, rather than trusting it', () => {
    const v = verifyPage(real().replace('schema=1', 'schema=99'));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/schema 99/);
  });

  it('counts the decisions in the marker, so a thinner page is visible from the marker alone', () => {
    expect(real()).toMatch(/decisions=1 /);
  });

  // The marker's own claims are only worth something if they are BOUND to the page. With the fingerprint
  // covering the body alone, a genuine page could be re-dated to 1999 and re-counted to 999 decisions and
  // still verify — the two fields the check actually prints back at the reader.
  it('binds the marker\'s own at= and decisions= into the fingerprint, not just the body', () => {
    const h = real();
    const redated = verifyPage(h.replace(/ at=\S+ /, ' at=1999-01-01T00:00:00.000Z '));
    expect(redated.ok).toBe(false);
    expect(redated.reason).toMatch(/does not match the marker and body/);

    const recounted = verifyPage(h.replace(/ decisions=\d+ /, ' decisions=999 '));
    expect(recounted.ok).toBe(false);
    expect(recounted.reason).toMatch(/does not match the marker and body/);
  });

  // The honest limit, asserted so nobody later "hardens" the wording back up: an unkeyed digest whose
  // algorithm ships in the same repository cannot distinguish a generated page from a carefully forged one.
  it('states plainly that a pass is not proof of authorship', () => {
    const v = verifyPage(real());
    expect(v.ok).toBe(true);
    expect(v.reason).toMatch(/UNKEYED/);
    expect(v.reason).toMatch(/NOT a deliberately forged page/);
  });
});

/**
 * The context fields are NOT optional, and that is the point: optional context means the next entry goes in
 * as a bare title and the page slides back into a list of one-liners nobody can act on. The tool enforces it
 * so nobody has to remember it.
 */
describe('the enforced decision contract', () => {
  const complete = () => ({
    id: 'x',
    status: 'awaiting',
    title: 'X',
    question: 'Do we?',
    options: [{ label: 'Yes', recommended: true }, { label: 'No' }],
    ifNothing: 'nothing moves',
  });

  it('names every missing piece, and nothing when the decision is answerable', () => {
    expect(decisionGaps(complete())).toEqual([]);
    expect(decisionGaps({ ...complete(), question: undefined })[0]).toMatch(/^question/);
    expect(decisionGaps({ ...complete(), ifNothing: undefined })[0]).toMatch(/^ifNothing/);
    expect(decisionGaps({})).toHaveLength(3);
  });

  it('demands at least two options — one option is an announcement, not a decision', () => {
    expect(decisionGaps({ ...complete(), options: [{ label: 'Yes', recommended: true }] })[0]).toMatch(/at least two, this has 1/);
    expect(decisionGaps({ ...complete(), options: [] })[0]).toMatch(/at least two, this has 0/);
  });

  it('demands exactly one recommendation — none and two are both wrong', () => {
    expect(decisionGaps({ ...complete(), options: [{ label: 'Yes' }, { label: 'No' }] })[0]).toMatch(/exactly one option marked recommended/);
    expect(
      decisionGaps({ ...complete(), options: [{ label: 'Yes', recommended: true }, { label: 'No', recommended: true }] })[0],
    ).toMatch(/exactly one option marked recommended/);
  });

  it('does not hold `why` or `evidence` hostage — a hard rule there would only train people to type filler', () => {
    expect(decisionGaps({ ...complete(), why: undefined, evidence: undefined })).toEqual([]);
  });

  it('only judges what is being ASKED — draft, queued and taken are exempt', () => {
    const bare = { id: 'bare', title: 'Bare' };
    for (const status of ['draft', 'queued', 'taken']) {
      expect(validateDecisions({ decisions: [{ ...bare, status }] })).toEqual([]);
    }
    expect(validateDecisions({ decisions: [{ ...bare, status: 'awaiting' }] })).toHaveLength(1);
  });
});

// ── The CLI ───────────────────────────────────────────────────────────────────

describe('CLI verbs', () => {
  it('renders with no verb at all', () => {
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^✓ rendered/);
    expect(r.out.split('\n')).toHaveLength(1); // one line, nothing more
    expect(existsSync(outPath)).toBe(true);
  });

  it('--start moves an item to in-progress and re-renders', () => {
    expect(cli('--start=alpha').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha')).toMatchObject({ status: 'in-progress', startedAt: '2026-08-08' });
    expect(page()).toContain('Alpha');
  });

  it('--start clears a blocker (this is how unblocking works)', () => {
    cli('--block=alpha', '--why=waiting on the gate');
    expect(state().items.find((i) => i.id === 'alpha').blocker).toBe('waiting on the gate');
    cli('--start=alpha');
    const it = state().items.find((i) => i.id === 'alpha');
    expect(it.status).toBe('in-progress');
    expect(it.blocker).toBeUndefined();
  });

  it('--done marks it done, and re-running never moves the recorded date', () => {
    cli('--done=alpha');
    const first = state().items.find((i) => i.id === 'alpha').doneAt;
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${outPath}`, '--no-gh', '--done=alpha'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: '2027-01-01T00:00:00.000Z', WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
    });
    expect(r.status).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').doneAt).toBe(first);
  });

  it('--block requires a reason and records it', () => {
    expect(cli('--block=alpha').code).toBe(1);
    const r = cli('--block=alpha', '--why=blocked on #984');
    expect(r.code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha')).toMatchObject({ status: 'blocked', blocker: 'blocked on #984' });
    expect(page()).toContain('blocked on #984');
  });

  it('--note sets a note and an empty --text clears it', () => {
    cli('--note=alpha', '--text=rebased onto main');
    expect(state().items.find((i) => i.id === 'alpha').note).toBe('rebased onto main');
    cli('--note=alpha', '--text=');
    expect(state().items.find((i) => i.id === 'alpha').note).toBeUndefined();
  });

  it('--add appends once — the same title twice is a no-op, not a duplicate', () => {
    cli('--add=Ship the drain rewrite', '--phase=1');
    expect(state().items.filter((i) => i.id === 'ship-the-drain-rewrite')).toHaveLength(1);
    const r = cli('--add=Ship the drain rewrite', '--phase=1');
    expect(r.out).toMatch(/already on the board/);
    expect(state().items.filter((i) => i.id === 'ship-the-drain-rewrite')).toHaveLength(1);
  });

  it('--decide takes a decision off the operator\'s section', () => {
    expect(cli('--decide=2978').code).toBe(0);
    expect(state().decisions[0]).toMatchObject({ status: 'taken', takenAt: '2026-08-08' });
    expect(page()).not.toContain('A decision');
  });

  it('--url stores the published artifact URL and prints it back on every later run', () => {
    cli('--url=https://claude.ai/public/artifacts/abc');
    expect(state().artifactUrl).toBe('https://claude.ai/public/artifacts/abc');
    expect(cli().out).toContain('https://claude.ai/public/artifacts/abc');
  });

  it('nags for the URL while none is stored', () => {
    expect(cli().out).toMatch(/no artifact URL stored yet/);
  });

  it('refuses an unknown id and names the ones it knows', () => {
    const r = cli('--start=nope');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no item "nope"');
    expect(r.err).toContain('alpha');
  });

  it('renders byte-identically when nothing changed (safe to run on every pass)', () => {
    cli();
    const first = page();
    cli();
    expect(page()).toBe(first);
  });
});

/**
 * A FIELD WITH NO VERB IS A HAND EDIT BY ANOTHER NAME. The PR body, `/board` and SKILL.md all say the state
 * file is never hand-edited *because every field has a verb* — but `items[].pr` (the join between the stored
 * half and the live half, and present on 6 of the 15 shipped rows), `phases`, `title` and `repo` had none,
 * and nothing could remove or retitle a row. The shipped state file therefore HAD to be hand-authored in
 * exactly the field the docs forbid. These are the missing verbs.
 */
describe('CLI verbs for the fields that had none', () => {
  const item = (id) => state().items.find((i) => i.id === id);

  it('--link joins a plan item to its pull request, and --unlink takes it off', () => {
    expect(cli('--link=alpha', '--pr=1234').code).toBe(0);
    expect(item('alpha').pr).toBe(1234);
    expect(page()).toContain('#1234');
    expect(cli('--link=alpha', '--pr=1234').out).toMatch(/already linked/); // idempotent

    expect(cli('--unlink=alpha').code).toBe(0);
    expect(item('alpha').pr).toBeUndefined();
    expect(cli('--unlink=alpha').out).toMatch(/no pull request linked/); // idempotent
  });

  it('--link demands a real pull-request number', () => {
    expect(cli('--link=alpha', '--pr=not-a-number').code).toBe(1);
    expect(cli('--link=alpha').code).toBe(1);
    expect(item('alpha').pr).toBeUndefined();
  });

  it('--retitle fixes a typo WITHOUT moving the id every other verb and the PR join use', () => {
    expect(cli('--retitle=alpha', '--to=Alpha, corrected').code).toBe(0);
    expect(item('alpha')).toMatchObject({ id: 'alpha', title: 'Alpha, corrected' });
    expect(cli('--retitle=alpha', '--to=Alpha, corrected').out).toMatch(/already titled/); // idempotent
    expect(cli('--retitle=alpha').code).toBe(1); // --to is not optional
  });

  it('--remove drops a row, so a typo\'d title stops inflating the plan total forever', () => {
    expect(state().items).toHaveLength(2);
    expect(cli('--remove=alpha').code).toBe(0);
    expect(state().items.map((i) => i.id)).toEqual(['beta']);
    const again = cli('--remove=alpha');
    expect(again.code).toBe(0); // idempotent
    expect(again.out).toMatch(/nothing to remove/);
  });

  it('--phase-title names a phase — the map `--add --phase=n` never writes', () => {
    expect(cli('--phase-title=2', '--to=Merge-gate correctness').code).toBe(0);
    expect(state().phases['2']).toBe('Merge-gate correctness');
    cli('--add=Something in phase two', '--phase=2');
    expect(page()).toContain('Phase 2 — Merge-gate correctness');
    expect(cli('--phase-title=2', '--to=Merge-gate correctness').out).toMatch(/already titled/);
    expect(cli('--phase-title=2', '--to=').out).toMatch(/title cleared/);
    expect(state().phases['2']).toBeUndefined();
    expect(cli('--phase-title=two', '--to=x').code).toBe(1);
  });

  it('--board-title and --repo bootstrap a board without a hand edit', () => {
    expect(cli('--board-title=The plan').code).toBe(0);
    expect(state().title).toBe('The plan');
    expect(page()).toContain('<h1>The plan</h1>');

    expect(cli('--repo=frontier-ui/frontierui').code).toBe(0);
    expect(state().repo).toBe('frontier-ui/frontierui');
    expect(cli('--repo=not a repo').code).toBe(1);
    expect(state().repo).toBe('frontier-ui/frontierui'); // the bad value never landed
    expect(cli('--repo=').out).toMatch(/repository cleared/);
    expect(state().repo).toBeNull();
  });

  it('--decision-remove drops a decision — the other repair that needed a hand edit', () => {
    expect(cli('--decision-remove=2978').code).toBe(0);
    expect(state().decisions).toHaveLength(0);
    const again = cli('--decision-remove=2978');
    expect(again.code).toBe(0); // idempotent
    expect(again.out).toMatch(/nothing to remove/);
  });

  /**
   * THE DEMONSTRATED REUSE. A state file holding R1/R2/R3 with no `nextRuling` key saved the counter back as
   * 1, so the numbers were re-issued; chained with a removal, a brand-new decision was handed R2 — and
   * `--decide=R2` is what the operator types in chat. The counter is reconciled from the file AS READ, before
   * the removal can delete the evidence, and it only ever moves forward.
   */
  it('retires a removed ruling number for good — the next decision never reuses it', () => {
    writeFileSync(
      statePath,
      JSON.stringify({
        ...SEED,
        nextRuling: undefined, // the key is simply absent, as in a hand-authored or older file
        decisions: [
          { id: 'd1', ruling: 'R1', title: 'One', status: 'queued' },
          { id: 'd2', ruling: 'R2', title: 'Two', status: 'queued' },
          { id: 'd3', ruling: 'R3', title: 'Three', status: 'queued' },
        ],
      }),
    );
    expect(cli('--decision-remove=R2').code).toBe(0);
    expect(state().decisions.map((d) => d.ruling)).toEqual(['R1', 'R3']);
    expect(state().nextRuling).toBe(4); // NOT 1, and not 3 — the counter never walks back

    expect(cli('--decision-add=A fourth call', '--question=Q?', '--if-nothing=nothing').code).toBe(0);
    expect(state().decisions.at(-1).ruling).toBe('R4');
  });

  it('a plain re-render never walks the counter back either', () => {
    writeFileSync(statePath, JSON.stringify({ ...SEED, nextRuling: undefined, decisions: [{ id: 'd1', ruling: 'R3', title: 'One', status: 'queued' }] }));
    expect(cli().code).toBe(0);
    expect(state().nextRuling).toBe(4);
  });

  it('--url refuses anything that is not a URL, including no value at all', () => {
    const empty = cli('--url');
    expect(empty.code).toBe(1);
    expect(empty.err).toMatch(/full published URL/);
    expect(state().artifactUrl).toBeNull(); // and NOT the literal string "true"

    expect(cli('--url=probably-a-url').code).toBe(1);
    expect(state().artifactUrl).toBeNull();
  });

  it('--url will not silently replace a stored URL — a minted duplicate cannot be undone', () => {
    cli('--url=https://claude.ai/public/artifacts/abc');
    expect(cli('--url=https://claude.ai/public/artifacts/abc').out).toMatch(/already stored/); // idempotent

    const clash = cli('--url=https://claude.ai/public/artifacts/xyz');
    expect(clash.code).toBe(1);
    expect(clash.err).toContain('already stored');
    expect(state().artifactUrl).toBe('https://claude.ai/public/artifacts/abc');

    expect(cli('--url=https://claude.ai/public/artifacts/xyz', '--force').code).toBe(0);
    expect(state().artifactUrl).toBe('https://claude.ai/public/artifacts/xyz');
  });

  it('does not tell the operator to "answer" a decision in a section that asks nothing', () => {
    cli('--decision-set=2978', '--field=status', '--value=queued');
    const h = page();
    expect(h).toContain('Ruled, queued');
    expect(h).toContain('ruled as R1');
    expect(h).not.toContain('answer as');
  });
});

/**
 * The decision verbs exist so the model NEVER hand-edits the state JSON — which is the only way the board
 * stays mechanical. Each one must be idempotent (a repeat re-states, never duplicates), must re-render, and
 * must print exactly one line.
 */
describe('CLI decision verbs', () => {
  const decision = (id = 'ship-it-or-not') => state().decisions.find((d) => String(d.id) === id);

  const ADD = ['--decision-add=Ship it or not', '--question=Do we ship the thing?', '--if-nothing=it never ships'];

  it('--decision-add lands as a DRAFT, and a repeat is a no-op', () => {
    const r = cli(...ADD);
    expect(r.code).toBe(0);
    expect(r.out.split('\n')).toHaveLength(1);
    expect(r.out).toMatch(/added decision ship-it-or-not \(draft\)/);
    // Draft, not awaiting: it has no options yet, so it is not answerable and must not reach the operator.
    expect(decision()).toMatchObject({ title: 'Ship it or not', question: 'Do we ship the thing?', ifNothing: 'it never ships', status: 'draft' });
    expect(page()).toContain('Decisions being prepared');

    const again = cli(...ADD);
    expect(again.out).toMatch(/already on the board: decision ship-it-or-not/);
    expect(state().decisions.filter((d) => d.id === 'ship-it-or-not')).toHaveLength(1);
  });

  it('--decision-add refuses a bare title — a title is not a decision', () => {
    const r = cli('--decision-add=Ship it or not');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--question');
    expect(r.err).toContain('--if-nothing');
    expect(state().decisions).toHaveLength(1); // nothing was written
  });

  it('--decision-add --status=queued records an ALREADY-RULED call without demanding a question', () => {
    // Recording an answer is a different act from asking a question, and is not held to the same bar.
    const r = cli('--decision-add=Converge daemon scheduling', '--id=2572', '--status=queued');
    expect(r.code).toBe(0);
    expect(decision('2572')).toMatchObject({ id: '2572', title: 'Converge daemon scheduling', status: 'queued' });
    expect(page()).toContain('#2572');
    expect(page()).toContain('Ruled, queued');
  });

  it('--decision-add --status=awaiting is held to the full contract', () => {
    const r = cli(...ADD, '--status=awaiting');
    expect(r.code).toBe(1);
    expect(r.err).toContain('ship-it-or-not');
    expect(r.err).toMatch(/at least two/);
  });

  it('refuses to flip a half-built decision to awaiting, naming the id and every gap', () => {
    cli(...ADD);
    const r = cli('--decision-set=ship-it-or-not', '--field=status', '--value=awaiting');
    expect(r.code).toBe(1);
    expect(r.err).toContain('"ship-it-or-not"');
    expect(r.err).toMatch(/at least two/);
    expect(decision().status).toBe('draft'); // refused BEFORE anything was written

    cli('--decision-option=ship-it-or-not', '--label=Ship', '--detail=go', '--recommend');
    expect(cli('--decision-set=ship-it-or-not', '--field=status', '--value=awaiting').code).toBe(1); // still one option
    cli('--decision-option=ship-it-or-not', '--label=Hold', '--detail=wait');
    const ok = cli('--decision-set=ship-it-or-not', '--field=status', '--value=awaiting');
    expect(ok.code).toBe(0);
    expect(decision().status).toBe('awaiting');
  });

  it('refuses to RENDER a board carrying an unanswerable awaiting decision, naming the id and the field', () => {
    // The guard the verbs cannot provide: an entry that predates the rule, or one written around the CLI.
    writeFileSync(statePath, JSON.stringify({ ...SEED, decisions: [{ id: '2691', title: 'Legacy', status: 'awaiting', detail: 'one line' }] }));
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.err).toContain('cannot be answered from the page');
    expect(r.err).toContain('"2691"');
    expect(r.err).toMatch(/missing question/);
    expect(r.err).toMatch(/ifNothing/);
    expect(r.err).toMatch(/--value=draft/); // and it says how to get unstuck
  });

  it('still SAVES the verb when the render is refused — otherwise the repair route is a deadlock', () => {
    writeFileSync(statePath, JSON.stringify({ ...SEED, decisions: [{ id: '2691', title: 'Legacy', status: 'awaiting' }] }));
    expect(cli('--decision-set=2691', '--field=question', '--value=What is it?').code).toBe(1); // still incomplete
    expect(state().decisions[0].question).toBe('What is it?'); // …but the edit landed
    expect(cli('--decision-set=2691', '--field=status', '--value=draft').code).toBe(0); // parking it clears the board
  });

  it('--decision-set writes one field, and an empty --value clears it', () => {
    cli('--decision-set=2978', '--field=why', '--value=the two sessions share an id');
    expect(state().decisions[0].why).toBe('the two sessions share an id');
    expect(page()).toContain('the two sessions share an id');
    cli('--decision-set=2978', '--field=why', '--value=');
    expect(state().decisions[0].why).toBeUndefined();
  });

  it('--decision-set is idempotent — setting the same value twice changes nothing', () => {
    cli('--decision-set=2978', '--field=ifNothing', '--value=nothing lands');
    const first = JSON.stringify(state());
    cli('--decision-set=2978', '--field=ifNothing', '--value=nothing lands');
    expect(JSON.stringify(state())).toBe(first);
  });

  it('--decision-set refuses a field with no verb and a status outside the lifecycle', () => {
    const bad = cli('--decision-set=2978', '--field=options', '--value=nope');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('own verbs');
    const worse = cli('--decision-set=2978', '--field=status', '--value=maybe');
    expect(worse.code).toBe(1);
    expect(worse.err).toContain(DECISION_STATUSES.join(', '));
    expect(DECISION_FIELDS).toContain('question');
  });

  it('--decision-set=queued takes a RULED decision out of "needs you" without hiding it', () => {
    cli('--decision-set=2978', '--field=status', '--value=queued');
    const r = cli();
    expect(r.out).toContain('(0 needs you'); // ruled, therefore not an ask
    expect(page()).toContain('Ruled, queued');
    expect(page()).toContain('A decision');
  });

  it('--decision-option appends, and the same label twice updates rather than duplicates', () => {
    const before = state().decisions[0].options.length;
    cli('--decision-option=2978', '--label=Do it', '--detail=costs a session');
    cli('--decision-option=2978', '--label=Drop it', '--detail=costs nothing');
    expect(state().decisions[0].options).toHaveLength(before + 2);
    const r = cli('--decision-option=2978', '--label=Do it', '--detail=costs a session');
    expect(r.out).toMatch(/option updated on 2978: Do it/);
    expect(state().decisions[0].options).toHaveLength(before + 2);
    expect(page()).toContain('costs a session');
  });

  it('--recommend marks exactly one option, and a second --recommend MOVES it', () => {
    cli('--decision-option=2978', '--label=Do it', '--detail=a', '--recommend');
    cli('--decision-option=2978', '--label=Drop it', '--detail=b');
    expect(state().decisions[0].options.filter((o) => o.recommended)).toHaveLength(1);
    cli('--decision-option=2978', '--label=Drop it', '--recommend');
    const recs = state().decisions[0].options.filter((o) => o.recommended);
    expect(recs.map((o) => o.label)).toEqual(['Drop it']);
    expect(page().match(/class="chip ok">recommended</g)).toHaveLength(1);
  });

  it('--decision-option demands a label', () => {
    const r = cli('--decision-option=2978', '--detail=orphaned');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--label');
  });

  // Labels match exactly, so re-wording an option adds a SECOND row and the page offers the operator the
  // same choice twice. Removal is the only mechanical repair — the alternative is hand-editing state.
  it('--decision-option-remove drops the superseded label and leaves the rest', () => {
    cli('--decision-option=2978', '--label=Do it now', '--detail=a re-wording that duplicated an option');
    expect(state().decisions[0].options).toHaveLength(3);
    const r = cli('--decision-option-remove=2978', '--label=Do it now');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/option removed from 2978: Do it now/);
    expect(state().decisions[0].options.map((o) => o.label)).toEqual(['Yes', 'No']);
    expect(page()).not.toContain('a re-wording that duplicated an option');
  });

  // Idempotent like every other verb — a second removal of the same label is a no-op, not a failure. It still
  // NAMES the options that are there, so a typo'd label is visible in the one line the model reads.
  it('--decision-option-remove is idempotent — a repeat is a no-op that names what is actually there', () => {
    expect(cli('--decision-option=2978', '--label=Maybe', '--detail=c').code).toBe(0);
    expect(cli('--decision-option-remove=2978', '--label=Maybe').code).toBe(0);
    const again = cli('--decision-option-remove=2978', '--label=Maybe');
    expect(again.code).toBe(0);
    expect(again.out).toContain('no option labelled "Maybe"');
    expect(again.out).toContain('options: Yes, No');
    expect(state().decisions[0].options).toHaveLength(2);
  });

  it('--decision-option-remove demands a label', () => {
    const r = cli('--decision-option-remove=2978');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--label');
  });

  // Removal is the one verb that can take a complete decision back to an incomplete one, so the same
  // enforcement that guards --decision-add has to catch it — both ways it can strand the page.
  it('removing down to one option is REFUSED by the answerable-from-the-page enforcement', () => {
    const r = cli('--decision-option-remove=2978', '--label=No');
    expect(r.code).toBe(1);
    expect(r.err).toContain('at least two');
  });

  it('removing the RECOMMENDED option is REFUSED — it leaves the page with no recommendation', () => {
    cli('--decision-option=2978', '--label=Maybe', '--detail=c');
    const r = cli('--decision-option-remove=2978', '--label=Yes');
    expect(r.code).toBe(1);
    expect(r.err).toContain('recommended');
  });

  it('--decision-evidence appends, dedups the same text, and an empty --text clears all of it', () => {
    cli('--decision-evidence=2978', '--text=row 3 currently PASSES');
    const again = cli('--decision-evidence=2978', '--text=row 3 currently PASSES');
    expect(again.out).toMatch(/evidence already on 2978/);
    expect(state().decisions[0].evidence).toEqual(['row 3 currently PASSES']);
    cli('--decision-evidence=2978', '--text=and row 4 does not');
    expect(state().decisions[0].evidence).toHaveLength(2);
    expect(page()).toContain('and row 4 does not');
    cli('--decision-evidence=2978', '--text=');
    expect(state().decisions[0].evidence).toBeUndefined();
  });

  it('names the decisions it knows when the id is wrong', () => {
    const r = cli('--decision-set=nope', '--field=why', '--value=x');
    expect(r.code).toBe(1);
    expect(r.err).toContain('no decision "nope"');
    expect(r.err).toContain('2978');
  });

  it('numbers every decision on the first run and never moves one afterwards', () => {
    cli();
    expect(state().decisions[0].ruling).toBe('R1');
    expect(state().nextRuling).toBe(2);
    cli(...ADD);
    expect(decision().ruling).toBe('R2');
    const before = JSON.stringify(state());
    cli();
    expect(JSON.stringify(state())).toBe(before); // the backfill is a one-time migration, not a per-run write
    expect(page()).toContain('<span class="rnum">R1</span>');
  });

  it('takes a verb by the ruling number the operator would actually type', () => {
    cli();
    expect(cli('--decide=R1').code).toBe(0);
    expect(state().decisions[0].status).toBe('taken');
    expect(cli('--decision-set=r1', '--field=detail', '--value=via the lowercase form').code).toBe(0);
    expect(state().decisions[0].detail).toBe('via the lowercase form');
  });

  it('names both handles when the id is wrong, so either one can be found', () => {
    cli();
    const r = cli('--decide=R99');
    expect(r.code).toBe(1);
    expect(r.err).toContain('R1/2978');
  });

  it('refuses an --id in the R-number namespace — those are the board\'s to hand out', () => {
    const r = cli('--decision-add=Squatter', '--id=R4', '--question=Q?', '--if-nothing=nothing');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/reserved/);
  });

  it('--verify says yes to its own output and no to a hand-written page', () => {
    cli();
    const good = spawnSync(process.execPath, [CLI, `--verify=${outPath}`], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).toContain('marker and body agree');

    const fake = join(sandbox, 'handrolled.html');
    writeFileSync(fake, '<title>Progress board</title><p>trust me</p>');
    const bad = spawnSync(process.execPath, [CLI, `--verify=${fake}`], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('is NOT the generated board');
  });

  // The two directions are not equally strong and the wording must not pretend otherwise: a FAILURE is
  // conclusive, a PASS is only "the marker and the body agree". The digest is unkeyed and its algorithm is in
  // the script the skill tells an agent to read, so a recomputed marker on hand-written content verifies —
  // that is a property of unkeyed digests, not a bug to be patched, and the check has to say so out loud.
  it('--verify does not claim to prove authorship — the unkeyed digest is named in the output', () => {
    cli();
    const good = spawnSync(process.execPath, [CLI, `--verify=${outPath}`], { encoding: 'utf8' });
    expect(good.status).toBe(0);
    expect(good.stdout).not.toContain('is the generated board');
    expect(good.stdout).toMatch(/UNKEYED/);
    expect(good.stdout).toMatch(/NOT a deliberately forged page/);
  });

  it('--decide still means TAKEN — the decision leaves the board entirely', () => {
    cli('--decision-set=2978', '--field=question', '--value=Do we?');
    cli('--decide=2978');
    expect(state().decisions[0]).toMatchObject({ status: 'taken' });
    expect(page()).not.toContain('Do we?');
    expect(page()).not.toContain('Ruled, queued');
  });

  it('re-rendering after the decision verbs is still byte-stable', () => {
    cli();
    const first = page();
    cli();
    expect(page()).toBe(first);
  });
});

describe('degradation when gh is unavailable', () => {
  it('still renders, with an empty pull-request half and a stale banner', () => {
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain('PR state STALE');
    expect(page()).toContain('class="banner"');
    expect(page()).toContain('Nothing landed yet.'); // no pull-request rows at all…
    expect(page()).toContain('A decision'); // …but the hand-maintained half still renders in full
  });

  it('serves the last good snapshot when one was cached', () => {
    writeFileSync(
      join(sandbox, '.progress-board-cache.json'),
      JSON.stringify({
        fetchedAt: '2026-08-07T09:00:00.000Z',
        rows: [{ number: 1099, title: 'Cached pull request', labels: ['review:human'], status: 'needs-human', detail: '' }],
      }),
    );
    const r = cli();
    expect(r.code).toBe(0);
    expect(page()).toContain('Cached pull request');
    expect(page()).toContain('snapshot from 2026-08-07 09:00 UTC');
    rmSync(join(sandbox, '.progress-board-cache.json'));
  });
});

/**
 * TWO `gh` CALLS MEAN THREE OUTCOMES, NOT TWO. `fetchPrs` only ever checked the open list, so with the
 * merged list failing (a rate limit, a per-endpoint 5xx) the board rendered a confident lie: no stale
 * banner, "pull-request state read live" in the header, "Nothing landed yet" under Landed, exit 0 — and the
 * truncated snapshot then OVERWROTE the cache, destroying the last good landed rows so the NEXT failure fell
 * back to a snapshot that was also missing them. Stripping `gh` from PATH only ever exercised total failure.
 */
describe('degradation when gh answers only half the question', () => {
  const bin = join(sandbox, 'fake-bin');
  const cacheFile = join(sandbox, '.progress-board-cache.json');
  const GOOD_CACHE = {
    fetchedAt: '2026-08-07T09:00:00.000Z',
    rows: [
      { number: 1000, title: 'Landed last week', labels: [], status: 'landed', detail: 'merged 2026-08-01' },
      { number: 1001, title: 'Landed yesterday', labels: [], status: 'landed', detail: 'merged 2026-08-07' },
    ],
  };

  beforeEach(() => {
    // A `gh` that answers --state=open and fails --state=merged. Nothing else about the run changes.
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\nfor a in "$@"; do [ "$a" = "--state=merged" ] && exit 1; done\n' +
        `echo '[{"number":1099,"title":"An open pull request","labels":[],"mergeStateStatus":"CLEAN","statusCheckRollup":[],"state":"OPEN"}]'\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    rmSync(cacheFile, { force: true });
  });
  afterAll(() => rmSync(cacheFile, { force: true }));

  /** The real CLI with the stub on PATH and the live lookup ENABLED — this is the only place gh is exercised. */
  const run = () =>
    spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${outPath}`], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '', PATH: `${bin}:${process.env.PATH}` },
    });

  it('says what it could not read instead of rendering the gap as a fact', () => {
    writeFileSync(cacheFile, JSON.stringify(GOOD_CACHE));
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PR state STALE');

    const h = page();
    expect(h).toContain('is <strong>stale</strong>');
    expect(h).toContain('merged-pull-request list could not be read');
    expect(h).not.toContain('pull-request state read live<'); // the header must not claim a full live read
    expect(h).toContain('An open pull request'); // …the half that DID come back is live
  });

  it('keeps the landed rows it could not re-read rather than reporting none', () => {
    writeFileSync(cacheFile, JSON.stringify(GOOD_CACHE));
    run();
    const h = page();
    expect(h).toContain('Landed last week');
    expect(h).toContain('Landed yesterday');
    expect(h).not.toContain('Nothing landed yet.');
  });

  it('never overwrites a more complete cache with the truncated snapshot', () => {
    writeFileSync(cacheFile, JSON.stringify(GOOD_CACHE));
    run();
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual(GOOD_CACHE);
  });

  it('says Landed is MISSING, not empty, when there is no snapshot to fall back on', () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(page()).toContain('MISSING, not empty');
    expect(existsSync(cacheFile)).toBe(false); // and still writes no half-cache
  });

  // Same class of lie from the other end: a list capped at the limit under-reports without saying so.
  it('says the open list may be truncated rather than quietly under-reporting', () => {
    const rows = Array.from(
      { length: 30 },
      (_, i) => `{"number":${2000 + i},"title":"PR ${i}","labels":[],"mergeStateStatus":"CLEAN","statusCheckRollup":[],"state":"OPEN"}`,
    );
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nfor a in "$@"; do [ "$a" = "--state=merged" ] && { echo '[]'; exit 0; }; done\necho '[${rows.join(',')}]'\n`,
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const r = run();
    expect(r.status).toBe(0);
    expect(page()).toContain('may be <strong>truncated</strong>');
    rmSync(cacheFile, { force: true });
  });
});

/**
 * `--out=` and `--state=` are the only paths a caller controls. Nothing in the state file or the GitHub data
 * reaches them, so this is not hostile-content-reachable — but an unguarded primitive that can overwrite a
 * tracked repo file is worth closing. The rule is deliberately narrow, because writing OUTSIDE the repo is
 * legitimate and in active use: the board is published from a scratchpad path.
 */
describe('path containment', () => {
  const REPO = join(ROOT, 'scripts', 'progress-board.mjs'); // any tracked file will do

  it('refuses a path inside the repository but outside reports/', () => {
    expect(() => assertWritablePath('./DECOY_TRACKED.json', '--out')).toThrow(/inside the repository/);
    expect(() => assertWritablePath(join(ROOT, 'package.json'), '--state')).toThrow(/only write/);
    // `..` out of an allowed directory is the same case and must not be a hole.
    expect(() => assertWritablePath(join(ROOT, 'reports', '..', 'package.json'), '--out')).toThrow(/inside the repository/);
  });

  it('allows reports/, where the board actually lives', () => {
    expect(assertWritablePath(join(ROOT, 'reports', 'progress-board.html'), '--out')).toBe(join(ROOT, 'reports', 'progress-board.html'));
    expect(assertWritablePath('reports/nested/deep.html', '--out')).toContain(join('reports', 'nested', 'deep.html'));
  });

  it('allows a path outside the repository entirely — the publish workflow depends on it', () => {
    expect(assertWritablePath(join(sandbox, 'board.html'), '--out')).toContain('board.html');
    expect(() => assertWritablePath(join(sandbox, 'state.json'), '--state')).not.toThrow();
  });

  it('the CLI refuses it too, and writes nothing', () => {
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, '--out=./DECOY_TRACKED.json', '--no-gh'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('refusing --out=');
    expect(existsSync(join(ROOT, 'DECOY_TRACKED.json'))).toBe(false);
    expect(readFileSync(REPO, 'utf8').length).toBeGreaterThan(0);
  });
});

/**
 * The `gh` half already degrades rather than dying; the hand-maintained half has to as well. The realistic
 * trigger is not exotic — the state file is git-tracked, so an unresolved merge-conflict marker makes it
 * invalid JSON, and crashing there loses the whole page over a fixable typo.
 */
describe('degradation when the state file is malformed', () => {
  const broken = (text) => {
    writeFileSync(statePath, text);
    return cli();
  };

  it('renders anyway when the file is not valid JSON, and says so on the PAGE, not only on stderr', () => {
    const r = broken('<<<<<<< HEAD\n{ "title": "x" }\n=======\n');
    expect(r.code).toBe(0);
    expect(r.out).toContain('STATE FILE UNREADABLE');
    expect(existsSync(outPath)).toBe(true);
    expect(page()).toContain('class="banner crit"');
    expect(page()).toContain('The plan and decisions could not be read');
    expect(page()).toContain('is not valid JSON');
  });

  it('renders anyway when items or decisions hold the wrong type', () => {
    const r = broken(JSON.stringify({ title: 'T', items: 'not an array', decisions: { a: 1 } }));
    expect(r.code).toBe(0);
    // PARTLY IGNORED, not UNREADABLE: the two words are the difference between "nothing survived" and
    // "one key was dropped and the rest of the plan below is real".
    expect(r.out).toContain('STATE FILE PARTLY IGNORED');
    expect(page()).toContain('wrong type for: items, decisions');
  });

  // The banner used to tell the operator "the plan half is missing, not empty" in BOTH branches. In the
  // wrong-type branch the plan half renders in full, so that sentence was simply false.
  it('does not claim the plan half is missing when it is right there on the page', () => {
    broken(JSON.stringify({ ...SEED, phases: 'not an object' }));
    const h = page();
    expect(h).toContain('class="banner crit"');
    expect(h).toContain('wrong type for: phases');
    expect(h).not.toContain('the plan half is missing, not empty');
    expect(h).toContain('Alpha'); // …because the plan half is, in fact, right there
    // And the fatal branch keeps the sentence, because there it is true.
    broken('{ not json');
    expect(page()).toContain('the plan half is missing, not empty');
  });

  it('a key the file is allowed to omit is not a type error — absent is not wrong', () => {
    // `items` omitted left the `[]` from the defaults and the length compare did `0 !== undefined`, so the
    // banner reported a wrong type for a key nobody had got wrong. One absent optional key then reached the
    // answerability guard, which used to switch itself off on any state error at all.
    writeFileSync(statePath, JSON.stringify({ title: 'T', decisions: [] }));
    const s = loadState(statePath);
    expect(s[STATE_ERROR]).toBeUndefined();
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('STATE FILE');

    writeFileSync(statePath, JSON.stringify({ title: 'T' })); // both optional keys absent
    expect(loadState(statePath)[STATE_ERROR]).toBeUndefined();
  });

  /**
   * THE HOLE THE SUITE USED TO REASON AROUND. The "does NOT swallow the decision contract" case uses a
   * WELL-FORMED file; the "wrong type" case uses a state with NO decisions. Their intersection — a soft type
   * error on one key, with `state.decisions` fully preserved — turned the render guard off entirely: the
   * unanswerable card rendered in "Needs you" and the run exited 0, republishing it on every pass, while
   * every verb was refused so the only way out was the hand edit the design forbids.
   */
  describe('a soft type error is not a licence to publish an unanswerable decision', () => {
    const SOFT = {
      title: 'Board',
      nextRuling: 5,
      phases: 'not an object', // the ONE thing wrong — decisions below survive untouched
      items: [{ id: 'a', title: 'An item', phase: 1, status: 'in-progress' }],
      decisions: [{ id: 'bad', ruling: 'R4', title: 'Should we ship it?', status: 'awaiting' }],
    };

    it('refuses to render, exactly as it would on a clean file', () => {
      writeFileSync(statePath, JSON.stringify(SOFT));
      const r = cli();
      expect(r.code).toBe(1);
      expect(r.err).toContain('cannot be answered from the page');
      expect(r.err).toContain('"bad"');
      expect(r.err).toMatch(/missing question/);
      expect(r.err).toMatch(/at least two/);
    });

    it('never writes the unanswerable card to the page', () => {
      writeFileSync(statePath, JSON.stringify(SOFT));
      cli();
      // Not "rendered without the card" — not rendered at all. Suppressing the decision while still
      // publishing would leave the operator a page that silently lost their ask.
      expect(existsSync(outPath)).toBe(false);
    });

    it('is NOT a deadlock — the verbs still work, because the surviving data is real', () => {
      writeFileSync(statePath, JSON.stringify(SOFT));
      // The whole reason a verb is refused on an unreadable file is that saving would overwrite a plan with
      // an empty one. Here the plan parsed; refusing the verb AND the render is what would strand it.
      const park = cli('--decision-set=bad', '--field=status', '--value=draft');
      expect(park.code).toBe(0);
      expect(state().decisions[0].status).toBe('draft');
      expect(cli().code).toBe(0); // and the board renders again
      expect(page()).toContain('Decisions being prepared');
    });

    it('still refuses every verb when NOTHING parsed — that file must not be overwritten', () => {
      writeFileSync(statePath, '{ not json');
      const r = cli('--decision-set=bad', '--field=status', '--value=draft');
      expect(r.code).toBe(1);
      expect(r.err).toContain('refusing to write');
      expect(readFileSync(statePath, 'utf8')).toBe('{ not json');
    });

    it('an unparseable file has no decisions, so the guard has nothing to wave through', () => {
      writeFileSync(statePath, '{ not json');
      const r = cli();
      expect(r.code).toBe(0); // degrades, as designed
      expect(page()).toContain('Nothing is waiting on you.');
      expect(page()).not.toContain('Should we ship it?');
    });
  });

  it('drops non-object entries rather than choking on them', () => {
    writeFileSync(statePath, JSON.stringify({ title: 'T', items: [{ id: 'a', title: 'A', status: 'todo' }, 'junk', null], decisions: [] }));
    const s = loadState(statePath);
    expect(s.items.map((i) => i.id)).toEqual(['a']);
    expect(s[STATE_ERROR]).toMatch(/entries that were not objects/);
  });

  it('REFUSES to apply a verb to an unreadable file — an empty save would destroy a recoverable plan', () => {
    const text = '{ not json';
    writeFileSync(statePath, text);
    const r = cli('--done=alpha');
    expect(r.code).toBe(1);
    expect(r.err).toContain('refusing to write');
    expect(readFileSync(statePath, 'utf8')).toBe(text); // byte-for-byte untouched
  });

  it('does NOT swallow the decision contract — a well-formed file with a half-decision still exits non-zero', () => {
    // Two different failures that must stay different: unreadable degrades, unanswerable refuses.
    writeFileSync(statePath, JSON.stringify({ ...SEED, decisions: [{ id: '2978', title: 'A decision', status: 'awaiting' }] }));
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.err).toContain('"2978"');
    expect(r.err).toContain('cannot be answered from the page');
    expect(r.err).not.toContain('STATE FILE UNREADABLE');
  });

  it('a missing state file is not an error at all — it is a fresh board', () => {
    rmSync(statePath);
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).not.toContain('STATE FILE UNREADABLE');
    expect(page()).toContain('Nothing is waiting on you.');
  });
});

/**
 * THE WORST BUG THIS TOOL HAS HAD, and the reason the soft branch's own rationale was wrong. That branch
 * argued verbs were safe because "nothing was lost — `state.items` and `state.decisions` are the file as
 * written". That is true for the keys that WERE arrays and false for the one key that triggered the branch:
 * `loadState` empties it, and `saveState` wrote the empty stand-in back over the file.
 *
 * So a single IDEMPOTENT NO-OP verb destroyed the plan. Not a typo'd verb, not a destructive one — a verb
 * that reported "already titled" and changed nothing. That is exactly the destruction the fatal branch
 * refuses every verb to prevent, and the page's banner denied it was happening.
 *
 * The rule these pin: the normalisation is RENDER-ONLY. A key the board could not read comes back out of
 * `saveState` byte-for-byte, and the verbs that would write to it are refused by name.
 */
describe('a key the board could not read is never written back over the file', () => {
  const OBJECT_MAP_ITEMS = {
    title: 'Board',
    nextRuling: 9,
    phases: { 1: 'Phase one' },
    // The shape a hand-authored JSON most naturally takes — and this file WAS hand-authored.
    items: {
      'gate-fix': { id: 'gate-fix', title: 'Fix the gate', phase: 1, status: 'in-progress', pr: 1101 },
      'drain-fix': { id: 'drain-fix', title: 'Fix the drain', phase: 1, status: 'todo' },
    },
    decisions: [{ id: 'd1', ruling: 'R8', title: 'A ruled thing', status: 'queued' }],
  };

  it('A VERB THAT CHANGES NOTHING CANNOT DESTROY ANYTHING — the no-op case, which is the one that bit', () => {
    writeFileSync(statePath, JSON.stringify(OBJECT_MAP_ITEMS));
    const r = cli('--board-title=Board'); // already titled exactly that: a pure no-op
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/already titled/); // …and it says so
    expect(r.out).toContain('STATE FILE PARTLY IGNORED');
    // Before the fix this read `"items": []` — both rows gone, permanently, at exit 0.
    expect(state().items).toEqual(OBJECT_MAP_ITEMS.items);
  });

  it('the same holds for decisions, and for a phases key of the wrong type', () => {
    const map = { d1: { id: 'd1', ruling: 'R1', title: 'one', status: 'queued' } };
    writeFileSync(statePath, JSON.stringify({ title: 'Board', items: [], decisions: map }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().decisions).toEqual(map);

    writeFileSync(statePath, JSON.stringify({ ...SEED, phases: 'not an object' }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().phases).toBe('not an object');
  });

  it('an entry that is not an object is unreadable, not disposable — it survives the save too', () => {
    // The array IS an array, so the container is fine; `loadState` drops the string so the page can render.
    // Dropping it on the way out of memory is normalisation; dropping it from the FILE is data loss.
    const decisions = ['R1 should we ship?', { id: 'd2', ruling: 'R2', title: 'two', status: 'queued' }];
    writeFileSync(statePath, JSON.stringify({ title: 'Board', items: [], decisions }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().decisions).toEqual(decisions);
  });

  it('refuses the verbs that WRITE the unreadable key, by name, and leaves the file byte-identical', () => {
    // The alternative to refusing is worse than it looks: the verb writes onto the emptied stand-in, reports
    // success, and the re-emit then silently drops its work.
    writeFileSync(statePath, JSON.stringify(OBJECT_MAP_ITEMS));
    const before = readFileSync(statePath, 'utf8');
    for (const argv of [['--done=gate-fix'], ['--add=A new row'], ['--remove=gate-fix'], ['--link=gate-fix', '--pr=7'], ['--rephase=gate-fix', '--phase=2']]) {
      const r = cli(...argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toContain('refusing to write items');
      expect(readFileSync(statePath, 'utf8'), argv.join(' ')).toBe(before);
    }
  });

  it('is NOT a deadlock — every verb that writes somewhere else still applies, and persists', () => {
    writeFileSync(statePath, JSON.stringify(OBJECT_MAP_ITEMS));
    expect(cli('--board-title=Renamed').code).toBe(0);
    expect(state().title).toBe('Renamed');
    expect(state().items).toEqual(OBJECT_MAP_ITEMS.items); // still there, alongside the applied edit
    expect(cli('--decision-set=d1', '--field=why', '--value=because').code).toBe(0);
    expect(state().decisions[0].why).toBe('because');
    expect(state().items).toEqual(OBJECT_MAP_ITEMS.items);
  });

  it('and a decision verb still works when it is ITEMS that are unreadable, and vice versa', () => {
    writeFileSync(statePath, JSON.stringify({ title: 'B', items: 'nope', decisions: [] }));
    expect(cli('--decision-add=Ship it?', '--question=Do we?', '--if-nothing=nothing').code).toBe(0);
    expect(state().items).toBe('nope');
    expect(state().decisions).toHaveLength(1);

    writeFileSync(statePath, JSON.stringify({ title: 'B', items: [{ id: 'a', title: 'A', status: 'todo' }], decisions: 'nope' }));
    expect(cli('--done=a').code).toBe(0);
    expect(state().items[0].status).toBe('done');
    expect(state().decisions).toBe('nope');
  });

  it('a clean file is completely unaffected — nothing is preserved that was read fine', () => {
    expect(cli('--done=alpha').code).toBe(0);
    expect(loadState(statePath)[STATE_UNREADABLE]).toBeUndefined();
    expect(state().items.find((i) => i.id === 'alpha').status).toBe('done');
  });
});

/**
 * The second half of the same root cause. `main` reconciled the ruling counter from the state AS LOADED, so
 * with `decisions` emptied by normalisation `ensureRulingNumbers` saw no numbers, computed a floor of 1, and
 * persisted `nextRuling: 1` into a file whose decisions already held R1, R2 and R3. The next `--decision-add`
 * handed out R1 again — and R-numbers are how the operator answers ("R1 — as recommended"), so a reused one
 * lands a ruling on the wrong decision.
 */
describe('the ruling counter is reconciled from the file as READ, not from what survived normalisation', () => {
  const MAP = {
    title: 'B',
    items: [],
    decisions: {
      d1: { id: 'd1', ruling: 'R1', title: 'one', status: 'queued' },
      d2: { id: 'd2', ruling: 'R2', title: 'two', status: 'queued' },
      d3: { id: 'd3', ruling: 'R3', title: 'three', status: 'queued' },
    },
  };

  it('A NUMBER STILL IN USE IS NEVER REISSUED, even through a key the board could not read', () => {
    writeFileSync(statePath, JSON.stringify(MAP));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().nextRuling).toBe(4); // was 1 — the reissue, written into the file
  });

  it('and the reissue itself is gone: repairing the file by hand then adding gets R4, not R1', () => {
    writeFileSync(statePath, JSON.stringify(MAP));
    cli('--board-title=Board');
    // The hand repair the refusal names — turn the map back into the array it should have been.
    const repaired = { ...state(), decisions: Object.values(MAP.decisions) };
    writeFileSync(statePath, JSON.stringify(repaired));
    expect(cli('--decision-add=A brand new thing', '--question=Q', '--if-nothing=X').code).toBe(0);
    const added = state().decisions.find((d) => d.id === 'a-brand-new-thing');
    expect(added.ruling).toBe('R4');
    expect(new Set(state().decisions.map((d) => d.ruling)).size).toBe(4); // all four distinct
  });

  it('rulingFloor reads a number out of whatever shape the file used', () => {
    expect(rulingFloor([{ ruling: 'R3' }, { ruling: 'R7' }])).toBe(8);
    expect(rulingFloor({ a: { ruling: 'R5' } })).toBe(6); // object-map VALUES
    expect(rulingFloor({ R6: { title: 'keyed by its number' } })).toBe(7); // …and its KEYS
    expect(rulingFloor(['R2 should we ship?'])).toBe(3); // a bare string entry, free text after the number
    expect(rulingFloor(undefined)).toBe(1);
    expect(rulingFloor('not decisions at all')).toBe(1);
    expect(rulingFloor([{ title: 'never numbered' }])).toBe(1);
  });

  it('a string entry that carries a retired number still holds the floor above it', () => {
    writeFileSync(statePath, JSON.stringify({ title: 'B', items: [], decisions: ['R4 was here', { id: 'd', ruling: 'R1', title: 'x', status: 'queued' }] }));
    expect(cli('--board-title=Board').code).toBe(0);
    expect(state().nextRuling).toBe(5);
  });

  it('the floor only ever raises — a clean file is numbered exactly as before', () => {
    expect(cli('--decision-add=Another', '--question=Q', '--if-nothing=X').code).toBe(0);
    expect(state().decisions.find((d) => d.id === 'another').ruling).toBe('R2'); // the seed's own decision is R1
  });
});

/**
 * `loadState` normalises the CONTAINER keys but never looks inside a decision, so a wrong type one level
 * down reached every reader raw: `options.length < 2` is false for a string (a string has a length), and
 * `options.filter(…)` then threw a raw `TypeError` stack trace out of the validator. It failed CLOSED, which
 * is the right direction — but dying contradicts `loadState`'s own degrade-rather-than-die contract and the
 * one-line-output contract the whole cost design rests on.
 */
describe('a wrong type one level down inside a decision degrades, and never crashes', () => {
  const withOptions = (options, over = {}) => ({
    ...SEED,
    decisions: [{ id: 'bad', title: 'Should we ship?', question: 'Do we ship?', ifNothing: 'nothing moves', status: 'awaiting', options, ...over }],
  });

  it('reports the gap in one line instead of a stack trace, and writes no page', () => {
    writeFileSync(statePath, JSON.stringify(withOptions('Yes, No')));
    const r = cli();
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('TypeError');
    expect(r.err).not.toMatch(/\n\s+at /); // no stack frames
    expect(r.err).toContain('cannot be answered from the page');
    expect(r.err).toContain('at least two, this has 0');
    expect(existsSync(outPath)).toBe(false);
  });

  it('a DRAFT one renders — the page degrades around it and the banner names the field', () => {
    writeFileSync(statePath, JSON.stringify(withOptions({ a: 'Yes' }, { status: 'draft' })));
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain('STATE FILE PARTLY IGNORED');
    expect(page()).toContain('decision &quot;bad&quot;.options');
    expect(page()).toContain('Should we ship?');
  });

  it('the same for a non-list evidence field', () => {
    writeFileSync(statePath, JSON.stringify(withOptions([{ label: 'Yes', recommended: true }, { label: 'No' }], { evidence: 'a single string' })));
    const r = cli();
    expect(r.code).toBe(0);
    expect(r.out).toContain('decision "bad".evidence');
    expect(page()).toContain('Do we ship?');
  });

  it('the WRITERS refuse cleanly rather than throwing — and never overwrite the field', () => {
    writeFileSync(statePath, JSON.stringify(withOptions('Yes, No', { status: 'draft' })));
    const before = readFileSync(statePath, 'utf8');
    for (const argv of [
      ['--decision-option=bad', '--label=Maybe'],
      ['--decision-option-remove=bad', '--label=Yes'],
    ]) {
      const r = cli(...argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).not.toContain('TypeError');
      expect(r.err).toContain('is not a list');
      expect(r.err).toContain('--decision-remove=bad'); // the route out that IS a verb
      expect(readFileSync(statePath, 'utf8'), argv.join(' ')).toBe(before);
    }
    // …and that route out really works, so this is not a dead end either.
    expect(cli('--decision-remove=bad').code).toBe(0);
    expect(state().decisions).toHaveLength(0);
  });

  it('--decision-evidence refuses the same way when it is EVIDENCE that is not a list', () => {
    // `d.evidence ??= []` does not fire on a string, and a string has `.includes` — so this walked all the
    // way to `.push` before throwing, with the verb already reported as applied.
    writeFileSync(statePath, JSON.stringify(withOptions([{ label: 'Yes', recommended: true }, { label: 'No' }], { status: 'draft', evidence: 'one string' })));
    const before = readFileSync(statePath, 'utf8');
    const r = cli('--decision-evidence=bad', '--text=something');
    expect(r.code).toBe(1);
    expect(r.err).not.toContain('TypeError');
    expect(r.err).toContain('is not a list');
    expect(readFileSync(statePath, 'utf8')).toBe(before);
  });
});

describe('--out and --state may not be the same file', () => {
  it('refuses the collision before anything is read or written', () => {
    const before = readFileSync(statePath, 'utf8');
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${statePath}`, '--no-gh'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('point at');
    expect(readFileSync(statePath, 'utf8')).toBe(before); // still JSON, not a page
  });

  it('and in the FATAL branch too — the one place the design promises never to overwrite a plan', () => {
    writeFileSync(statePath, '{ not json');
    const r = spawnSync(process.execPath, [CLI, `--state=${statePath}`, `--out=${statePath}`, '--no-gh'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
    });
    expect(r.status).toBe(1);
    expect(readFileSync(statePath, 'utf8')).toBe('{ not json'); // byte-for-byte
  });
});

/**
 * The last three fields in the file that no verb could reach. All are `??=`-set at the first transition, so
 * a `--done` on an item that was never `--start`ed pinned BOTH dates to the same day with no route back.
 * "Every field has a verb" is now literally true rather than nearly true.
 */
describe('--date corrects the three dates the board sets for you', () => {
  it('--start --date and --done --date write the real dates', () => {
    expect(cli('--start=alpha', '--date=2026-07-01').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBe('2026-07-01');
    expect(cli('--done=alpha', '--date=2026-07-09').code).toBe(0);
    const it_ = state().items.find((i) => i.id === 'alpha');
    expect(it_.startedAt).toBe('2026-07-01'); // not clobbered by the done
    expect(it_.doneAt).toBe('2026-07-09');
  });

  it('a correction is possible AFTER the date was already stamped — that was the whole gap', () => {
    cli('--done=alpha'); // stamps both to today, the unrecoverable state
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBe(NOW.slice(0, 10));
    expect(cli('--start=alpha', '--date=2026-06-02').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBe('2026-06-02');
    expect(cli('--done=alpha', '--date=2026-06-05').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').doneAt).toBe('2026-06-05');
  });

  it('--decide --date writes takenAt, and corrects it later', () => {
    expect(cli('--decide=2978').code).toBe(0);
    expect(state().decisions[0].takenAt).toBe(NOW.slice(0, 10));
    expect(cli('--decide=2978', '--date=2026-05-04').code).toBe(0);
    expect(state().decisions[0].takenAt).toBe('2026-05-04');
  });

  it('a date that is not a date is refused rather than stored', () => {
    for (const bad of ['--date=yesterday', '--date=2026-7-1', '--date']) {
      const r = cli('--start=alpha', bad);
      expect(r.code, bad).toBe(1);
      expect(r.err).toContain('YYYY-MM-DD');
    }
    expect(state().items.find((i) => i.id === 'alpha').startedAt).toBeUndefined();
  });
});

describe('--rephase moves a row by its id', () => {
  it('re-phases an existing item, idempotently', () => {
    expect(cli('--rephase=alpha', '--phase=2').code).toBe(0);
    expect(state().items.find((i) => i.id === 'alpha').phase).toBe(2);
    expect(cli('--rephase=alpha', '--phase=2').out).toMatch(/already in phase 2/);
  });

  it('demands a phase number and a known id', () => {
    expect(cli('--rephase=alpha').code).toBe(1);
    expect(cli('--rephase=alpha', '--phase=x').code).toBe(1);
    expect(cli('--rephase=nope', '--phase=2').code).toBe(1);
    expect(state().items.find((i) => i.id === 'alpha').phase).toBe(1);
  });
});

describe('pure helpers', () => {
  it('slugifies a title into a stable id', () => {
    expect(slugify('Ship the drain rewrite!')).toBe('ship-the-drain-rewrite');
    expect(slugify('  ')).toBe('item');
  });

  it('applyVerb rejects a verb it does not know', () => {
    expect(() => applyVerb({ items: [], decisions: [] }, 'teleport', {})).toThrow(/unknown verb/);
  });
});

// #xg790dh-follow-up (epic #3383/#4075) — LIVE INCIDENT 2026-09-26, PRs #2748/#2749/#2753 (chalbert/web-
// everything): the `ci:failed` label fallback xx6kg3f added (above, "trusts the durable ci:failed label…")
// closed a DEGRADED-rollup gap by trusting the label unconditionally — which also means a STALE label survives
// forever once THIS read's own rollup positively proves the required check green, since nothing ever re-checks
// it. Six ci-heal sessions in a row on PR #2748 correctly found only `review-gate` red (by design, while
// `review:pending` stood) and stood down, yet `classifyPr` kept reading `ci-red` off the stale label alone and
// reconcile-core kept dispatching another one. These pin the fix: the label fallback now defers to a rollup
// that AFFIRMATIVELY reports the required check's latest run as green, while still trusting the label exactly
// as before when the rollup cannot prove that (empty, degraded, or the check simply has not concluded).
describe('classifyPr — a stale ci:failed label must not outrank a rollup that already proves the required check green (xg790dh-follow-up)', () => {
  it('PR #2748\'s real shape: test green, only review-gate red, stale ci:failed label — reads needs-review, not ci-red', () => {
    const rollup = [
      { name: 'review-gate', conclusion: 'FAILURE' },
      { name: 'test-shard (1)', conclusion: 'SUCCESS' },
      { name: 'daemon-soak', conclusion: 'SUCCESS' },
      { name: 'smoke', conclusion: 'SUCCESS' },
      { name: 'test', conclusion: 'SUCCESS' },
    ];
    expect(classifyPr(pr({ labels: ['review:pending', 'ci:failed'], statusCheckRollup: rollup }))).toBe('needs-review');
  });

  it('a stale ci:failed beside a GREEN required check reads through to needs-review even with no review label at all', () => {
    const rollup = [{ name: 'test', conclusion: 'SUCCESS' }];
    expect(classifyPr(pr({ labels: ['ci:failed'], statusCheckRollup: rollup }))).toBe('open');
  });

  // we:backlog/heal-wait-for-rerun (landing-freeze fix, 2026-09-27) — SUPERSEDES the assertion this case used
  // to make. It used to expect `'ci-red'` here, on the theory that "not proven green" is reason enough to trust
  // a stale label. LIVE INCIDENT 2026-09-26/27 (web-everything/web-everything) proved that reasoning wrong: `main`
  // went red then green, the mechanical rebase (`ci-red-recovery-watch.mjs`) rebased each stuck PR onto the new
  // tip and re-ran CI, and every one of them still carried this exact shape — a STALE `ci:failed` label beside
  // a required check that had only just RESTARTED and not concluded yet. Trusting the label there dispatched a
  // wasted ci-heal (of ~10 such sessions inside one hour, 7 — PRs #2782/#2778/#2772/#2779/… — ended "no change
  // needed"). A check that is IN FLIGHT on the current head is evidence, not silence — it says "wait for it",
  // never "trust the old verdict". The genuinely-degraded case (no entry for the check at all) is a SEPARATE
  // population, pinned unchanged in the case right below.
  it('no longer trusts the label once the required check has RESTARTED and not concluded yet — waits instead (heal-wait-for-rerun)', () => {
    const rollup = [{ name: 'test', conclusion: '', state: 'IN_PROGRESS' }];
    expect(classifyPr(pr({ labels: ['review:pending', 'ci:failed'], statusCheckRollup: rollup }))).toBe('needs-review');
  });

  it('still trusts the label when the rollup has no entry for the required check at all (the xx6kg3f degraded-read case, unchanged)', () => {
    expect(classifyPr(pr({ labels: ['review:pending', 'ci:failed'], statusCheckRollup: [] }))).toBe('ci-red');
  });

  // PR #2787 review finding: a required check that CONCLUDED SKIPPED/NEUTRAL/STALE is terminal, not in flight —
  // it will never re-run, so it must not suppress the stale label the way a genuinely in-flight check does.
  // Otherwise the PR silently leaves `ci-red` (no heal, no escalation) and reads `queued` with a check that
  // never passed.
  it.each(['SKIPPED', 'NEUTRAL', 'STALE'])('still trusts the label when the required check concluded %s (terminal, never re-runs)', (conclusion) => {
    const rollup = [{ __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion }];
    expect(classifyPr(pr({ labels: ['review:accepted', 'ready-to-merge', 'ci:failed'], mergeStateStatus: 'CLEAN', statusCheckRollup: rollup }))).toBe('ci-red');
  });
});
