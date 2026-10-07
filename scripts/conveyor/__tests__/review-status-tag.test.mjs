/**
 * @file review-status-tag.test.mjs — `review-status:<state>` is purely informative, derived fresh from
 * `claude agents --json` on every read (never cached, never a second source of truth). PURE logic tests +
 * one IO test over injected fakes — no `claude`/`gh` process anywhere in this file.
 */
import { describe, it, expect } from 'vitest';

import { deriveReviewStatus, describeReviewState, planStatusLabelChange, tagReviewStatus, applyReviewStatus, STATUS_LABEL_RE } from '../review-status-tag.mjs';

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
  it('null (not stalled): a ci-heal-<pr> session marked selfReportedDone, even though its raw state is still blocked', () => {
    expect(deriveReviewStatus({ pr: 2852, agents: [{ name: 'ci-heal-2852', state: 'blocked', selfReportedDone: true }] }))
      .toBeNull();
  });

  it('null (not stalled): the same self-reported-done exclusion applies to a review/fix session, not only ci-heal', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'review-1765', state: 'blocked', selfReportedDone: true }] }))
      .toBeNull();
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'blocked', selfReportedDone: true }] }))
      .toBeNull();
  });

  it('null (not stalled): authExpired / idleFinished are the same upstream-fact exclusion as selfReportedDone', () => {
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'fix-1765', state: 'working', authExpired: true }] }))
      .toBeNull();
    expect(deriveReviewStatus({ pr: 1765, agents: [{ name: 'ci-heal-1765', state: 'blocked', idleFinished: true }] }))
      .toBeNull();
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
