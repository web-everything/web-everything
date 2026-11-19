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
import { PR_STATUS_STATES } from '../conveyor/pr-status-label.mjs';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { outputMixRepo } from '../lib/__tests__/helpers/output-mix-repo.mjs';
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

import { ROOT, CLI, NOW, sandbox, statePath, outPath, SEED, cli, state, page, pr } from './helpers/progress-board-world.mjs';

describe('classifyPr', () => {
  it('flags a human-hold pull request as the operator\'s', () => {
    expect(classifyPr(pr({ labels: ['ready-to-merge', 'review:human'] }))).toBe('needs-human');
  });

  it('ranks a changes-requested pull request as the AUTHOR\'s, even when it also carries the human hold', () => {
    // The ball is with the author lane. Surfacing it to the operator would bury the PRs that truly await them.
    expect(classifyPr(pr({ labels: ['review:changes', 'review:human'] }))).toBe('bounced');
  });

  it('keeps sent-back PRs bounced despite stale readiness and a red-team block', () => {
    expect(classifyPr(pr({ labels: ['review:changes', 'status:ready-to-merge', 'red-team:blocked'] }))).toBe('bounced');
  });

  it.each([...PR_STATUS_STATES, 'awaiting-base', 'queued'])('does not derive queued from status:%s', status => {
    expect(classifyPr(pr({ labels: [`status:${status}`] }))).toBe('open');
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

  it('does not run the CLI when imported by another progress-board.mjs', () => {
    // The copied CLI's shared dependencies import the original board too. A basename-only entry guard
    // runs that original against the full checkout before the copied board ever reads its tiny fixture.
    const entry = join(sandbox, 'progress-board.mjs');
    writeFileSync(entry, `import ${JSON.stringify(pathToFileURL(CLI).href)};\nprocess.stdout.write('imported\\n');\n`);
    const r = spawnSync(process.execPath, [entry, '--help'], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(r.status, r.error?.message ?? r.stderr).toBe(0);
    expect(r.stdout).toBe('imported\n');
  }, 30_000);

  it.each(['directory', 'file'])('renders the CLI through a symlinked %s', (kind) => {
    const link = join(sandbox, `entry-${kind}`);
    symlinkSync(kind === 'directory' ? dirname(CLI) : CLI, link);
    const out = join(sandbox, `symlink-${kind}.html`);
    const r = spawnSync(process.execPath, [kind === 'directory' ? join(link, 'progress-board.mjs') : link,
      `--state=${statePath}`, `--out=${out}`, '--no-gh'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '1' },
      timeout: 20_000,
    });
    expect(r.status, r.error?.message ?? r.stderr).toBe(0);
    expect(existsSync(out), `CLI exited without writing the board: ${r.stdout}`).toBe(true);
    expect(readFileSync(out, 'utf8')).toContain('progress-board:generated');
  }, 30_000);

  /**
   * The one case that runs the REAL derivation through the CLI. Every other `cli()` call in this file forces
   * `WE_BOARD_NO_GIT=1` for runtime, which means `main()`'s own call into `computeOutputMix` — the ROOT it
   * resolves, the `today` it passes, the wiring into `buildModel` — is otherwise never executed under test.
   * Copy both entry points into a small real repository so their import.meta.url roots still agree, without
   * scanning the runner checkout's growing history. Other imports keep their original dependency trees.
   */
  it('runs the real git derivation end to end when it is NOT disabled', () => {
    const root = outputMixRepo(join(sandbox, 'output-mix-repo'));
    const scripts = join(root, 'scripts');
    mkdirSync(join(scripts, 'lib'), { recursive: true });
    for (const file of ['progress-board.mjs', 'lib/output-mix.mjs', 'lib/output-mix-paths.json']) {
      copyFileSync(join(ROOT, 'scripts', file), join(scripts, file));
    }
    for (const file of ['operations', 'merge-ai-prs.mjs', 'lib/rollup-collapse.mjs']) {
      symlinkSync(join(ROOT, 'scripts', file), join(scripts, file));
    }
    const r = spawnSync(process.execPath, [join(scripts, 'progress-board.mjs'), `--state=${statePath}`, `--out=${outPath}`, '--no-gh'], {
      encoding: 'utf8',
      env: { ...process.env, WE_BOARD_NOW: NOW, WE_BOARD_NO_GH: '1', WE_BOARD_NO_GIT: '' },
      timeout: 20_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const h = readFileSync(outPath, 'utf8');
    expect(h).toContain('Output mix');
    expect(h).not.toContain('could not be computed');
    // A real read produces grouped, signed figures in the machinery column — not the honest-note fallback.
    expect(h).toMatch(/Machinery \+ bookkeeping/);
    expect(h).toMatch(/>\+[\d,]+<\/div>/);
    expect(h).toContain('Week of 2026-08-03 so far.');
    expect(h).toContain('<div class="n">+2</div><div class="k">Product lines this week</div>');
    expect(h).toContain('<div class="n">+2</div><div class="k">Machinery + bookkeeping</div>');
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
