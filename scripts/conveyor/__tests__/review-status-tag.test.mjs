/**
 * @file review-status-tag.test.mjs — `review-status:<state>` is purely informative, derived fresh from
 * `claude agents --json` on every read (never cached, never a second source of truth). PURE logic tests +
 * one IO test over injected fakes — no `claude`/`gh` process anywhere in this file.
 */
import { describe, it, expect } from 'vitest';
import { CONFIRMED_BREAKS_DEFAULTS, parseRedTeamComment, redTeamResultId, redTeamForHead } from '../../lib/red-team-gate.mjs';

import { reviewConcluded as reviewConcludedIo, deriveReviewStatus, describeReviewState, planStatusLabelChange, tagReviewStatus as tagReviewStatusIo, applyReviewStatus, STATUS_LABEL_RE } from '../review-status-tag.mjs';
const readConfirmedBreaks = () => ({ value: { ...CONFIRMED_BREAKS_DEFAULTS, findingClasses: {} } });
const readSealedStatus = () => null;
const reviewConcluded = (labels, subject, pr = subject?.number, options = {}) =>
  reviewConcludedIo(labels, subject, pr, { readConfirmedBreaks, readSealedStatus, ...options });
const tagReviewStatus = (options) => tagReviewStatusIo({
  readConfirmedBreaks, readSealedStatus, signalFix: () => {}, readRequiredChecks: () => ({ checks: undefined }), loadStatusSettings: () => { throw new Error('settings unavailable'); },
  ...options,
});

describe('deriveReviewStatus', () => {
  it('null when no agent is bound to this PR by name', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'conveyor-3412', state: 'working' }] })).toBeNull();
  });

  it('reviewing: a live review-<pr> session that is actually working', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'review-1765', state: 'working' }] }))
      .toEqual({ role: 'review', state: 'reviewing' });
  });

  it('review-stalled: a review-<pr> session that is blocked, not working', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'review-1765', state: 'blocked' }] }))
      .toEqual({ role: 'review', state: 'review-stalled' });
  });

  it('fixing: a live fix-<pr> session that is actually working', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'working' }] }))
      .toEqual({ role: 'fix', state: 'fixing' });
  });

  it('fix-stalled: a fix-<pr> session that is blocked, not working', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'blocked' }] }))
      .toEqual({ role: 'fix', state: 'fix-stalled' });
  });

  // `fixing-conflict` (draft reason at a glance, operator ask 2026-09-27, #2811 follow-up) — the ONE case a
  // `fix-<pr>` session's label gets a more specific name, deterministic off `mergeConflicted` (the caller's own
  // `pr.mergeStateStatus === 'DIRTY'` read — the SAME field `reconcile-core.mjs#classifyPr`'s `conflicted`
  // phase reads), never a fabricated guess at what the fixer is doing.
  it('fixing-conflict: a live fix-<pr> session on a PR GitHub itself reports as conflicting', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'working' }], mergeConflicted: true }))
      .toEqual({ role: 'fix', state: 'fixing-conflict' });
  });

  it('fixing-conflict-stalled: same, but the session is blocked, not working', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'blocked' }], mergeConflicted: true }))
      .toEqual({ role: 'fix', state: 'fixing-conflict-stalled' });
  });

  it('mergeConflicted defaults to false — every pre-existing call site (none of which pass it) still reads plain "fixing"', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'working' }] }))
      .toEqual({ role: 'fix', state: 'fixing' });
  });

  it('null for a `done` session — claude agents --json never prunes finished ones, and "done" is not "stuck"', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'review-1765', state: 'done' }] })).toBeNull();
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'done' }] })).toBeNull();
  });

  it('null for an unrecognized state — only working/blocked count as live', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'review-1765', state: 'idle' }] })).toBeNull();
  });

  it('review takes precedence when (implausibly) both a review and a fix session exist for the same PR', () => {
    const agents = [{ name: 'fix-1765', state: 'working' }, { name: 'review-1765', state: 'working' }];
    expect(deriveReviewStatus({ pr: 1765, agents })?.role).toBe('review');
  });

  it('picks the working entry over a stale sibling sharing the same name', () => {
    // claude agents --json never prunes finished sessions -- several "review-1765" rows can coexist.
    const agents = [{ name: 'review-1765', state: 'done' }, { name: 'review-1765', state: 'working' }];
    expect(deriveReviewStatus({ pr: 1765, agents })).toEqual({ role: 'review', state: 'reviewing' });
  });

  it('never matches a different PR number by accident', () => {
    expect(deriveReviewStatus({ pr: 176, agents: [{ name: 'review-1765', state: 'working' }] })).toBeNull();
  });

  // Live gap found 2026-09-26 (epic #4075/#3383): a `ci-heal-<pr>` session had NO representation in this
  // vocabulary at all — a PR mid-CI-heal carried no `review-status:*` label, indistinguishable from a PR
  // nothing is touching. `ci-heal` mints via the SAME `mintSessionSlug`/`PR_KINDS` machinery review/fix already
  // do (`we:scripts/conveyor/session-slug.mjs`), so the gap was purely this module never checking for it.
  it('healing-ci: a live ci-heal-<pr> session that is actually working', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'ci-heal-1765', state: 'working' }] }))
      .toEqual({ role: 'ci-heal', state: 'healing-ci' });
  });

  it('ci-heal-stalled: a ci-heal-<pr> session that is blocked, not working', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'ci-heal-1765', state: 'blocked' }] }))
      .toEqual({ role: 'ci-heal', state: 'ci-heal-stalled' });
  });

  // LIVE INCIDENT, we#2852, 2026-09-28: ci-heal-2852 genuinely finished (fix-end recorded, completion record
  // status:done, dispatch claim released) but `claude agents --json` still listed it `blocked` — the CLI never
  // prunes a finished row. `we:scripts/conveyor/reconcile-pass.mjs#defaultReadAgents` already stamps
  // `selfReportedDone: true` onto that exact row before handing it to this function; this pins that
  // `deriveReviewStatus` now honors that upstream fact instead of re-deriving liveness from the stale raw
  // `state` alone (mirroring `reconcile-core.mjs#assessLiveness`'s own `isFinished`).
  it('retains a blocked ci-heal row even when marked selfReportedDone', () => {
    expect(deriveReviewStatus({ pr: 2852, agents: [{ name: 'ci-heal-2852', state: 'blocked', selfReportedDone: true }] }))
      .toEqual({ role: 'ci-heal', state: 'ci-heal-stalled' });
  });

  it('retains blocked review and fix rows even when marked selfReportedDone', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'review-1765', state: 'blocked', selfReportedDone: true }] }))
      .toEqual({ role: 'review', state: 'review-stalled' });
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'blocked', selfReportedDone: true }] }))
      .toEqual({ role: 'fix', state: 'fix-stalled' });
  });

  it('null (not stalled): authExpired / idleFinished are the same upstream-fact exclusion as selfReportedDone', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'working', authExpired: true }] }))
      .toBeNull();
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'ci-heal-1765', state: 'blocked', idleFinished: true }] }))
      .toEqual({ role: 'ci-heal', state: 'ci-heal-stalled' });
  });

  it('a working sibling row for the SAME name still wins over a self-reported-done one, exactly like a done row', () => {
    const agents = [{ name: 'ci-heal-1765', state: 'blocked', selfReportedDone: true }, { name: 'ci-heal-1765', state: 'working' }];
    expect(deriveReviewStatus({ pr: 1765, agents })).toEqual({ role: 'ci-heal', state: 'healing-ci' });
  });

  it('a merely BLOCKED session with no self-report/authExpired/idleFinished marker still reads -stalled — the fix is upstream-fact-only, never a blanket "blocked is fine" change', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'ci-heal-1765', state: 'blocked' }] }))
      .toEqual({ role: 'ci-heal', state: 'ci-heal-stalled' });
  });

  it('DELIBERATE non-exclusion: a hung session still reads -stalled — this label exists to surface exactly that hazard to a human, unlike assessLiveness (whose job is "may I redispatch")', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'blocked', hung: true }] }))
      .toEqual({ role: 'fix', state: 'fix-stalled' });
  });

  it('a review or fix session takes precedence over a stale ci-heal row for the same PR', () => {
    const agents = [{ name: 'ci-heal-1765', state: 'working' }, { name: 'fix-1765', state: 'working' }];
    expect(deriveReviewStatus({ pr: 1765, agents })?.role).toBe('fix');
  });

  // The exact conflict-bounce fixture reported live at 14:45 ET on `web-everything/web-everything#2741`
  // (`review:changes` + `review-round:1` + `merge-status:conflicting`, mechanically bounced by
  // `we:scripts/conveyor/parked-pr-conflict-watch.mjs`) with its real `fix-2741` session, actually `working`.
  // The status sweep's candidate selection (`we:scripts/conveyor/reconcile-core.mjs#selectStatusCandidates`)
  // already includes every refusal unconditionally (fixed #4204 for `nothing-owed`, the same unconditional
  // inclusion covers a `live-process`/conflict-fix refusal here) — this pins that `deriveReviewStatus` itself
  // correctly derives `fixing` for that exact live session shape, independent of which reconcile branch it
  // reached this tick.
  it('fixing: PR #2741\'s real conflict-bounce fixture (review:changes + merge-status:conflicting, live fix-2741)', () => {
    const currentLabels = [{ name: 'review:changes' }, { name: 'review-round:1' }, { name: 'merge-status:conflicting' }];
    const agents = [{ name: 'fix-2741', state: 'working', pid: 12345 }];
    expect(deriveReviewStatus({ pr: 2741, agents })).toEqual({ role: 'fix', state: 'fixing' });
    expect(planStatusLabelChange({ status: deriveReviewStatus({ pr: 2741, agents }), currentLabels }))
      .toEqual({ add: 'review-status:fixing', remove: [] });
  });

  // draft-first PRs (operator-approved 2026-09-27) — a draft PR is never "reviewing"/"fixing"/"healing-ci" by
  // definition (dispatchReviewRow's own isDraft gate refuses a review dispatch), but it CAN still have a
  // genuinely live ci-heal session on it (a draft is never exempt from CI healing) — that must still win.
  it('awaiting-ci: a draft PR with nothing live', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [], isDraft: true })).toEqual({ role: 'draft', state: 'awaiting-ci' });
  });

  it('awaiting-ci: a draft PR even when a STALE (done/idle) session row sits under its name', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'review-1765', state: 'done' }], isDraft: true }))
      .toEqual({ role: 'draft', state: 'awaiting-ci' });
  });

  it('a genuinely live ci-heal session on a draft PR still reads healing-ci, not awaiting-ci', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'ci-heal-1765', state: 'working' }], isDraft: true }))
      .toEqual({ role: 'ci-heal', state: 'healing-ci' });
  });

  it('isDraft defaults to false — every pre-existing call site (none of which pass it) is unaffected', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [] })).toBeNull();
  });

  it('a non-draft PR with nothing live is still null, never awaiting-ci', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [], isDraft: false })).toBeNull();
  });

  // `fixing-conflict` (#2826 — a mechanical conflict-resolution round reads as more than the generic `fixing`;
  // merged here alongside the fix-claim states below since both PRs touch the same STATUS_LABEL_RE family).
  it('fixing-conflict: a live fix-<pr> session on a merge-conflicted PR', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'working' }], mergeConflicted: true }))
      .toEqual({ role: 'fix', state: 'fixing-conflict' });
  });

  it('fixing-conflict-stalled: a blocked fix-<pr> session on a merge-conflicted PR', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'blocked' }], mergeConflicted: true }))
      .toEqual({ role: 'fix', state: 'fixing-conflict-stalled' });
  });

  it('mergeConflicted defaults to false — every pre-existing call site is unaffected', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'working' }] }))
      .toEqual({ role: 'fix', state: 'fixing' });
  });

  // draft-only-on-withdrawal (backlog `xyfvtfz`) — a LIVE fix claim that drafted the PR reads back its OWN
  // recorded reason, so this reconciler's periodic pass matches exactly what `fix-begin` just applied and
  // never fights it (the sticky-label problem: without this, the next tick would see `fixClaim` truthy, derive
  // plain `fixing`, and `planStatusLabelChange` would strip `draft-scope-change`/`draft-withdrawn` as stale).
  it('draft-scope-change: a live fix claim recorded as drafted for scope-change', () => {
    expect(deriveReviewStatus({ pr: 2812, agents: [], fixClaim: { meta: { who: 'fix-2812', draft: true, reason: 'scope-change' } } }))
      .toEqual({ role: 'fix', state: 'draft-scope-change' });
  });

  it('draft-withdrawn: a live fix claim recorded as drafted for withdrawn', () => {
    expect(deriveReviewStatus({ pr: 2813, agents: [], fixClaim: { meta: { who: 'fix-2813', draft: true, reason: 'withdrawn' } } }))
      .toEqual({ role: 'fix', state: 'draft-withdrawn' });
  });

  it('a live fix claim with no recorded draft reason still reads plain fixing (or fixing-conflict)', () => {
    expect(deriveReviewStatus({ pr: 2811, agents: [], fixClaim: { meta: { who: 'rubric-worker', draft: false, reason: null } } }))
      .toEqual({ role: 'fix', state: 'fixing' });
    expect(deriveReviewStatus({ pr: 2811, agents: [], fixClaim: { meta: { who: 'rubric-worker', draft: false, reason: null } }, mergeConflicted: true }))
      .toEqual({ role: 'fix', state: 'fixing-conflict' });
  });

  it('an unrecognized reason on a drafted claim never fabricates a state — falls back to plain fixing', () => {
    expect(deriveReviewStatus({ pr: 2812, agents: [], fixClaim: { meta: { who: 'fix-2812', draft: true, reason: 'bogus' } } }))
      .toEqual({ role: 'fix', state: 'fixing' });
  });
});

describe('STATUS_LABEL_RE — the label family this module and fix-procedure.mjs both write to', () => {
  it('matches every state deriveReviewStatus can produce, plus the two draft-reason labels fix-begin applies directly', () => {
    const states = [
      'reviewing', 'review-stalled', 'fixing', 'fix-stalled', 'fixing-conflict', 'fixing-conflict-stalled',
      'healing-ci', 'ci-heal-stalled', 'awaiting-ci', 'draft-scope-change', 'draft-withdrawn',
    ];
    for (const s of states) expect(`review-status:${s}`).toMatch(STATUS_LABEL_RE);
  });

  it('does not match an unrelated label', () => {
    expect('review:pending').not.toMatch(STATUS_LABEL_RE);
    expect('review-status:bogus').not.toMatch(STATUS_LABEL_RE);
  });
});

describe('planStatusLabelChange', () => {
  it('adds a status label to a PR carrying none', () => {
    expect(planStatusLabelChange({ status: { state: 'reviewing' }, currentLabels: [] }))
      .toEqual({ add: 'review-status:reviewing', remove: [] });
  });

  it('is a no-op when already correct', () => {
    expect(planStatusLabelChange({ status: { state: 'reviewing' }, currentLabels: [{ name: 'review-status:reviewing' }] }))
      .toEqual({ add: null, remove: [] });
  });

  it('swaps a stale status for the new one', () => {
    expect(planStatusLabelChange({ status: { state: 'fixing' }, currentLabels: [{ name: 'review-status:reviewing' }] }))
      .toEqual({ add: 'review-status:fixing', remove: ['review-status:reviewing'] });
  });

  it('removes the label with NO replacement when nothing is live (status: null)', () => {
    expect(planStatusLabelChange({ status: null, currentLabels: [{ name: 'review-status:reviewing' }] }))
      .toEqual({ add: null, remove: ['review-status:reviewing'] });
  });

  it('is a no-op when nothing is live and no stale label exists either', () => {
    expect(planStatusLabelChange({ status: null, currentLabels: [{ name: 'review:pending' }] }))
      .toEqual({ add: null, remove: [] });
  });

  it('leaves every other label untouched', () => {
    const currentLabels = [{ name: 'review:pending' }, { name: 'review-status:fixing' }, { name: 'ready-to-merge' }];
    expect(planStatusLabelChange({ status: { state: 'reviewing' }, currentLabels }))
      .toEqual({ add: 'review-status:reviewing', remove: ['review-status:fixing'] });
  });
});

describe('describeReviewState — preserved draft-withdrawn', () => {
  it('reports draft-withdrawn instead of null when only that label is present', () => {
    expect(describeReviewState({ labels: ['review-status:draft-withdrawn'], status: null }))
      .toEqual({ code: 'draft-withdrawn', text: 'draft withdrawn' });
  });
});

describe('describeReviewState — one plain state instead of contradictory raw labels (#4967)', () => {
  const both = ['review:changes', 'review:human'];

  it('changes + human with a live fixer reads "fixing the send-back, then needs operator approval"', () => {
    for (const state of ['fixing', 'fixing-conflict']) {
      expect(describeReviewState({ labels: both, status: { role: 'fix', state } }))
        .toEqual({ code: 'fixing-then-human', text: 'fixing the send-back, then needs operator approval' });
    }
  });

  it('changes + human with a stalled fixer says the fix stalled', () => {
    for (const state of ['fix-stalled', 'fixing-conflict-stalled']) {
      expect(describeReviewState({ labels: both, status: { role: 'fix', state } }).text)
        .toBe('send-back fix stalled, then needs operator approval');
    }
  });

  it('changes + human with no fixer, or a non-fixer state, makes no fixer claim', () => {
    for (const status of [null, { role: 'review', state: 'reviewing' }, { role: 'ci-heal', state: 'healing-ci' }]) {
      expect(describeReviewState({ labels: both, status }).text)
        .toBe('send-back waiting for a fix, then needs operator approval');
    }
  });

  it('accepts {name} label objects, like planStatusLabelChange', () => {
    expect(describeReviewState({ labels: both.map((name) => ({ name })), status: { state: 'fixing' } }).code).toBe('fixing-then-human');
  });

  it('human only, or changes only, falls back to the single existing state (no false combination)', () => {
    expect(describeReviewState({ labels: ['review:human'], status: null })).toEqual({ code: 'review:human', text: 'review human' });
    expect(describeReviewState({ labels: ['review:changes'], status: null })).toEqual({ code: 'review:changes', text: 'review changes' });
    expect(describeReviewState({ labels: ['review:human'], status: { state: 'reviewing' } }))
      .toEqual({ code: 'reviewing', text: 'reviewing' });
    expect(describeReviewState({ labels: ['review:changes'], status: { state: 'fixing' } }).code).toBe('fixing');
  });

  it('no review state at all is null', () => {
    expect(describeReviewState({ labels: ['bug'], status: null })).toBeNull();
    expect(describeReviewState()).toBeNull();
  });
});

describe('tagReviewStatus — IO shell over injected fakes (no claude/gh process)', () => {
  it('publishes the combined state as reviewState — the #3490 replay (changes + human + fixing + advisory)', () => {
    const labels = ['review:changes', 'review:human', 'review-status:fixing', 'advisory:accepted'];
    const provider = { readLabels: () => labels, setLabels: () => {}, ensureLabel: () => {} };
    const result = tagReviewStatus({
      pr: 3490, repo: 'web-everything/web-everything', provider, currentLabels: labels,
      agents: [{ name: 'fix-3490', state: 'working' }], readFixClaim: () => null, prState: {},
    });
    expect(result.reviewState).toEqual({ code: 'fixing-then-human', text: 'fixing the send-back, then needs operator approval' });
  });

  const fakeProvider = (labels) => {
    const calls = [];
    return {
      calls,
      readLabels: (repo, pr) => { calls.push(['readLabels', repo, pr]); return labels; },
      setLabels: (repo, pr, spec) => { calls.push(['setLabels', repo, pr, spec]); },
      ensureLabel: (repo, name) => { calls.push(['ensureLabel', repo, name]); },
    };
  };

  it('tags a PR whose review is actively working, ensuring the label exists first', () => {
    const provider = fakeProvider([]);
    const listAgents = () => [{ name: 'review-42', state: 'working' }];
    const result = tagReviewStatus({ pr: 42, repo: 'web-everything/web-everything', listAgents, provider });
    expect(result).toEqual({ changed: true, label: 'review-status:reviewing', removed: [], reviewState: { code: 'reviewing', text: 'reviewing' } });
    expect(provider.calls).toEqual([
      ['readLabels', 'web-everything/web-everything', 42],
      ['ensureLabel', 'web-everything/web-everything', 'review-status:reviewing'],
      ['setLabels', 'web-everything/web-everything', 42, { add: 'review-status:reviewing', remove: [] }],
    ]);
  });

  it('clears a stale status label once the session is gone, adding nothing back (no ensureLabel call)', () => {
    const provider = fakeProvider([{ name: 'review-status:reviewing' }]);
    const listAgents = () => [];
    const result = tagReviewStatus({ pr: 42, repo: 'web-everything/web-everything', listAgents, provider });
    expect(result).toEqual({ changed: true, label: null, removed: ['review-status:reviewing'], reviewState: null });
    expect(provider.calls).toEqual([
      ['readLabels', 'web-everything/web-everything', 42],
      ['setLabels', 'web-everything/web-everything', 42, { add: undefined, remove: ['review-status:reviewing'] }],
    ]);
  });

  it('is idempotent — no write call when the label already matches live state', () => {
    const provider = fakeProvider([{ name: 'review-status:fixing' }]);
    const listAgents = () => [{ name: 'fix-42', state: 'working' }];
    const result = tagReviewStatus({ pr: 42, repo: 'web-everything/web-everything', listAgents, provider });
    expect(result).toEqual({ changed: false, label: 'review-status:fixing', removed: [], reviewState: { code: 'fixing', text: 'fixing' } });
    expect(provider.calls).toEqual([['readLabels', 'web-everything/web-everything', 42]]);
  });

  // draft-first PRs (operator-approved 2026-09-27)
  it('tags a draft PR awaiting-ci, even with a stale (done) review row sitting under its name', () => {
    const provider = fakeProvider([]);
    const listAgents = () => [{ name: 'review-42', state: 'done' }];
    const result = tagReviewStatus({ pr: 42, repo: 'web-everything/web-everything', listAgents, provider, isDraft: true });
    expect(result).toEqual({ changed: true, label: 'review-status:awaiting-ci', removed: [], reviewState: { code: 'awaiting-ci', text: 'awaiting ci' } });
    expect(provider.calls).toEqual([
      ['readLabels', 'web-everything/web-everything', 42],
      ['ensureLabel', 'web-everything/web-everything', 'review-status:awaiting-ci'],
      ['setLabels', 'web-everything/web-everything', 42, { add: 'review-status:awaiting-ci', remove: [] }],
    ]);
  });

  it('isDraft defaults to false — an omitted flag is byte-identical to before this option existed', () => {
    const provider = fakeProvider([]);
    const result = tagReviewStatus({ pr: 42, repo: 'web-everything/web-everything', listAgents: () => [], provider });
    expect(result).toEqual({ changed: false, label: null, removed: [], reviewState: null });
  });

  // #4133 (epic #3383/#4075) — a caller with the tick's own already-fetched `claude agents --json` listing and
  // PR labels (`we:skills-src/conveyor/review-daemon.mjs#runReviewTick`) skips BOTH re-fetches entirely.
  describe('agents / currentLabels — skip listAgents()/provider.readLabels() entirely when supplied', () => {
    it('never calls listAgents or provider.readLabels when both are supplied', () => {
      let listAgentsCalls = 0;
      const listAgents = () => { listAgentsCalls++; return []; };
      const provider = fakeProvider([{ name: 'should-never-be-read' }]);
      const result = tagReviewStatus({
        pr: 42, repo: 'web-everything/web-everything', listAgents, provider,
        agents: [{ name: 'review-42', state: 'working' }], currentLabels: [],
      });
      expect(result).toEqual({ changed: true, label: 'review-status:reviewing', removed: [], reviewState: { code: 'reviewing', text: 'reviewing' } });
      expect(listAgentsCalls).toBe(0);
      expect(provider.calls.map((c) => c[0])).toEqual(['ensureLabel', 'setLabels']); // no 'readLabels' call
    });

    it('is idempotent off the supplied data too — no write when it already matches', () => {
      const provider = fakeProvider([{ name: 'should-never-be-read' }]);
      const result = tagReviewStatus({
        pr: 42, repo: 'web-everything/web-everything', provider,
        agents: [{ name: 'review-42', state: 'working' }], currentLabels: [{ name: 'review-status:reviewing' }],
      });
      expect(result).toEqual({ changed: false, label: 'review-status:reviewing', removed: [], reviewState: { code: 'reviewing', text: 'reviewing' } });
      expect(provider.calls).toEqual([]);
    });

    it('omitting both reads fresh — byte-identical to before these options existed', () => {
      const provider = fakeProvider([]);
      const listAgents = () => [{ name: 'review-42', state: 'working' }];
      tagReviewStatus({ pr: 42, repo: 'web-everything/web-everything', listAgents, provider });
      expect(provider.calls[0]).toEqual(['readLabels', 'web-everything/web-everything', 42]);
    });
  });
});

describe('applyReviewStatus — dispatch-time variant, NO claude agents --json read at all (#3383 follow-up, live-caught 2026-09-26: a ci-heal for PR #2771 raced the exact listing-lag window this function exists to skip)', () => {
  const fakeProvider = (labels) => {
    const calls = [];
    return {
      calls,
      readLabels: (repo, pr) => { calls.push(['readLabels', repo, pr]); return labels; },
      setLabels: (repo, pr, spec) => { calls.push(['setLabels', repo, pr, spec]); },
      ensureLabel: (repo, name) => { calls.push(['ensureLabel', repo, name]); },
    };
  };

  it('applies a KNOWN state directly — no listAgents call exists on this function at all', () => {
    const provider = fakeProvider([]);
    const result = applyReviewStatus({ pr: 2771, repo: 'web-everything/web-everything', state: 'fixing', provider });
    expect(result).toEqual({ changed: true, label: 'review-status:fixing', removed: [] });
    expect(provider.calls).toEqual([
      ['readLabels', 'web-everything/web-everything', 2771],
      ['ensureLabel', 'web-everything/web-everything', 'review-status:fixing'],
      ['setLabels', 'web-everything/web-everything', 2771, { add: 'review-status:fixing', remove: [] }],
    ]);
  });

  it('is idempotent — no write call when the label already matches the known state', () => {
    const provider = fakeProvider([{ name: 'review-status:fixing' }]);
    const result = applyReviewStatus({ pr: 2771, repo: 'web-everything/web-everything', state: 'fixing', provider });
    expect(result).toEqual({ changed: false, label: 'review-status:fixing', removed: [] });
    expect(provider.calls).toEqual([['readLabels', 'web-everything/web-everything', 2771]]);
  });

  it('swaps a stale status for the new known one, same label home as tagReviewStatus', () => {
    const provider = fakeProvider([{ name: 'review-status:reviewing' }]);
    const result = applyReviewStatus({ pr: 2771, repo: 'web-everything/web-everything', state: 'fixing', provider });
    expect(result).toEqual({ changed: true, label: 'review-status:fixing', removed: ['review-status:reviewing'] });
  });

  it('currentLabels, when supplied, skips provider.readLabels entirely', () => {
    const provider = fakeProvider([{ name: 'should-never-be-read' }]);
    const result = applyReviewStatus({ pr: 2771, repo: 'web-everything/web-everything', state: 'fixing', provider, currentLabels: [] });
    expect(result).toEqual({ changed: true, label: 'review-status:fixing', removed: [] });
    expect(provider.calls.map((c) => c[0])).toEqual(['ensureLabel', 'setLabels']); // no 'readLabels' call
  });

  it('rejects a non-constellation repo, same guard as tagReviewStatus', () => {
    expect(() => applyReviewStatus({ pr: 2771, repo: 'other/repo', state: 'fixing' })).toThrow(/not a constellation repo/);
  });
});

it('tags only the matching repo session', () => {
  const agents = [{ name: 'review-fui-49', state: 'working' }];
  expect(deriveReviewStatus({ pr: 49, agents })).toBeNull();
  expect(deriveReviewStatus({ pr: 49, agents, repo: 'frontierui' })).toEqual({ role: 'review', state: 'reviewing' });
  const provider = { readLabels: () => [], ensureLabel: () => {}, setLabels: () => {} };
  expect(tagReviewStatus({ pr: 49, repo: 'frontier-ui/frontierui', listAgents: () => agents, provider }).label).toBe('review-status:reviewing');
  expect(() => tagReviewStatus({ pr: 49, repo: 'other/repo' })).toThrow(/not a constellation repo/);
});

it('shows head-scoped needs-human after the worker exits and clears it on a new head', async () => {
  const { buildCiHealEscalationComment } = await import('../ci-heal-escalation-mark.mjs');
  const comments = [{ author: { login: 'web-everything' }, body: buildCiHealEscalationComment({ headSha: 'abc', outcome: 'needs-human', reason: 'origin ref verified absent' }) }];
  const writes = [];
  const provider = { ensureLabel() {}, setLabels: (_r, _p, delta) => writes.push(delta) };
  const opts = { pr: 3154, repo: 'web-everything/web-everything', agents: [], provider, readFixClaim: () => null };
  expect(tagReviewStatus({ ...opts, currentLabels: ['review-status:fixing'], prState: { comments, headRefOid: 'abc' } }).label).toBe('review-status:needs-human');
  expect(tagReviewStatus({ ...opts, currentLabels: ['review-status:needs-human'], prState: { comments, headRefOid: 'def' } }).label).toBeNull();
  expect(writes.at(-1).remove).toContain('review-status:needs-human');
});


describe('xul2kwr automatic writers preserve withdrawal until explicit removal', () => {
  it.each([null, 'reviewing', 'awaiting-ci', 'draft-scope-change'])('preserves withdrawal over %s', state => {
    expect(planStatusLabelChange({ status: state ? { state } : null,
      currentLabels: [{ name: 'review-status:draft-withdrawn' }, 'review-status:fixing', 'unrelated'] }))
      .toEqual({ add: 'review-status:draft-withdrawn', remove: ['review-status:fixing'] });
  });
  it('both callers retain the hold over repeated claimless ticks and resume after removal', () => {
    let labels = ['review-status:draft-withdrawn'];
    const provider = {
      readLabels: () => labels, ensureLabel: () => {},
      setLabels: (_repo, _pr, { add, remove }) => { labels = labels.filter(l => !remove.includes(l)); if (add && !labels.includes(add)) labels.push(add); },
    };
    for (let tick = 0; tick < 5; tick++) {
      const tagged = tagReviewStatus({ pr: 3432, repo: 'web-everything/web-everything', provider, agents: [], isDraft: true, readFixClaim: () => null });
      expect(tagged.label).toBe('review-status:draft-withdrawn');
      for (const state of ['reviewing', null]) {
        expect(applyReviewStatus({ pr: 3432, repo: 'web-everything/web-everything', provider, state }).label).toBe('review-status:draft-withdrawn');
        expect(labels).toEqual(['review-status:draft-withdrawn']);
      }
    }
    labels = [];
    tagReviewStatus({ pr: 3432, repo: 'web-everything/web-everything', provider, agents: [], isDraft: true, readFixClaim: () => null });
    expect(labels).toEqual(['review-status:awaiting-ci']);
    applyReviewStatus({ pr: 3432, repo: 'web-everything/web-everything', provider, state: null });
    expect(labels).toEqual([]);
  });
});

it('draft stacks await their base; default-branch drafts await CI', () => {
  expect(deriveReviewStatus({ pr: 3915, isDraft: true, baseRefName: 'lane/base', defaultBranch: 'main' }))
    .toEqual({ role: 'draft', state: 'awaiting-base' });
  expect(deriveReviewStatus({ pr: 3915, isDraft: true, baseRefName: 'release', defaultBranch: 'release' }))
    .toEqual({ role: 'draft', state: 'awaiting-ci' });
  expect(STATUS_LABEL_RE.test('review-status:awaiting-base')).toBe(true);
  expect(planStatusLabelChange({ status: null, currentLabels: ['review-status:awaiting-base'] }).remove)
    .toEqual(['review-status:awaiting-base']);
});

it('uses the PR snapshot to tag awaiting-base and clears it on promotion', () => {
  const writes = [];
  const provider = {
    ensureLabel: (_repo, label, meta) => { expect(meta.description.length).toBeLessThanOrEqual(100); },
    setLabels: (_repo, _pr, change) => writes.push(change),
  };
  const result = tagReviewStatus({ pr: 3915, repo: 'we', agents: [], currentLabels: ['review-status:awaiting-ci'],
    prState: { isDraft: true, baseRefName: 'lane/base' }, defaultBranch: 'release', readFixClaim: () => null, provider });
  expect(result.label).toBe('review-status:awaiting-base');
  expect(writes[0]).toEqual({ add: 'review-status:awaiting-base', remove: ['review-status:awaiting-ci'] });
  applyReviewStatus({ pr: 3915, repo: 'we', state: null, currentLabels: [result.label], provider });
  expect(writes[1]).toEqual({ add: undefined, remove: ['review-status:awaiting-base'] });
});


describe('concluded head review with a lingering process', () => {
  const accepted = ['review:accepted', 'red-team:clear'];
  const headRefOid = 'ad05aa50' + 'a'.repeat(32);
  const now = Date.parse('2026-11-18T12:00:00Z');
  const comment = { author: { login: 'chalbert' }, createdAt: new Date(now - 180_000).toISOString(),
    body: `<!-- we:red-team-advisory pr=7099 rev=${headRefOid} -->\n\nRed team not required on this head: not owed (stored review)` };
  const gate = { author: comment.author, body: `<!-- we:red-team-gate pr=7099 rev=${headRefOid} outcome=no-send-back result=${redTeamResultId(parseRedTeamComment(comment.body))} -->` };
  const subject = { number: 7099, headRefOid, commentsComplete: true, comments: [gate, comment] };
  const row = { name: 'review-7099', state: 'working', pid: 12345, startedAt: now - 600_000 };
  const finished = { session: row.name, pid: row.pid, startedAt: new Date(row.startedAt).toISOString(),
    status: 'done', endedAt: new Date(now - 120_000).toISOString() };
  const derive = (fields = {}, options = {}) => deriveReviewStatus({ pr: 7099,
    reviewConcluded: reviewConcluded(accepted, subject), readReviewRecord: () => finished, now, agents: [{ ...row, ...fields }], ...options });

  it.each([undefined, false])('keeps reviews without commentsComplete=true (%j)', commentsComplete => {
    expect(reviewConcluded(accepted, { ...subject, commentsComplete })).toBe(false);
    expect(derive({}, { reviewConcluded: reviewConcluded(accepted, { ...subject, commentsComplete }) })?.state).toBe('reviewing');
  });
  it('keeps a blocked row even with its finished record and accepted verdict', () => {
    expect(derive({ state: 'blocked' })?.state).toBe('review-stalled');
    expect(derive({ state: 'blocked', selfReportedDone: true })?.state).toBe('review-stalled');
  });
  it('clears a working row with acceptance and its finished record', () => {
    expect(derive()).toBeNull();
  });
  it('clears a final verdict written for this head in the linked run only', () => {
    const run = { op: 'review-pr', findings: { read: { netBasis: { rev: headRefOid } } },
      verdict: { verdict: 'accept' }, stepTimings: [{ step: 'advise', finishedAt: finished.endedAt }] };
    const readReviewRecord = () => ({ ...finished, status: 'started', endedAt: null, run });
    expect(derive({}, { readReviewRecord })).toBeNull();
    run.findings.read.netBasis.rev = 'b'.repeat(40);
    expect(derive({}, { readReviewRecord })?.state).toBe('reviewing');
  });
  it.each([
    ['stale heartbeat', 120_001, 120_000, null],
    ['fresh heartbeat', 119_999, 120_000, 'reviewing'],
    ['timeout boundary', 120_000, 120_000, 'reviewing'],
    ['missing timeout', 180_000, undefined, 'reviewing'],
    ['invalid timeout', 180_000, 'bad', 'reviewing'],
    ['missing heartbeat', undefined, 120_000, 'reviewing'],
    ['invalid heartbeat', 'bad', 120_000, 'reviewing'],
  ])('%s requires the run own timeout and heartbeat', (_name, age, timeoutMs, expected) => {
    const heartbeatAt = typeof age === 'number' ? new Date(now - age).toISOString() : age;
    const result = derive({}, { readReviewRecord: () => ({ ...finished, status: 'started', endedAt: null, heartbeatAt, timeoutMs }) });
    expect(result?.state ?? null).toBe(expected);
  });
  it.each(['missing', 'unreadable'])('keeps a working row when its record is %s', mode => {
    expect(derive({}, { readReviewRecord: () => {
      if (mode === 'unreadable') throw Error('record unreadable');
      return null;
    } })?.state).toBe('reviewing');
  });
  it.each([{ pid: 999 }, { session: 'review-7105' }, { startedAt: now - 700_000 }])('keeps a row on another run record %j', fields => {
    expect(derive({}, { readReviewRecord: () => ({ ...finished, ...fields }) })?.state).toBe('reviewing');
  });
  it('requires both labels in either supported label shape', () => {
    expect(reviewConcluded(accepted, subject)).toEqual({ createdAt: comment.createdAt, head: headRefOid });
    expect(reviewConcluded(accepted.map(name => ({ name })), subject)).toEqual({ createdAt: comment.createdAt, head: headRefOid });
    expect(reviewConcluded(accepted, { ...subject, headRefOid: headRefOid.toUpperCase() })).toEqual({ createdAt: comment.createdAt, head: headRefOid });
  });
  it.each(['review:pending', 'review:changes', 'review:human', 'red-team:pending',
    'red-team:blocked', 'review-status:draft-withdrawn'])('fails closed on %s alongside acceptance', blocker => {
    expect(reviewConcluded([...accepted, blocker], subject)).toBe(false);
  });
  it.each([undefined, null, {}, [], ['review:accepted'], ['red-team:clear'],
    [...accepted, null], [...accepted, {}]])('fails closed on incomplete or malformed labels %j', labels => {
    expect(reviewConcluded(labels, subject)).toBe(false);
  });
  it.each([undefined, {}, { comments: [comment] }, { ...subject, headRefOid: '' },
    { ...subject, headRefOid: headRefOid.slice(0, 8) }, { ...subject, headRefOid: headRefOid + 'a' },
    { headRefOid }, { headRefOid, comments: [] }, { headRefOid, comments: {} },
    { ...subject, headRefOid: 'b'.repeat(40) },
    { ...subject, comments: [gate, { ...comment, author: { login: 'stranger' } }] },
    { ...subject, comments: [gate, { body: comment.body }] },
    { ...subject, comments: [gate, { ...comment, body: comment.body.replace(headRefOid, headRefOid.slice(0, 8)) }] },
  ])('fails closed on missing, stale, partial or untrusted head evidence %j', pr => {
    expect(reviewConcluded(accepted, pr)).toBe(false);
  });
  it('keeps timestamp-less working and blocked rows live despite current-head clearance', () => {
    expect(derive({ startedAt: undefined })?.state).toBe('reviewing');
    expect(derive({ startedAt: undefined, state: 'blocked' })?.state).toBe('review-stalled');
    expect(derive({}, { reviewConcluded: false })).toEqual({ role: 'review', state: 'reviewing' });
    expect(derive({}, { reviewConcluded: 'true' })?.state).toBe('reviewing');
  });
  it('uses the verdict age with an inclusive two-minute bound in epoch, numeric string and ISO shapes', () => {
    for (const createdAt of [now - 120_000, String(now - 120_000), new Date(now - 120_000).toISOString()]) {
      expect(derive({}, { reviewConcluded: { createdAt } })).toBeNull();
    }
    expect(derive({}, { reviewConcluded: { createdAt: now - 119_999 } })?.state).toBe('reviewing');
  });
  it.each([undefined, null, '', 'unreadable', Infinity, Number.MAX_VALUE, 0, now + 1])('retains the reviewing hold on invalid/future start or verdict timestamp %j', stamp => {
    expect(derive({ startedAt: stamp })?.state).toBe('reviewing');
    expect(derive({}, { reviewConcluded: { createdAt: stamp } })?.state).toBe('reviewing');
  });
  it('keeps a review started after or at the verdict live even when its start is older than two minutes', () => {
    expect(derive({ startedAt: now - 150_000 })?.state).toBe('reviewing');
    expect(derive({ startedAt: comment.createdAt })?.state).toBe('reviewing');
    expect(derive({}, { agents: [row, { ...row, startedAt: now - 150_000 }] })?.state).toBe('reviewing');
  });
  it('uses only startedAt, never updatedAt as the start or completion evidence', () => {
    expect(derive({ startedAt: undefined, updatedAt: now - 600_000 })?.state).toBe('reviewing');
    expect(derive({ updatedAt: now })).toBeNull();
  });
  it.each(['sent-back', 'round-cap', 'unknown', 'clear', 'future-outcome'])('keeps reviewing on the head gate outcome %s despite a clear gate', outcome => {
    const evidence = reviewConcluded(accepted, { ...subject, comments: [gate, comment,
      { ...gate, body: gate.body.replace('outcome=no-send-back', `outcome=${outcome}`) }] });
    expect(evidence).toBe(false);
    expect(derive({}, { reviewConcluded: evidence })?.state).toBe('reviewing');
  });
  it('allows card-queued gate evidence', () => {
    expect(reviewConcluded(accepted, { ...subject, comments: [
      { ...gate, body: gate.body.replace('outcome=no-send-back', 'outcome=card-queued') }, comment,
    ] })).toEqual({ createdAt: comment.createdAt, head: headRefOid });
  });
  it.each(['> ', 'quoted\n', '```\n'])('keeps reviewing when advisory markers are embedded behind %j', prefix => {
    const evidence = reviewConcluded(accepted, { ...subject, comments: [gate, { ...comment, body: prefix + comment.body }] });
    expect(evidence).toBe(false);
    expect(derive({}, { reviewConcluded: evidence })?.state).toBe('reviewing');
  });
  it('keeps reviewing on a wrong PR advisory marker or missing PR context', () => {
    expect(reviewConcluded(accepted, { ...subject, comments: [gate,
      { ...comment, body: comment.body.replace('pr=7099', 'pr=7105') }] })).toBe(false);
    expect(reviewConcluded(accepted, { ...subject, number: undefined })).toBe(false);
    expect(reviewConcluded(accepted, subject, 7105)).toBe(false);
  });
  it('ignores embedded and other-PR gates when complete advisory evidence needs no gate', () => {
    for (const body of [`quoted\n${gate.body}`, gate.body.replace('pr=7099', 'pr=7105')]) {
      expect(reviewConcluded(accepted, { ...subject, comments: [{ ...gate, body }, comment] }))
        .toEqual({ createdAt: comment.createdAt, head: headRefOid });
    }
  });
  it('allows complete advisory evidence without any gate record', () => {
    expect(reviewConcluded(accepted, { ...subject, comments: [comment] })).toEqual({ createdAt: comment.createdAt, head: headRefOid });
  });
  it.each(['unreadable', 'thrown'])('keeps reviewing when sealed evidence is %s despite clear comments', failure => {
    const reads = [];
    const result = tagReviewStatus({ pr: 7099, repo: 'we', agents: [row], prState: subject,
      currentLabels: [...accepted, 'review-status:reviewing'], readFixClaim: () => null,
      readSealedStatus: ({ repo, pr, head }) => {
        reads.push({ repo, pr, head });
        if (failure === 'thrown') throw new Error('sealed evidence unavailable');
        return { unreadable: true };
      },
      provider: { ensureLabel: () => {}, setLabels: () => {} },
    });
    expect(result.label).toBe('review-status:reviewing');
    expect(reads).toEqual([{ repo: 'web-everything/web-everything', pr: 7099, head: headRefOid }]);
  });
  it('keeps reviewing when a carried verdict source has an unreadable seal', () => {
    const from = 'b'.repeat(40), reads = [];
    const origin = { ...comment, body: comment.body.replace(headRefOid, from) };
    const carried = { ...comment, body: `<!-- review-verdict-carried from=${from} to=${headRefOid} patch-id=${'c'.repeat(40)} -->\nReview verdict carried across an identical contribution.\n${comment.body}` };
    const evidence = reviewConcluded(accepted, { ...subject, comments: [origin, carried] }, 7099, {
      readSealedStatus: ({ head }) => { reads.push(head); return head === from ? { unreadable: true } : null; },
    });
    expect(evidence).toBe(false);
    expect(reads).toEqual([headRefOid, from]);
    expect(derive({}, { reviewConcluded: evidence })?.state).toBe('reviewing');
  });
  it('keeps reviewing on incomplete advisory evidence, including a newest incomplete result', () => {
    const incomplete = { ...comment, createdAt: new Date(now - 150_000).toISOString(), body: comment.body.split('\n')[0] };
    for (const comments of [[gate, incomplete], [gate, comment, incomplete]]) {
      expect(reviewConcluded(accepted, { ...subject, comments })).toBe(false);
    }
  });
  it('keeps reviewing when an older card-queued result differs from the newest trusted advisory', () => {
    const newer = { ...comment, createdAt: new Date(now - 150_000).toISOString(),
      body: `${comment.body.split('\n')[0]}\n1. [not confirmed] (edge-case, degraded) \`scripts/x.mjs:1\` — newer result\nAdvisory only: red team · recorded verdict \`accept\`.` };
    const resultGate = { ...gate, body: gate.body.replace('outcome=no-send-back',
      'outcome=card-queued') };
    // Thread order in the array cannot make the older result the newest.
    expect(reviewConcluded(accepted, { ...subject, comments: [newer, resultGate, comment] })).toBe(false);
    const matching = { ...resultGate, body: resultGate.body.replace(
      redTeamResultId(parseRedTeamComment(comment.body)), redTeamResultId(parseRedTeamComment(newer.body))) };
    expect(reviewConcluded(accepted, { ...subject, comments: [newer, matching, comment] })).toEqual({ createdAt: newer.createdAt, head: headRefOid });
  });
  const findingResult = (impact = 'broken') => ({ ...comment,
    createdAt: new Date(now - 150_000).toISOString(),
    body: `${comment.body.split('\n')[0]}\n1. [**confirmed**] (edge-case, ${impact}) \`scripts/x.mjs:1\` — confirmed break\nAdvisory only: red team · recorded verdict \`changes\`.` });
  it('keeps reviewing for completed changes with a confirmed broken finding and no gate record', () => {
    expect(redTeamForHead([findingResult()], 7099, headRefOid)?.findings[0]?.confirmed).toBe(true);
    const evidence = reviewConcluded(accepted, { ...subject, comments: [findingResult()] });
    expect(evidence).toBe(false);
    expect(derive({}, { reviewConcluded: evidence })?.state).toBe('reviewing');
  });
  it('keeps reviewing when a newer verdict carry contains a confirmed break after an older policy-clear', () => {
    const broken = findingResult();
    const carried = { ...broken, body: `<!-- review-verdict-carried from=${'b'.repeat(40)} to=${headRefOid} patch-id=${'c'.repeat(40)} -->\nReview verdict carried across an identical contribution.\n${broken.body}` };
    const comments = [gate, comment, carried];
    expect(redTeamForHead(comments, 7099, headRefOid)?.findings[0]?.confirmed).toBe(true);
    const evidence = reviewConcluded(accepted, { ...subject, comments });
    expect(evidence).toBe(false);
    expect(derive({}, { reviewConcluded: evidence })?.state).toBe('reviewing');
  });
  it('clears a completed changes result with a card-queued degraded finding (PR 7105 shape)', () => {
    const degraded = findingResult('degraded');
    const card = { ...gate, body: `<!-- we:red-team-gate pr=7099 rev=${headRefOid} outcome=card-queued result=${redTeamResultId(parseRedTeamComment(degraded.body))} -->` };
    const evidence = reviewConcluded(accepted, { ...subject, comments: [degraded, card] });
    expect(evidence).toEqual({ createdAt: degraded.createdAt, head: headRefOid });
    expect(derive({}, { reviewConcluded: evidence })).toBeNull();
  });
  it('keeps reviewing for a confirmed degraded finding until its follow-up card is queued', () => {
    const evidence = reviewConcluded(accepted, { ...subject, comments: [findingResult('degraded')] });
    expect(evidence).toBe(false);
    expect(derive({}, { reviewConcluded: evidence })?.state).toBe('reviewing');
  });
  it('keeps reviewing when the confirmed-break policy read fails', () => {
    const evidence = reviewConcluded(accepted, subject, 7099, {
      readConfirmedBreaks: () => { throw new Error('unreadable policy'); },
    });
    expect(evidence).toBe(false);
    expect(derive({}, { reviewConcluded: evidence })?.state).toBe('reviewing');
  });
  it('standalone calls keep reviewing without a supplied complete daemon snapshot; supplied snapshots clear', () => {
    for (const supplied of [false, true]) {
      const result = tagReviewStatus({ pr: 7099, repo: 'we', agents: [row],
        ...(supplied ? { prState: subject } : {}), currentLabels: [...accepted, 'review-status:reviewing'],
        readReviewRecord: () => finished, readFixClaim: () => null, provider: { readPrState: () => subject, ensureLabel: () => {}, setLabels: () => {} } });
      expect(result.label).toBe(supplied ? null : 'review-status:reviewing');
    }
  });
  it('keeps live fix claims, fix sessions, CI healing and draft states', () => {
    expect(derive({}, { fixClaim: {} })).toEqual({ role: 'fix', state: 'fixing' });
    for (const [kind, state] of [['fix', 'fixing'], ['ci-heal', 'healing-ci']]) {
      expect(derive({}, { agents: [row, { name: `${kind}-7099`, state: 'working' }] })?.state).toBe(state);
    }
    expect(derive({}, { isDraft: true })?.state).toBe('awaiting-ci');
    expect(derive({}, { fixClaim: { meta: { draft: true, reason: 'withdrawn' } } })?.state).toBe('draft-withdrawn');
  });
  it('a failed label read throws before any label write', () => {
    const writes = [];
    expect(() => tagReviewStatus({ pr: 7099, repo: 'we', agents: [row], prState: {}, readFixClaim: () => null,
      provider: { readLabels: () => { throw new Error('labels unavailable'); },
        ensureLabel: (...args) => writes.push(args), setLabels: (...args) => writes.push(args) },
    })).toThrow('labels unavailable');
    expect(writes).toEqual([]);
  });
  it('ticks keep stale-head, missing-head, unstamped and blocked reviews live; current-head old rows become ready', async () => {
    const { default: scenario } = await import('../soak/breaks/concluded-review-lingering-process.mjs');
    expect(scenario.judge(await scenario.run({}))).toEqual([]);
  });
});
