/**
 * @file scripts/__tests__/merge-ai-prs-ai-detection-and-drain-ordering.test.mjs
 * @description Part of the merge-ai-prs.test.mjs split (originally one 4650-line file — see git history for the
 *   full-file description). This file covers: AI-authorship/classification detection, the classifyPr verdict
 *   (including the #2820 review-hold integrity gate), planLabelDrain's blockedBy/stackParents ordering (#2188,
 *   #2683, #xq985wu, #999/xq985wu liveness), joinImplToCouples, parseWatchOpts, and the drain lease gate
 *   (#2449/#2458) — all exported from `scripts/merge-ai-prs.mjs` (plus a couple from
 *   `scripts/lib/review-escalation.mjs`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { isAiAuthor, isAiCommit, isAiGeneratedPr, isMechanicalMergeCommit, isDrainBookkeepingCommit, isRequiredCheckGreen, hasLabel, classifyPr, revalidateForMerge, planLabelDrain, joinImplToCouples, parseWatchOpts, decideDrainLeaseGate, pickRunningBatches, readBatchFeed, decideBatchesIdleExit, applyEscalationRelief, matchesOnlyTarget, isDegradedOpenPrListing, OPEN_PR_LIST_LIMIT } from '../merge-ai-prs.mjs';
import { decideReviewGate, REVIEW_LABELS, READY_TO_MERGE_LABEL, decideParkReadyStrip } from '../lib/review-escalation.mjs';
import { acquireDrainLease, drainLeaseStatus, localRepoSlug } from '../readiness/drain-lock.mjs';
import { claudeCommit, humanCommit, aiPr } from './fixtures/merge-ai-prs-fixtures.mjs';

const mechMerge = { messageHeadline: "Merge branch 'main' into lane/x", messageBody: '', authors: [{ name: 'Nicolas Gilbert', email: 'nic@x.com' }] };


describe('merge-ai-prs — AI detection', () => {
  it('recognizes a Claude author by name or anthropic email', () => {
    expect(isAiAuthor({ name: 'Claude Opus 4.8', email: 'x' })).toBe(true);
    expect(isAiAuthor({ name: 'Bot', email: 'noreply@anthropic.com' })).toBe(true);
    expect(isAiAuthor({ name: 'Nicolas Gilbert', email: 'nic@x.com' })).toBe(false);
  });
  it('a commit is AI via a co-author OR a body trailer', () => {
    expect(isAiCommit(claudeCommit())).toBe(true);
    expect(isAiCommit({ authors: [{ name: 'Nic', email: 'n@x' }], messageBody: 'work\n\nCo-Authored-By: Claude <noreply@anthropic.com>' })).toBe(true);
    expect(isAiCommit(humanCommit)).toBe(false);
  });
  it('a PR is AI-generated only if EVERY substantive commit is AI (one human commit disqualifies it)', () => {
    expect(isAiGeneratedPr({ commits: [claudeCommit(), claudeCommit()] })).toBe(true);
    expect(isAiGeneratedPr({ commits: [claudeCommit(), humanCommit] })).toBe(false);
    expect(isAiGeneratedPr({ commits: [] })).toBe(false); // no commits ⇒ not qualifying
  });
  it('ignores mechanical `Merge branch` commits (from update-branch) — they do not disqualify an AI PR', () => {
    expect(isMechanicalMergeCommit(mechMerge)).toBe(true);
    expect(isMechanicalMergeCommit(claudeCommit())).toBe(false);
    // an AI PR that got a mechanical update-branch merge still qualifies
    expect(isAiGeneratedPr({ commits: [claudeCommit(), mechMerge] })).toBe(true);
    // but a mechanical merge alone (no substantive AI commit) does NOT qualify
    expect(isAiGeneratedPr({ commits: [mechMerge] })).toBe(false);
  });

  // Live-caught 2026-09-26 on `web-everything/web-everything#2741` (epic #4075/#3383): the drain lands a family of
  // bookkeeping commits directly onto `main` — `drain: JIT-number …→#NNNN at land (#2288)` / `drain: resolve
  // #NNNN on land (#2748)` — and a long-lived lane that merges a newer `main` into itself inherits them into
  // its OWN PR's `commits` list, alongside a real merge commit whose body is git's own auto-appended
  // `# Conflicts:` footer. Before the fix EITHER shape alone flipped `isAiGeneratedPr` to `false`, which (via
  // `merge-ai-prs.mjs`'s `ciLifecycleCertified` gate) silently disqualified an otherwise fully-AI PR from the
  // #2281-ratified ci-lifecycle reconcile — confirmed live: #2741 carried `review:pending, review-round:1`
  // only, no `checking`/`ci:failed`/`blocked`/`ready-to-merge` label at all, while `test`/`daemon-soak` were
  // IN_PROGRESS.
  it('a drain JIT-number/resolve bookkeeping commit does not disqualify an AI PR (#2741, drain: prefix)', () => {
    const drainJitNumber = { messageHeadline: 'drain: JIT-number x5wbsbc→#4217, xa4qo7n→#4218 at land (#2288)', messageBody: '', authors: [{ name: 'test', email: 'test@test.com' }] };
    const drainResolve = { messageHeadline: 'drain: resolve #4216 on land (#2748)', messageBody: '', authors: [{ name: 'test', email: 'test@test.com' }] };
    expect(isDrainBookkeepingCommit(drainJitNumber)).toBe(true);
    expect(isDrainBookkeepingCommit(drainResolve)).toBe(true);
    expect(isDrainBookkeepingCommit(claudeCommit())).toBe(false);
    expect(isAiGeneratedPr({ commits: [claudeCommit(), drainJitNumber, drainResolve] })).toBe(true);
    // a drain bookkeeping commit alone (no substantive AI commit) does NOT qualify
    expect(isAiGeneratedPr({ commits: [drainJitNumber] })).toBe(false);
  });

  it('a merge commit whose body is only git\'s auto-appended `# Conflicts:` footer is still mechanical (#2741)', () => {
    const mergeWithConflictFooter = {
      messageHeadline: "Merge remote-tracking branch 'origin/main'",
      messageBody: '# Conflicts:\n#\tscripts/conveyor/health-smells/index.mjs\n#\tscripts/conveyor/soak/breaks/index.mjs',
      authors: [{ name: 'test', email: 'test@test.com' }],
    };
    expect(isMechanicalMergeCommit(mergeWithConflictFooter)).toBe(true);
    expect(isAiGeneratedPr({ commits: [claudeCommit(), mergeWithConflictFooter] })).toBe(true);
    // a REAL authored body (not just the `#`-prefixed footer) still disqualifies shape 1 — unchanged behavior
    const mergeWithRealBody = { ...mergeWithConflictFooter, messageBody: 'resolved by keeping the health-smells rewrite\n\n# Conflicts:\n#\tfoo' };
    expect(isMechanicalMergeCommit(mergeWithRealBody)).toBe(false);
  });

  it('PR #2741\'s real inherited-commit shape (drain bookkeeping + conflict-footer merge + a genuine AI fix) is AI-generated end to end', () => {
    const commits = [
      claudeCommit({ messageHeadline: 'WE #x5wbsbc: fallback' }),
      { messageHeadline: 'drain: JIT-number xqpqyr2→#4216 at land (#2288)', messageBody: '', authors: [{ name: 'test', email: 'test@test.com' }] },
      { messageHeadline: 'drain: resolve #4216 on land (#2748)', messageBody: '', authors: [{ name: 'test', email: 'test@test.com' }] },
      { messageHeadline: "Merge remote-tracking branch 'origin/main'", messageBody: '# Conflicts:\n#\tscripts/conveyor/health-smells/index.mjs', authors: [{ name: 'test', email: 'test@test.com' }] },
      claudeCommit({ messageHeadline: 'WE #xrv69j6: address review:changes on PR #2741 — merge main, resolve conflict' }),
    ];
    expect(isAiGeneratedPr({ commits })).toBe(true);
  });

  // PR #2748 review:changes — the mechanical-shape predicates must match the drain's / git's EXACT generated
  // shapes, never a loose prefix, so authored content that merely LOOKS similar still disqualifies a PR.
  const drainAuthor = [{ name: 'test', email: 'test@test.com' }];
  const human = [{ name: 'Some Contributor', email: 'someone@example.com' }];

  it('isDrainBookkeepingCommit matches every real drain-generated headline (empty body)', () => {
    for (const messageHeadline of [
      'drain: JIT-number x5wbsbc→#4217, xa4qo7n→#4218 at land (#2288)',
      'drain: resolve #4216 on land (#2748)',
      'drain: unqueue + cleanup #4216 lane manifest post-land (#2175)',
      'drain: reopen stranded #4216 after failed land (#2175)',
      'drain: resolve epic #4075 on last-child #4216 land (#2752)',
      'drain: rebase lane/xg790dh-ci-lifecycle-drain-bookkeeping-commits onto origin/main, drop transient .lane-manifest.json',
      'drain: rebase lane/x-foo onto origin/main, auto-resolve non-overlapping content conflict(s) in a.mjs, b.mjs',
    ]) expect(isDrainBookkeepingCommit({ messageHeadline, messageBody: '', authors: drainAuthor }), messageHeadline).toBe(true);
    // gh truncates a long headline with `…` and moves the rest into the body — PR #2748's real captured shape
    const truncated = { messageHeadline: 'drain: rebase lane/xg790dh-ci-lifecycle-drain-bookkeeping-commits ont…', messageBody: '…o origin/main, drop transient .lane-manifest.json', authors: drainAuthor };
    expect(isDrainBookkeepingCommit(truncated)).toBe(true);
    expect(isDrainBookkeepingCommit({ ...truncated, messageBody: `${truncated.messageBody}\n\nand an authored note` })).toBe(false);
  });

  it('a free-form `drain: `-headlined commit is NOT bookkeeping — authored content cannot hide behind the prefix', () => {
    const humanDrainPrefixed = { messageHeadline: 'drain: manually patch the flaky soak test', messageBody: 'Rewrote the retry loop.', authors: human };
    const attacker = { messageHeadline: 'drain: totally not malicious, please ignore', messageBody: '', authors: [{ name: 'x', email: 'attacker@evil.com' }] };
    // a real drain template, but carrying an authored body — the drain only ever commits a single `-m` line
    const templateWithBody = { messageHeadline: 'drain: resolve #4216 on land (#2748)', messageBody: 'also fixed the flaky soak test', authors: human };
    for (const c of [humanDrainPrefixed, attacker, templateWithBody]) {
      expect(isDrainBookkeepingCommit(c), c.messageHeadline).toBe(false);
      expect(isAiGeneratedPr({ commits: [claudeCommit(), c] }), c.messageHeadline).toBe(false);
    }
  });

  it('only git\'s own trailing `# Conflicts:` block is stripped — `#`-formatted authored merge bodies stay substantive', () => {
    const merge = (messageBody) => ({ messageHeadline: "Merge branch 'main'", messageBody, authors: human });
    for (const body of [
      '# resolved by keeping the health-smells rewrite\n# dropped the old soak logic entirely', // markdown-ish, no footer
      '# Manually replaced the validation logic', // single markdown heading
      '# Manually replaced the validation logic\n\n# Conflicts:\n#\tfoo.mjs', // authored markdown BEFORE the footer
      '# Conflicts:\n#\tfoo.mjs\n# and then I rewrote foo by hand', // authored `#` line AFTER the footer
    ]) {
      expect(isMechanicalMergeCommit(merge(body)), body).toBe(false);
      expect(isAiGeneratedPr({ commits: [claudeCommit(), merge(body)] }), body).toBe(false);
    }
    // git's own footer alone (tab-indented paths, CRLF-tolerant) is still mechanical
    expect(isMechanicalMergeCommit(merge('# Conflicts:\r\n#\ta.mjs\r\n#\tb/c.mjs\r\n'))).toBe(true);
  });
});

describe('merge-ai-prs — green gate', () => {
  it('requires the `test` check to be SUCCESS; ignores cla/others', () => {
    expect(isRequiredCheckGreen(aiPr())).toBe(true);
    expect(isRequiredCheckGreen({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] })).toBe(false);
    expect(isRequiredCheckGreen({ statusCheckRollup: [{ name: 'cla', conclusion: 'SUCCESS' }] })).toBe(false); // test absent
  });
});

describe('merge-ai-prs — classifyPr verdict', () => {
  it('MERGES an AI PR that is green + mergeable (CLEAN or UNSTABLE)', () => {
    expect(classifyPr(aiPr({ mergeStateStatus: 'CLEAN' })).decision).toBe('merge');
    expect(classifyPr(aiPr({ mergeStateStatus: 'UNSTABLE' })).decision).toBe('merge'); // only non-required checks red
  });
  it('SKIPS a non-AI PR', () => {
    const v = classifyPr(aiPr({ commits: [claudeCommit(), humanCommit] }));
    expect(v.decision).toBe('skip'); expect(v.reason).toMatch(/not AI-generated/);
  });
  it('SKIPS when the required check is not green', () => {
    const v = classifyPr(aiPr({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] }));
    expect(v.decision).toBe('skip'); expect(v.reason).toMatch(/not green/);
  });
  it('SKIPS a BEHIND PR (needs rebase — never force-updated by the sweep)', () => {
    const v = classifyPr(aiPr({ mergeStateStatus: 'BEHIND' }));
    expect(v.decision).toBe('skip'); expect(v.reason).toMatch(/BEHIND|not landable|merge state/);
  });
  it('SKIPS a not-mergeable PR (conflicts)', () => {
    const v = classifyPr(aiPr({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
    expect(v.decision).toBe('skip'); expect(v.reason).toMatch(/not mergeable/);
  });
  // #2324 — refuse to land a PR with an empty/whitespace description (PR #206 landed bodyless).
  it('SKIPS a PR with an empty description', () => {
    const v = classifyPr(aiPr({ body: '' }));
    expect(v.decision).toBe('skip'); expect(v.reason).toMatch(/empty\/whitespace description/);
  });
  it('SKIPS a PR with a whitespace-only description', () => {
    expect(classifyPr(aiPr({ body: '   \n\t  ' })).decision).toBe('skip');
  });
  it('SKIPS a PR with no body field at all', () => {
    expect(classifyPr(aiPr({ body: undefined })).decision).toBe('skip');
  });
  it('MERGES a PR with a real description', () => {
    expect(classifyPr(aiPr({ body: 'fixes the thing because reasons' })).decision).toBe('merge');
  });
});

describe('merge-ai-prs — label-conditional AI gate (#2195, blockedBy #2196)', () => {
  const rtm = [{ name: 'ready-to-merge' }];
  const mixedCommits = { commits: [claudeCommit(), humanCommit] }; // one hand-authored commit ⇒ NOT every-commit-AI

  it('MERGES a labelled MIXED-authorship PR (the label certifies it — #40/#42 no longer skipped)', () => {
    const v = classifyPr(aiPr({ ...mixedCommits, labels: rtm }));
    expect(v.decision).toBe('merge');
    expect(v.aiGenerated).toBe(false);   // truthfully NOT every-commit-AI…
    expect(v.certifyLabel).toBe(true);   // …but the producer label certifies it
    expect(v.reason).toMatch(/producer-certified/);
  });

  it('SKIPS an UNLABELLED mixed-authorship PR (orphan sweep keeps the strict gate)', () => {
    const v = classifyPr(aiPr({ ...mixedCommits, labels: [] }));
    expect(v.decision).toBe('skip');
    expect(v.reason).toMatch(/not AI-generated/);
    expect(v.reason).toMatch(/no "ready-to-merge" label/);
  });

  it('a labelled PR still SKIPS on a red required check or a conflict (label is not a rubber stamp)', () => {
    expect(classifyPr(aiPr({ ...mixedCommits, labels: rtm, statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] })).decision).toBe('skip');
    expect(classifyPr(aiPr({ ...mixedCommits, labels: rtm, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).decision).toBe('skip');
  });

  it('MERGES a human-cleared parked PR (review:accepted) even with a non-AI commit and NO ready-to-merge label — the drain-rebase stranding fix (#2196/#2326)', () => {
    // The shape #745 hit: a review:accepted PR whose only non-AI commit is the drain's own `drain: rebase …`.
    const v = classifyPr(aiPr({ ...mixedCommits, labels: [{ name: REVIEW_LABELS.accepted }] }));
    expect(v.decision).toBe('merge');
    expect(v.aiGenerated).toBe(false);  // truthfully NOT every-commit-AI…
    expect(v.certifyLabel).toBe(false); // …and NOT ready-to-merge-labelled…
    expect(v.humanCleared).toBe(true);  // …but the human clear certifies it
    expect(v.reason).toMatch(/human-cleared/);
  });

  it('an un-accepted mixed-authorship PR (review:pending, not accepted) still SKIPS — the clear must be a human accept', () => {
    const v = classifyPr(aiPr({ ...mixedCommits, labels: [{ name: 'review:pending' }] }));
    expect(v.decision).toBe('skip');
    expect(v.humanCleared).toBe(false);
    expect(v.reason).toMatch(/not human-cleared/);
  });

  it('a human-cleared PR still SKIPS on a red required check (accept is not a rubber stamp)', () => {
    const v = classifyPr(aiPr({ ...mixedCommits, labels: [{ name: REVIEW_LABELS.accepted }], statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }] }));
    expect(v.decision).toBe('skip');
  });

  it('trustLabel:null forces the strict every-commit gate even when labelled', () => {
    const v = classifyPr(aiPr({ ...mixedCommits, labels: rtm }), { trustLabel: null });
    expect(v.decision).toBe('skip'); expect(v.certifyLabel).toBe(false);
  });

  it('hasLabel tolerates string labels, {name} labels, and a missing field', () => {
    expect(hasLabel({ labels: [{ name: 'ready-to-merge' }] }, 'ready-to-merge')).toBe(true);
    expect(hasLabel({ labels: ['ready-to-merge'] }, 'ready-to-merge')).toBe(true);
    expect(hasLabel({ labels: [{ name: 'other' }] }, 'ready-to-merge')).toBe(false);
    expect(hasLabel({}, 'ready-to-merge')).toBe(false);
    expect(hasLabel({ labels: [{ name: 'ready-to-merge' }] }, null)).toBe(false);
  });
});

// xvzc4v4 (merge-safety review, bug 1) — the merge decision was computed ONCE at pass-start and never re-checked
// against a fresh read right before the actual `gh pr merge`, so a push or a `review:changes` added mid-pass
// (the cascade can run for minutes on a busy queue) was invisible. `revalidateForMerge` re-runs the SAME
// `classifyPr` a caller uses against a fresh PR read; only `decision === 'merge'` on THAT fresh read clears a
// candidate to actually land.
describe('merge-ai-prs — revalidateForMerge (bug 1: re-check the merge decision against a FRESH read)', () => {
  it('a fresh read that still classifies "merge" clears the candidate', () => {
    const r = revalidateForMerge(aiPr(), {});
    expect(r.decision).toBe('merge');
  });
  it('a fresh read discovering a review:changes label added mid-pass now REFUSES the merge', () => {
    // The exact scenario named by the review: `classifyPr` at plan time saw no hold; a reviewer added
    // `review:changes` while this candidate's turn in the serial cascade was still pending. A stale decision
    // would merge anyway; the fresh re-read must not.
    const r = revalidateForMerge(aiPr({ labels: [{ name: 'review:changes' }] }), {});
    expect(r.decision).toBe('skip');
    expect(r.reviewHeld).toBe(true);
  });
  it('a fresh read discovering CI went red mid-pass now REFUSES the merge', () => {
    const redRollup = { contexts: { nodes: [{ name: 'test', conclusion: 'FAILURE' }] } };
    const r = revalidateForMerge(aiPr({ statusCheckRollup: redRollup }), {});
    expect(r.decision).toBe('skip');
  });
  it('a fresh read discovering a push made the PR no longer mergeable now REFUSES the merge', () => {
    const r = revalidateForMerge(aiPr({ mergeable: 'CONFLICTING' }), {});
    expect(r.decision).toBe('skip');
  });
  // FAIL CLOSED — a `gh` re-read miss must never be read as "still fine, merge it".
  it('a null freshPr (the gh re-read failed) fails CLOSED — never treated as still safe to merge', () => {
    const r = revalidateForMerge(null, {});
    expect(r.decision).toBe('skip');
    expect(r.reason).toMatch(/could not re-read/i);
  });
  it('a freshPr with no `number` (a malformed/empty gh reply) is treated the same as a read miss', () => {
    const r = revalidateForMerge({}, {});
    expect(r.decision).toBe('skip');
  });
  it('threads requiredCheck/allowPendingReview/defaultBranch through to classifyPr exactly as the pass-start call does', () => {
    // allowPendingReview lets a relieved review:pending PR through on the fresh read too, mirroring the
    // pass-start relief wiring (escalationRelief) — the fresh re-check must not silently drop that valve.
    const pending = aiPr({ labels: [{ name: 'review:pending' }] });
    expect(revalidateForMerge(pending, { allowPendingReview: false }).decision).toBe('skip');
    expect(revalidateForMerge(pending, { allowPendingReview: true }).decision).toBe('merge');
    // requiredCheck: the fixture's rollup is green on `test` only, so a nondefault required check must refuse —
    // dropping the forwarding would fall back to the default `test` and merge.
    expect(revalidateForMerge(aiPr(), { requiredCheck: 'lint' }).decision).toBe('skip');
    expect(revalidateForMerge(aiPr(), { requiredCheck: 'lint' }).reason).toMatch(/required check "lint"/);
    // defaultBranch: a PR based on `main` in a repo whose default branch is `develop` is off-default-base —
    // dropping the forwarding would fall back to `null` (no base check) and merge.
    const onMain = aiPr({ baseRefName: 'main' });
    expect(revalidateForMerge(onMain, {}).decision).toBe('merge');
    expect(revalidateForMerge(onMain, { defaultBranch: 'develop' }).decision).toBe('skip');
    expect(revalidateForMerge(onMain, { defaultBranch: 'develop' }).reason).toMatch(/base is not develop/);
  });

  // xvzc4v4 advisory fix — HEAD PIN. `classifyPr` sees label PRESENCE only: a `review:accepted` granted for head X
  // still reads as accepted after a push of Y. The merge is pinned to the head the pass-start decision judged.
  describe('expectedHeadSha pins the merge to the head the pass-start decision judged', () => {
    const accepted = (headRefOid) => aiPr({ headRefOid, labels: [{ name: 'review:accepted' }] });
    it('same head → merge, and the pinned SHA is returned for --match-head-commit', () => {
      const r = revalidateForMerge(accepted('aaa111'), { expectedHeadSha: 'aaa111' });
      expect(r.decision).toBe('merge');
      expect(r.headSha).toBe('aaa111');
    });
    it('a push since the pass-start decision (head moved) REFUSES, even with review:accepted still on the PR', () => {
      const r = revalidateForMerge(accepted('bbb222'), { expectedHeadSha: 'aaa111' });
      expect(r.decision).toBe('skip');
      expect(r.reason).toMatch(/head moved/);
      expect(r.headSha).toBeUndefined();
    });
    it('an unknown judged head (null) fails CLOSED', () => {
      expect(revalidateForMerge(accepted('aaa111'), { expectedHeadSha: null }).decision).toBe('skip');
    });
    it('a fresh read with no headRefOid fails CLOSED', () => {
      expect(revalidateForMerge(accepted(undefined), { expectedHeadSha: 'aaa111' }).decision).toBe('skip');
    });
    it('the pin never overrides a hold: same head but review:changes still refuses', () => {
      const r = revalidateForMerge(aiPr({ headRefOid: 'aaa111', labels: [{ name: 'review:changes' }] }), { expectedHeadSha: 'aaa111' });
      expect(r.decision).toBe('skip');
    });
    it('omitting expectedHeadSha skips the pin (and returns no headSha)', () => {
      const r = revalidateForMerge(accepted('bbb222'), {});
      expect(r.decision).toBe('merge');
      expect(r.headSha).toBeUndefined();
    });
  });
});

describe('merge-ai-prs — #2820 hold-integrity: an unsatisfied review hold blocks merge regardless of ready-to-merge', () => {
  const rtm = { name: 'ready-to-merge' };
  // An otherwise-perfectly-landable PR (AI, green, cleanly mergeable, real body, ready-to-merge): the ONLY
  // variable across these cases is the review label, so a `skip` proves the hold is what refused it — nothing else.
  const readyPr = (labels) => aiPr({ labels });

  it('SKIPS ready-to-merge + review:changes — the exact WE #956 state (the hold that must hold)', () => {
    const v = classifyPr(readyPr([rtm, { name: REVIEW_LABELS.changes }]));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(true);
    expect(v.certifyLabel).toBe(true);            // ready-to-merge IS present — proves the AND, not an OR
    expect(v.reason).toMatch(/unsatisfied review hold/);
    expect(v.reason).toMatch(/review:changes/);
    expect(v.reason).toMatch(/#2820/);
  });

  it('SKIPS review:human + ready-to-merge — a human-only gate is never cleared by ready-to-merge', () => {
    const v = classifyPr(readyPr([rtm, { name: REVIEW_LABELS.human }]));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(true);
    expect(v.reason).toMatch(/unsatisfied review hold/);
    expect(v.reason).toMatch(/review:human/);
  });

  it('SKIPS review:pending + ready-to-merge (not relieved) — an owed independent review still holds', () => {
    const v = classifyPr(readyPr([rtm, { name: REVIEW_LABELS.pending }]));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(true);
    expect(v.reason).toMatch(/review:pending/);
  });

  it('MERGES ready-to-merge + review:accepted — a satisfied review clears the hold', () => {
    const v = classifyPr(readyPr([rtm, { name: REVIEW_LABELS.accepted }]));
    expect(v.decision).toBe('merge');
    expect(v.reviewHeld).toBe(false);
    expect(v.reason).toMatch(/producer-certified/);
  });

  it('MERGES ready-to-merge alone (no review label at all) — unchanged pre-#2820 behaviour', () => {
    const v = classifyPr(readyPr([rtm]));
    expect(v.decision).toBe('merge');
    expect(v.reviewHeld).toBe(false);
  });

  it('review:accepted WINS over a coexisting review:changes (matches decideReviewGate: the reviewer verdict wins)', () => {
    const v = classifyPr(readyPr([rtm, { name: REVIEW_LABELS.changes }, { name: REVIEW_LABELS.accepted }]));
    expect(v.decision).toBe('merge');
    expect(v.reviewHeld).toBe(false);
  });

  it('allowPendingReview (the #2423 per-PR relief valve) waives review:pending to a merge…', () => {
    const v = classifyPr(readyPr([rtm, { name: REVIEW_LABELS.pending }]), { allowPendingReview: true });
    expect(v.decision).toBe('merge');
    expect(v.reviewHeld).toBe(false);
  });

  it('…but relief NEVER waives review:changes or review:human (still held even when relieved)', () => {
    expect(classifyPr(readyPr([rtm, { name: REVIEW_LABELS.changes }]), { allowPendingReview: true }).decision).toBe('skip');
    expect(classifyPr(readyPr([rtm, { name: REVIEW_LABELS.human }]), { allowPendingReview: true }).decision).toBe('skip');
  });

  it('the hold refuses even a certified-via-AI PR carrying review:changes but NO ready-to-merge label', () => {
    // AI-generated (every commit AI ⇒ certified without a label), green, mergeable — only the hold stops it.
    const v = classifyPr(aiPr({ labels: [{ name: REVIEW_LABELS.changes }] }));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(true);
    expect(v.reason).toMatch(/unsatisfied review hold/);
  });

  // #2820-review-fix (finding 3) — `reviewHeld` means the hold is the SOLE blocker: it is true ONLY on an
  // otherwise-landable PR. A PR that is ALSO red / unmergeable / bodyless keeps its more actionable reason and is
  // NOT reviewHeld, so it never leaks into the passes gated on reviewHeld (the escalation pass, the id-collision
  // heal). The hold is checked LAST — a hard AND on ready-to-merge still (no held PR ever reaches `merge`), but
  // the more-actionable skip reason wins when several blockers are true at once.
  it('a red-CI PR carrying review:changes is NOT reviewHeld — the CI reason wins over the hold (finding 3)', () => {
    const v = classifyPr(aiPr({ statusCheckRollup: [{ name: 'test', conclusion: 'FAILURE' }], labels: [rtm, { name: REVIEW_LABELS.changes }] }));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(false);                 // NOT the operative blocker → never enters the downstream passes
    expect(v.reason).toMatch(/required check "test" is not green/);
    expect(v.reason).not.toMatch(/unsatisfied review hold/);
  });

  it('a CONFLICTING PR carrying review:human is NOT reviewHeld — the mergeability reason wins (finding 3)', () => {
    const v = classifyPr(aiPr({ mergeable: 'CONFLICTING', labels: [rtm, { name: REVIEW_LABELS.human }] }));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(false);
    expect(v.reason).toMatch(/not mergeable/);
  });

  it('a bodyless PR carrying review:pending is NOT reviewHeld — the empty-description reason wins (finding 3)', () => {
    const v = classifyPr(aiPr({ body: '   ', labels: [rtm, { name: REVIEW_LABELS.pending }] }));
    expect(v.decision).toBe('skip');
    expect(v.reviewHeld).toBe(false);
    expect(v.reason).toMatch(/empty\/whitespace description/);
  });
});

// #2820-review-fix (finding 2) — decideReviewGate's DEAD ZONE: review:pending had no branch, so a PR whose fresh
// score de-escalated (rebase below threshold, or a best-effort signal miss) fell through to `!escalate` → merge.
// Combined with classifyPr's hold-skip that stranded the PR: skipped every pass AND absent from parked. The fix
// makes review:pending sticky on the LABEL (mirroring the #2362 human-sticky gate) — it parks agent-reviewable.
describe('merge-ai-prs — #2820-review-fix (finding 2): review:pending is sticky, never the merge dead zone', () => {
  it('a de-escalated review:pending PR PARKS agent-reviewable, not merge', () => {
    const g = decideReviewGate({ escalate: false, humanRequired: false, labels: [{ name: REVIEW_LABELS.pending }] });
    expect(g.action).toBe('park');
    expect(g.applyLabel).toBe(REVIEW_LABELS.pending);
    expect(g.humanRequired).toBe(false);
  });

  it('the per-PR relief valve still frees that exact pending park (the escape hatch is intact)', () => {
    const g = decideReviewGate({ escalate: false, humanRequired: false, labels: [{ name: REVIEW_LABELS.pending }] });
    expect(applyEscalationRelief(g, { relieved: true }).waive).toBe(true);
  });

  it('a real verdict still wins over the sticky pending: review:changes → wait-author, review:human → park human', () => {
    expect(decideReviewGate({ escalate: false, labels: [{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.changes }] }).action).toBe('wait-author');
    expect(decideReviewGate({ escalate: false, labels: [{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.human }] }).humanRequired).toBe(true);
    // xvzc4v4: a matching accepted/head SHA — the SHA-coverage gate is a separate concern from this test.
    expect(decideReviewGate({ escalate: false, labels: [{ name: REVIEW_LABELS.pending }, { name: REVIEW_LABELS.accepted }], acceptedSha: 'abc1234', headSha: 'abc1234' }).action).toBe('merge');
  });

  it('no review label + de-escalated still merges — the fix is a no-op for the common path', () => {
    expect(decideReviewGate({ escalate: false, labels: [] }).action).toBe('merge');
  });
});

describe('merge-ai-prs — planLabelDrain blockedBy ordering (#2188)', () => {
  const cand = (num, item, blockedBy = [], decision = 'merge') => ({ num, item, blockedBy, decision });

  it('orphan PRs (no manifest) are all ready, ordered by PR number', () => {
    const { ready, deferred } = planLabelDrain([cand(9, null), cand(3, null), cand(7, null)]);
    expect(ready.map((c) => c.num)).toEqual([3, 7, 9]);
    expect(deferred).toEqual([]);
  });

  it('DEFERS a PR whose blockedBy item is still an open candidate', () => {
    // #2200 depends on #2199; both open → only the blocker is ready this pass.
    const { ready, deferred } = planLabelDrain([cand(2, 2200, [2199]), cand(1, 2199, [])]);
    expect(ready.map((c) => c.num)).toEqual([1]);
    expect(deferred).toEqual([{ num: 2, item: 2200, waitOn: [2199], headSha: null }]);
  });

  it('a blockedBy item NOT in the candidate set is treated as already landed (ready)', () => {
    const { ready } = planLabelDrain([cand(5, 2200, [1234])]); // #1234 not among candidates → landed
    expect(ready.map((c) => c.num)).toEqual([5]);
  });

  it('a red/skip blocker still defers its dependents (never land past a broken blocker)', () => {
    const { ready, deferred } = planLabelDrain([cand(2, 2200, [2199]), cand(1, 2199, [], 'skip')]);
    expect(ready).toEqual([]); // the blocker is skip (unlanded) so it stays in the open set
    expect(deferred.map((d) => d.num)).toEqual([2]);
  });

  it('orders ready by item then PR number (deterministic cascade)', () => {
    const { ready } = planLabelDrain([cand(8, 2205), cand(4, 2201), cand(6, 2201)]);
    expect(ready.map((c) => c.num)).toEqual([4, 6, 8]); // item 2201 (PRs 4,6) before 2205 (PR 8)
  });

  // #2388 — hash-keyed items (JIT numbering, #2288) must not collapse into a single `Number(hash) === NaN`
  // bucket: a bare `Number()` coercion makes every hash item indistinguishable (`NaN === NaN` under Set's
  // SameValueZero equality), so a hash blockedBy edge would spuriously match ANY other open hash item.
  it('a hash-keyed blockedBy DEFERS while its blocker is open, then FREES once the blocker leaves the set', () => {
    const deferredPass = planLabelDrain([cand(2, 'x5lail9', ['xiea3rt']), cand(1, 'xiea3rt', [])]);
    expect(deferredPass.ready.map((c) => c.num)).toEqual([1]);
    expect(deferredPass.deferred).toEqual([{ num: 2, item: 'x5lail9', waitOn: ['xiea3rt'], headSha: null }]);

    // the caller's cascade removes a merged item between passes (mirrors the real for(;;) loop) — freeing it.
    const freedPass = planLabelDrain([cand(2, 'x5lail9', ['xiea3rt'])]);
    expect(freedPass.ready.map((c) => c.num)).toEqual([2]);
    expect(freedPass.deferred).toEqual([]);
  });

  it('two DISTINCT hash items are never conflated into one NaN bucket', () => {
    // #2 is blockedBy a hash (#xuj0wtn) that is NOT the OTHER open hash item (#xiea3rt) — a `Number()`
    // coercion would make both blockedBy/openItems entries collapse to `NaN`, so #2 would wrongly defer on
    // #xiea3rt even though its real blocker is absent from the candidate set (already landed).
    const { ready, deferred } = planLabelDrain([cand(2, 'x5lail9', ['xuj0wtn']), cand(1, 'xiea3rt', [])]);
    expect(ready.map((c) => c.num)).toEqual([1, 2]); // both ready: #2's actual blocker isn't in play
    expect(deferred).toEqual([]);
  });

  it('sorts numeric items by number, and hash items after every numbered item (tie-break by PR#)', () => {
    const { ready } = planLabelDrain([cand(3, 'xuj0wtn'), cand(2, 2201), cand(4, 'xiea3rt'), cand(1, 2199)]);
    expect(ready.map((c) => c.num)).toEqual([1, 2, 3, 4]); // 2199, 2201, then hashes by PR# (3 before 4)
  });
});

describe('merge-ai-prs — #2683 matchesOnlyTarget (the --only fast-drain repo-scoped target)', () => {
  it('number mismatch never matches', () => {
    expect(matchesOnlyTarget({ prNumber: 9, onlyPr: '12', repo: null, onlyRepo: null, isLocal: true, repoCount: 1 })).toBe(false);
  });
  it('--only-repo scopes to that exact repo (pr-watch sibling-PR case)', () => {
    expect(matchesOnlyTarget({ prNumber: 12, onlyPr: '12', repo: 'o/frontierui', onlyRepo: 'o/frontierui', isLocal: false, repoCount: 3 })).toBe(true);
    expect(matchesOnlyTarget({ prNumber: 12, onlyPr: '12', repo: 'o/plateau-app', onlyRepo: 'o/frontierui', isLocal: false, repoCount: 3 })).toBe(false);
  });
  it('legacy /pr: --this-repo (repoCount 1, cwd repo) matches without --only-repo', () => {
    expect(matchesOnlyTarget({ prNumber: 12, onlyPr: '12', repo: null, onlyRepo: null, isLocal: true, repoCount: 1 })).toBe(true);
  });
  it('legacy /finish REMOTE lane: --repos=<remoteslug> (repoCount 1, non-local) STILL matches (regression guard)', () => {
    // /finish fires `--only=42 --repos=frontier-ui/frontierui` with NO --only-repo; a local-only default would have
    // filtered the remote target out and merged nothing.
    expect(matchesOnlyTarget({ prNumber: 42, onlyPr: '42', repo: 'frontier-ui/frontierui', onlyRepo: null, isLocal: false, repoCount: 1 })).toBe(true);
  });
  it('multi-repo default sweep, no --only-repo → disambiguate to the LOCAL repo only', () => {
    expect(matchesOnlyTarget({ prNumber: 12, onlyPr: '12', repo: 'o/web-everything', onlyRepo: null, isLocal: true, repoCount: 3 })).toBe(true);
    expect(matchesOnlyTarget({ prNumber: 12, onlyPr: '12', repo: 'o/frontierui', onlyRepo: null, isLocal: false, repoCount: 3 })).toBe(false);
  });
});

describe('merge-ai-prs — #2683 extraOpenItems (the --only fast drain orders like the full sweep)', () => {
  const cand = (num, item, blockedBy = [], decision = 'merge') => ({ num, item, blockedBy, decision });
  const sc = (num, item, stackParents = [], { blockedBy = [] } = {}) => ({ num, item, blockedBy, stackParents, decision: 'merge' });

  it('DEFERS a narrowed --only target whose blockedBy sibling is open ONLY via extraOpenItems', () => {
    // The fast-drain candidate list is narrowed to the target (#2 → item 2200 blockedBy 2199); the blocker 2199
    // is NOT in the candidate set. Without extraOpenItems it reads as landed and the target lands EARLY (the AC1
    // bug); feeding the sibling's still-open item in defers it — never landed ahead of its dependency.
    const early = planLabelDrain([cand(2, 2200, [2199])]);
    expect(early.ready.map((c) => c.num)).toEqual([2]); // the pre-#2683 hole: lands early

    const gated = planLabelDrain([cand(2, 2200, [2199])], { extraOpenItems: [2199] });
    expect(gated.ready).toEqual([]);
    expect(gated.deferred).toEqual([{ num: 2, item: 2200, waitOn: [2199], headSha: null }]);
  });

  it('FREES the target once its blocker is no longer an open sibling (blocker landed)', () => {
    const freed = planLabelDrain([cand(2, 2200, [2199])], { extraOpenItems: [1234] }); // 2199 not open anymore
    expect(freed.ready.map((c) => c.num)).toEqual([2]);
  });

  it('a stackParent that is a still-open sibling defers the --only target via extraOpenItems', () => {
    // A numeric stackParent absent from the candidate set would read as landed (proof source 4); listing it as an
    // open sibling in extraOpenItems flips it back to "still open → defer" (proof source 2).
    const gated = planLabelDrain([sc(5, 'xchild0', [2201])], { extraOpenItems: [2201] });
    expect(gated.ready).toEqual([]);
    expect(gated.deferred).toEqual([{ num: 5, item: 'xchild0', waitOn: [2201], headSha: null }]);
  });

  it('extraOpenItems tolerates a Set, hash ids, and null entries', () => {
    const gated = planLabelDrain([cand(2, 'x5lail9', ['xiea3rt'])], { extraOpenItems: new Set(['xiea3rt', null]) });
    expect(gated.deferred).toEqual([{ num: 2, item: 'x5lail9', waitOn: ['xiea3rt'], headSha: null }]);
  });
});

// #xq985wu — DECOUPLE the drain's merge-ORDERING from the `ready-to-merge` label scope. Ordering must derive
// from the FULL open-PR item set (the label-blind `collectOpenPrContext` set), NOT the `--label`-scoped
// candidate list. This is the prerequisite that makes #984/#2832's strip of `ready-to-merge` from a held PR
// SAFE: once stripped, the held PR drops out of the `--label`-scoped `verdicts`, so if ordering derived only
// from that list a dependent `blockedBy` the held item would resolve the edge as "landed" and land EARLY.
describe('merge-ai-prs — #xq985wu decouple merge-ordering from the ready-to-merge label scope', () => {
  const cand = (num, item, blockedBy = [], decision = 'merge') => ({ num, item, blockedBy, decision });

  // AC1 — decoupled ordering. On a FULL sweep, #984 strips `ready-to-merge` from a held blocker, so it is
  // ABSENT from the `--label`-scoped candidate list — yet it is STILL an open PR, so its item rides in via
  // `extraOpenItems` (the label-blind full-open set). The dependent must DEFER against that membership.
  it('AC1: a dependent DEFERS on a held blocker that is absent from the candidate list but present in extraOpenItems (the #984 strip)', () => {
    // candidate list = only the dependent (#2 → item 2200 blockedBy 2199); the held blocker 2199 was stripped
    // of `ready-to-merge` so it is NOT a candidate. Its item is fed via the label-blind open-PR set.
    const gated = planLabelDrain([cand(2, 2200, [2199])], { extraOpenItems: new Set([2199, 2200]) });
    expect(gated.ready).toEqual([]);
    expect(gated.deferred).toEqual([{ num: 2, item: 2200, waitOn: [2199], headSha: null }]);
  });

  it('AC1 mirror: the SAME dependent is READY once the blocker is absent from BOTH the candidate list AND extraOpenItems (truly landed)', () => {
    // Proves the defer above comes from open-SET membership, not from nothing: drop 2199 from the open set and
    // the dependent frees. (The extraOpenItems still carries the dependent's OWN item 2200, but that is already
    // in `openItems` via the candidate-seeding line — the redundancy is harmless because the dependent has no
    // self-`blockedBy` edge; a genuine self-`blockedBy` would be a PERMANENT self-defer, not a no-op, and is
    // rejected upstream by check-standards.mjs / check-backlog-item.mjs.)
    const freed = planLabelDrain([cand(2, 2200, [2199])], { extraOpenItems: new Set([2200]) });
    expect(freed.ready.map((c) => c.num)).toEqual([2]);
    expect(freed.deferred).toEqual([]);
  });

  // AC2 — superset safety / no regression. A FULL candidate list plus a superset `extraOpenItems` (containing
  // extra UNRELATED open items) yields the SAME ready/deferred partition as feeding no extra set at all for the
  // non-held items. Extra open items only add a defer for an edge that points AT them — never drop one.
  it('AC2: a superset extraOpenItems produces the SAME partition as today for non-held items (only ADDs defers, never drops one)', () => {
    const list = [cand(2, 2200, [2199]), cand(1, 2199, []), cand(3, 2205, [])];
    const baseline = planLabelDrain(list); // today's full-sweep behaviour (extraOpenItems null)
    // superset = the candidate items PLUS unrelated open items no edge points at.
    const withSuperset = planLabelDrain(list, { extraOpenItems: new Set([2199, 2200, 2205, 9998, 9999]) });
    expect(withSuperset.ready.map((c) => c.num)).toEqual(baseline.ready.map((c) => c.num));
    expect(withSuperset.deferred).toEqual(baseline.deferred);
    // and the concrete partition is unchanged: the blocker (#1) + the disjoint sibling (#3) land; #2 defers.
    expect(withSuperset.ready.map((c) => c.num)).toEqual([1, 3]);
    expect(withSuperset.deferred).toEqual([{ num: 2, item: 2200, waitOn: [2199], headSha: null }]);
  });

  // AC3 — the wiring. `orderExtraOpenItems` is sourced from the label-blind full-open context (`openPrContext`)
  // on EVERY pass, no longer conditioned on `onlyPr`. This is a source-contract assertion (mirrors the existing
  // #2409 add-first/remove-last source check): the observable seam is a single top-level assignment.
  it('AC3: orderExtraOpenItems is sourced from openPrContext.openItems and NOT gated on onlyPr', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');
    const m = src.match(/const orderExtraOpenItems = (.+);/);
    expect(m).not.toBeNull(); // the assignment is present
    const rhs = m[1];
    expect(rhs).toContain('openPrContext.openItems'); // sourced from the label-blind full-open set
    expect(rhs).not.toContain('onlyPr'); // NOT conditioned on the --only fast-drain flag
  });
});

// #984 F2 — the WIRING half of the park go-ahead strip. The decision itself is pure and covered in
// `review-escalation.test.mjs` (`decideParkReadyStrip`); what a pure test cannot see is WHERE the drain calls
// it, and that is exactly what broke: the strip was nested inside `if (gate.applyLabel && !DRY_RUN)`, so it
// never ran for `review:changes` (a `wait-author` verdict with no `applyLabel`), and two other park sites
// (`continue`-ing on manifest-tamper / test-gaming) never reached it at all. Source-contract assertions, the
// same mechanism the AC3 check above and the #2409 add-first/remove-last check already use — the park loop
// lives in `runCli`, which this file's standing norm leaves un-executed.
describe('merge-ai-prs — #984 F2: the park strip is keyed on OBSERVED holds, not on gate.applyLabel', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'merge-ai-prs.mjs'), 'utf8');

  it('there is exactly ONE ready-to-merge removal site, and it is guarded by decideParkReadyStrip', () => {
    expect(src.match(/'--remove-label', READY_TO_MERGE_LABEL/g) || []).toHaveLength(1);
    const helper = src.slice(src.indexOf('const stripReadyOnPark = ('));
    expect(helper).toMatch(/^const stripReadyOnPark = [\s\S]{0,600}?decideParkReadyStrip\(v\.prLabels, \{ applyLabel, staleAcceptance \}\)/);
    // …and NOT on the shipped applyLabel-shaped key, which is what excluded review:changes.
    expect(src).not.toMatch(/isReviewHoldLabel\(gate\.applyLabel\)/);
  });

  it('the strip does NOT live inside the `gate.applyLabel` guard (the review:changes hole)', () => {
    const start = src.indexOf('if (gate.applyLabel && !DRY_RUN) {');
    expect(start).toBeGreaterThan(-1);
    // The block's closing anchor moved with #x9xqexm: what used to follow this guard was #2409's
    // `--remove-label review:accepted`; a re-score no longer removes it, and the comment block explaining that
    // now sits in its place. Anchored on the replacement so the scan still bounds the same region.
    const end = src.indexOf('// #x9xqexm — A RE-SCORE NEVER REMOVES', start);
    expect(end).toBeGreaterThan(start);
    const guarded = src.slice(start, end);
    expect(guarded).not.toContain('stripReadyOnPark');
    expect(guarded).not.toContain('READY_TO_MERGE_LABEL');
  });

  it('all THREE park sites route through the seam (gate park/wait-author, manifest tamper, test-gaming)', () => {
    expect(src.match(/^\s*stripReadyOnPark\(v, \{/gm) || []).toHaveLength(3);
    // The gate site passes the park's own writes through, so a fresh park and a #2409 re-park both still strip.
    expect(src).toContain('stripReadyOnPark(v, { applyLabel: gate.applyLabel, staleAcceptance: gate.staleAcceptance })');
  });
});

// #999 / xq985wu review — the LIVENESS regression the one-liner introduced. Decoupling ordering onto the
// FROZEN full-open superset (`orderExtraOpenItems`, snapshot BEFORE any merge, never updated) is only safe if
// the `blockedBy` path honours a proven-landed item the SAME way `stackParents` already does. Before the fix
// `blockWait` consulted `openItems` ONLY, so an item that was landed THIS pass (`landedThisPass`) or proven on
// main in a prior session (`provenOnMain`) but still present in the frozen `openItems` kept deferring its
// dependents forever. These are the CAPTURED PREVENTIONS (contract tests at the seam where the bug lives).
describe('merge-ai-prs — #999/xq985wu liveness: blockWait honors landed-proof (F1/F2)', () => {
  const cand = (num, item, blockedBy = [], decision = 'merge') => ({ num, item, blockedBy, decision });

  // F1 — the in-pass cascade must free a `blockedBy` dependent the SAME pass its blocker lands. `landedThisPass`
  // carries the just-merged blocker; the frozen `extraOpenItems` superset still names both. Before the fix the
  // dependent deferred (one-link-per-pass); after, it is ready — mirroring `stackProven`'s landedThisPass-first
  // precedence. This is the asymmetry the review caught: `stackParents` checked landedThisPass BEFORE openItems,
  // `blockedBy` never did.
  it('F1: a dependent whose blocker landed THIS pass is READY even while the frozen superset still names it', () => {
    const plan = planLabelDrain([cand(2, 200, [100])], { landedThisPass: new Set([100]), extraOpenItems: new Set([100, 200]) });
    expect(plan.ready.map((c) => c.num)).toEqual([2]);
    expect(plan.deferred).toEqual([]);
  });

  // F2 — a stale/abandoned/draft/human/impl-half PR still NAMING a LANDED item keeps it in `openItems` forever.
  // `provenOnMain` (the `bornAs`-on-main proof, already wired into `stackParents`) must also clear a `blockedBy`
  // edge: an item present in BOTH `extraOpenItems` and `provenOnMain` is landed, so the dependent is READY.
  it('F2: an item in BOTH extraOpenItems and provenOnMain is proven landed → dependent READY, not deferred', () => {
    const plan = planLabelDrain([cand(2, 200, [100])], { provenOnMain: new Set([100]), extraOpenItems: new Set([100, 200]) });
    expect(plan.ready.map((c) => c.num)).toEqual([2]);
    expect(plan.deferred).toEqual([]);
  });

  // F2 negative control — a blocker that is open and has NO landed-proof still defers (the fix must not read
  // absence-of-proof as landed; it only clears the edge on POSITIVE proof, mirroring the stowaway guard).
  it('F2 control: an open blocker with no landed-proof still DEFERS the dependent', () => {
    const plan = planLabelDrain([cand(2, 200, [100])], { extraOpenItems: new Set([100, 200]) });
    expect(plan.ready).toEqual([]);
    expect(plan.deferred).toEqual([{ num: 2, item: 200, waitOn: [100], headSha: null }]);
  });

  // Cascade-level test — the seam NO original AC touched. Faithfully simulates the real cascade's freeing
  // bookkeeping (scripts/merge-ai-prs.mjs ~2321-2409): re-plan with the SAME frozen `extraOpenItems` superset
  // each inner iteration, and on each "merge" add the item to `landedThisPass` + drop it from `remaining` — the
  // ONLY thing stubbed is the `gh pr merge` write. Before the fix A lands but B never frees within the pass
  // (one-link-per-pass, deferred non-empty at fixed-point); after, BOTH land in one pass, deferred empty.
  it('Cascade: A(ready) + B(blockedBy[A]) BOTH land in one pass, not one-link-per-pass', () => {
    const A = cand(1, 100, []);
    const B = cand(2, 200, [100]);
    // The frozen superset the cascade passes UNCHANGED across inner iterations (snapshot before any merge).
    const extraOpenItems = new Set([100, 200]);
    const landedThisPass = new Set();
    let remaining = [A, B].map((v) => ({ ...v }));
    const merged = [];
    let lastDeferred = [];
    // mirrors the real `for (;;)` cascade loop + its per-merge bookkeeping
    for (let guard = 0; guard < 10; guard++) {
      const plan = planLabelDrain(remaining, { landedThisPass, extraOpenItems });
      lastDeferred = plan.deferred;
      if (!plan.ready.length) break;
      for (const c of plan.ready) {
        merged.push(c.num);
        landedThisPass.add(c.item); // real cascade: landedThisPass.add(asItemId(c.item)) on a WE-carrier merge
        remaining = remaining.filter((x) => x.num !== c.num);
      }
    }
    expect(merged.sort((a, b) => a - b)).toEqual([1, 2]); // both landed
    expect(lastDeferred).toEqual([]); // nothing left deferred at the fixed point
    expect(remaining).toEqual([]); // the dependent did NOT survive to a second pass
  });
});

// #999 / xq985wu F3 — the `--limit` on `collectOpenPrContext`'s per-repo listing is now a MERGE-SAFETY input:
// that listing is the sole ordering source on a full sweep, so a SILENTLY truncated page (newest-first) drops
// the OLDEST open PRs — exactly the long-lived held blockers — and a dependent then reads the missing edge as
// landed and merges EARLY. A full page (`count >= limit`) must be flagged DEGRADED, not silently trusted.
describe('merge-ai-prs — #999/xq985wu F3 truncated open-PR listing is flagged degraded', () => {
  it('a listing at exactly the cap is degraded; below the cap is not', () => {
    expect(isDegradedOpenPrListing(OPEN_PR_LIST_LIMIT, OPEN_PR_LIST_LIMIT)).toBe(true); // full page → truncation possible
    expect(isDegradedOpenPrListing(OPEN_PR_LIST_LIMIT + 5, OPEN_PR_LIST_LIMIT)).toBe(true); // over-full (defensive)
    expect(isDegradedOpenPrListing(OPEN_PR_LIST_LIMIT - 1, OPEN_PR_LIST_LIMIT)).toBe(false); // room to spare → complete
    expect(isDegradedOpenPrListing(0, OPEN_PR_LIST_LIMIT)).toBe(false);
  });
  it('the cap was raised off the old silent 100 (raising alone does not retire the class; the flag does)', () => {
    expect(OPEN_PR_LIST_LIMIT).toBeGreaterThan(100);
  });
});

describe('merge-ai-prs — #2393 proof-of-land stackParents gate (planLabelDrain)', () => {
  // a candidate that may carry stackParents (the overlap-stack edge) alongside its blockedBy edge.
  const sc = (num, item, stackParents = [], { blockedBy = [], decision = 'merge' } = {}) => ({ num, item, blockedBy, stackParents, decision });

  it('a chain lands IN ORDER: the child defers while its parent is open, then frees once the parent is proven landed this pass', () => {
    // child (#2 stackParents [parent]) + parent (#1). Pass 1: parent open ⇒ child NOT proven ⇒ deferred.
    const p1 = planLabelDrain([sc(2, 'xchild0', ['xparen0']), sc(1, 'xparen0', [])]);
    expect(p1.ready.map((c) => c.num)).toEqual([1]);
    expect(p1.deferred).toEqual([{ num: 2, item: 'xchild0', waitOn: ['xparen0'], headSha: null }]);

    // the caller merged the parent's WE carrier this pass (adds it to landedThisPass) + removed it from the set.
    const p2 = planLabelDrain([sc(2, 'xchild0', ['xparen0'])], { landedThisPass: new Set(['xparen0']) });
    expect(p2.ready.map((c) => c.num)).toEqual([2]);
    expect(p2.deferred).toEqual([]);
  });

  it('a RED/ABSENT parent DEFERS its descendants (positive proof — absence is NEVER read as landed)', () => {
    // parent (#1) is red (decision:skip) so it stays open + NEVER enters landedThisPass. The child (#2) must
    // NOT land past it — even though a bare blockedBy-style "absent ⇒ landed" would wrongly free it.
    const red = planLabelDrain([sc(2, 'xchild0', ['xparen0']), sc(1, 'xparen0', [], { decision: 'skip' })]);
    expect(red.ready).toEqual([]);
    expect(red.deferred.map((d) => d.num)).toEqual([2]);

    // a parent that is entirely ABSENT from the candidate set and has NO bornAs proof is likewise NOT proven —
    // a provisional hash we cannot positively prove landed defers the descendant (the stowaway guard).
    const absent = planLabelDrain([sc(5, 'xchild0', ['xghost0'])]);
    expect(absent.ready).toEqual([]);
    expect(absent.deferred).toEqual([{ num: 5, item: 'xchild0', waitOn: ['xghost0'], headSha: null }]);
  });

  it('a parent bornAs-proven on main (provenOnMain) frees the child even when absent from the candidate set', () => {
    const { ready, deferred } = planLabelDrain([sc(5, 'xchild0', ['xparen0'])], { provenOnMain: new Set(['xparen0']) });
    expect(ready.map((c) => c.num)).toEqual([5]);
    expect(deferred).toEqual([]);
  });

  it('a NUMERIC stackParent absent from the candidate set is already-landed (a number only exists post-land)', () => {
    // #2288 JIT numbering assigns a NNN only at land, so a numeric stackParent not in play is landed ⇒ ready.
    const { ready } = planLabelDrain([sc(5, 'xchild0', [2199])]);
    expect(ready.map((c) => c.num)).toEqual([5]);
  });

  it('a DISJOINT sibling (no stackParents) is UNAFFECTED — degrades to the legacy ready sweep', () => {
    const { ready, deferred } = planLabelDrain([sc(3, 'xsib000', []), sc(1, 'xother0', [])]);
    expect(ready.map((c) => c.num).sort()).toEqual([1, 3]);
    expect(deferred).toEqual([]);
  });

  it('both gates compose: a candidate blocked on BOTH an open blockedBy and an unproven stackParent lists both waitOn', () => {
    const { deferred } = planLabelDrain([
      sc(3, 'xdep000', ['xstk000'], { blockedBy: ['xblk000'] }),
      sc(1, 'xblk000', []),
      sc(2, 'xstk000', []),
    ]);
    const d = deferred.find((x) => x.num === 3);
    expect(d.waitOn.sort()).toEqual(['xblk000', 'xstk000']);
  });
});

describe('merge-ai-prs — #2393 impl-PR→WE-manifest laneRef join (joinImplToCouples)', () => {
  // a WE carrier (its own manifest) + its couple's lane refs; and a manifest-less impl PR keyed by headRef.
  const we = (num, item, { blockedBy = [], stackParents = [], refs = [] } = {}) =>
    ({ num, repo: null, headRef: `lane/${item}`, hasManifest: true, manifestRefs: refs, item, blockedBy, stackParents });
  const impl = (num, headRef) => ({ num, repo: 'frontier-ui/frontierui', headRef, hasManifest: false, item: null, blockedBy: [], stackParents: [] });

  it('a manifest-less impl PR INHERITS its couple item + blockedBy + stackParents (closes the impl-orphan-always-ready hole)', () => {
    const couple = we(10, 'xitem00', { blockedBy: ['xblk000'], stackParents: ['xpar000'], refs: ['lane/xitem00', 'lane/xitem00-fui'] });
    const implPr = impl(20, 'lane/xitem00-fui');
    joinImplToCouples([couple, implPr]);
    expect(implPr.item).toBe('xitem00');
    expect(implPr.blockedBy).toEqual(['xblk000']);
    expect(implPr.stackParents).toEqual(['xpar000']);
    expect(implPr.joinedToCouple).toBe('xitem00');
  });

  it('once joined, the impl PR is GATED WITH its couple — it defers whenever the couple defers (no stowaway at the impl level)', () => {
    const couple = we(10, 'xitem00', { stackParents: ['xpar000'], refs: ['lane/xitem00-fui'] });
    const implPr = impl(20, 'lane/xitem00-fui');
    const verdicts = joinImplToCouples([couple, implPr]).map((v) => ({ ...v, decision: 'merge' }));
    // parent unproven ⇒ BOTH the WE couple and its impl PR defer together.
    const { ready, deferred } = planLabelDrain(verdicts);
    expect(ready).toEqual([]);
    expect(deferred.map((d) => d.num).sort()).toEqual([10, 20]);
  });

  it('a TRUE orphan (a headRef in no couple manifest) stays an always-ready orphan — the bare /merge sweep is unchanged', () => {
    const orphan = impl(30, 'lane/unrelated');
    joinImplToCouples([we(10, 'xitem00', { refs: ['lane/xitem00'] }), orphan]);
    expect(orphan.item).toBeNull();
    expect(orphan.joinedToCouple).toBeUndefined();
    expect(planLabelDrain([{ ...orphan, decision: 'merge' }]).ready.map((c) => c.num)).toEqual([30]);
  });
});

describe('merge-ai-prs — parseWatchOpts (#2194 /drain watch)', () => {
  it('defaults: watch off, 30s interval, unbounded (no max-idle), batch-idle off (debounce 2)', () => {
    expect(parseWatchOpts()).toEqual({ watch: false, intervalSec: 30, maxIdle: null, untilBatchesIdle: false, batchIdleDebounce: 2 });
  });

  it('--watch on with a custom interval + max-idle', () => {
    expect(parseWatchOpts({ watch: true, interval: '10', maxIdle: '3' })).toEqual({ watch: true, intervalSec: 10, maxIdle: 3, untilBatchesIdle: false, batchIdleDebounce: 2 });
  });

  it('--until-batches-idle on, custom debounce (#2330)', () => {
    const o = parseWatchOpts({ watch: true, untilBatchesIdle: true, batchIdleDebounce: '3' });
    expect(o.untilBatchesIdle).toBe(true);
    expect(o.batchIdleDebounce).toBe(3);
    // a bad/low debounce falls back to the safe default 2
    expect(parseWatchOpts({ untilBatchesIdle: true, batchIdleDebounce: '0' }).batchIdleDebounce).toBe(2);
    expect(parseWatchOpts({ untilBatchesIdle: true, batchIdleDebounce: 'x' }).batchIdleDebounce).toBe(2);
  });

  it('a non-positive / non-numeric interval falls back to the 30s default', () => {
    expect(parseWatchOpts({ watch: true, interval: '0' }).intervalSec).toBe(30);
    expect(parseWatchOpts({ watch: true, interval: 'x' }).intervalSec).toBe(30);
    expect(parseWatchOpts({ watch: true, interval: '-5' }).intervalSec).toBe(30);
  });

  it('max-idle=0 is honoured (exit on the first idle pass), a bad value → unbounded', () => {
    expect(parseWatchOpts({ watch: true, maxIdle: '0' }).maxIdle).toBe(0);
    expect(parseWatchOpts({ watch: true, maxIdle: 'x' }).maxIdle).toBe(null);
  });
});

describe('merge-ai-prs — decideDrainLeaseGate (#2449 always-on whole-process lease; #2391/#2424/#2443)', () => {
  const free = { held: false, stale: false, owner: null };
  const heldBy = (owner) => ({ held: true, stale: false, owner, heartbeatAt: 'now' });
  const staleOf = (owner) => ({ held: false, stale: true, owner, heartbeatAt: 'old' });

  it('a free lease → acquire, for one-shot and watch alike (no mode input — the gate is mode-agnostic)', () => {
    expect(decideDrainLeaseGate({ status: free }).action).toBe('acquire');
  });

  it('a STALE lease → acquire (the atomic reserve reclaims it — a crashed drain never wedges the queue)', () => {
    expect(decideDrainLeaseGate({ status: staleOf('mac:1:drain') }).action).toBe('acquire');
  });

  it('a LIVE foreign holder → noop surfacing the holder (#2424: the second full drain no-ops, never races)', () => {
    const g = decideDrainLeaseGate({ status: heldBy('mac:99:drain') });
    expect(g.action).toBe('noop');
    expect(g.heldBy).toBe('mac:99:drain');
  });

  it('--only single-PR fast drain BYPASSES the lease (numbering mutex suffices — /pr and /finish stay instant next to a resident daemon)', () => {
    expect(decideDrainLeaseGate({ onlyPr: '12', status: heldBy('mac:99:drain') }).action).toBe('bypass');
  });

  it('--dry-run BYPASSES (merges nothing; a resident daemon must never block a plan read)', () => {
    expect(decideDrainLeaseGate({ dryRun: true, status: heldBy('mac:99:drain') }).action).toBe('bypass');
  });

  it('--no-drain-lease escape hatch BYPASSES', () => {
    expect(decideDrainLeaseGate({ noLease: true, status: heldBy('mac:99:drain') }).action).toBe('bypass');
  });

  it('--under-lease matching the LIVE holder → under-lease (a daemon child pass runs without acquiring)', () => {
    const g = decideDrainLeaseGate({ underLease: 'mac:7:daemon', status: heldBy('mac:7:daemon') });
    expect(g.action).toBe('under-lease');
  });

  it('--under-lease whose declared holder is GONE (free/stale/other) → noop, fail-safe (#2449: an orphaned child never drains unleased)', () => {
    expect(decideDrainLeaseGate({ underLease: 'mac:7:daemon', status: free }).action).toBe('noop');
    expect(decideDrainLeaseGate({ underLease: 'mac:7:daemon', status: staleOf('mac:7:daemon') }).action).toBe('noop');
    expect(decideDrainLeaseGate({ underLease: 'mac:7:daemon', status: heldBy('mac:99:drain') }).action).toBe('noop');
  });

  it('bypass precedence: dry-run > only > no-lease reasons are distinct (operator-visible why)', () => {
    expect(decideDrainLeaseGate({ dryRun: true, onlyPr: '3', status: free }).reason).toBe('dry-run');
    expect(decideDrainLeaseGate({ onlyPr: '3', noLease: true, status: free }).reason).toBe('single-pr-fast-drain');
    expect(decideDrainLeaseGate({ noLease: true, status: free }).reason).toBe('no-drain-lease');
  });
});

describe('merge-ai-prs — cross-repo lease-key MISMATCH regression (2026-09-01 incident): a --under-lease child gates against the REAL acquireDrainLease/drainLeaseStatus/localRepoSlug, not a fixture status object', () => {
  // The 2026-09-01 live incident: PRs #1804/#1808 sat ready-to-merge+green 20+ min unlanded. Root cause was
  // NOT in this file or drain-lock.mjs — both behave exactly as #3440 designed (a repoKey-scoped lease lives in
  // its OWN lock dir, distinct from the legacy unscoped one — already proven by drain-lock.test.mjs's "invisible
  // to a legacy status read" case). The bug was in the RESIDENT DAEMON caller (plateau-app's daemon.mjs): it
  // acquired/heartbeat/released its OWN top-level lease WITHOUT a repoKey (the legacy lock dir), while the CHILD
  // pass it spawns (this file, run from the daemon's dedicated WE clone) resolves `localRepoSlug()` and gates
  // `--under-lease` against the REPO-SCOPED lock dir — two different lock dirs for what must be one lease. This
  // test drives the full real chain (acquireDrainLease → drainLeaseStatus → decideDrainLeaseGate, plus the real
  // localRepoSlug) against a temp lock root, to pin the exact failure signature and its fix, as a durable guard
  // against any FUTURE caller repeating the same mismatch.
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'drain-lock-mismatch-')); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  const fakeExec = (url) => () => url; // stands in for `git remote get-url origin` in localRepoSlug's injected exec

  it('BUGGY shape: daemon acquires UNSCOPED, child gates SCOPED → declared-holder-gone despite a genuinely live, sole-owner daemon', () => {
    const OWNER = 'Mac:73384:drain-daemon';
    // The daemon's own top-level acquire, exactly as the pre-fix daemon.mjs called it: no repoKey.
    expect(acquireDrainLease(root, OWNER, { nowMs: 0 }).ok).toBe(true);
    // The child resolves ITS OWN repoKey from the clone it runs in (real localRepoSlug, real parse).
    const childRepoKey = localRepoSlug({ exec: fakeExec('git@github.com:web-everything/web-everything.git') });
    expect(childRepoKey).toBe('web-everything/web-everything');
    // The child's --under-lease gate reads status at the SCOPED path — but the daemon never wrote a lease
    // there, only at the legacy unscoped one. So it reads as free, not "held by OWNER".
    const status = drainLeaseStatus(root, { nowMs: 60_000, repoKey: childRepoKey });
    expect(status.held).toBe(false);
    const gate = decideDrainLeaseGate({ underLease: OWNER, status });
    // This IS the observed incident: exit 0, "no-op", reason declared-holder-gone, considered:0 — despite the
    // daemon genuinely being the sole live holder (just at a different lock dir than the child checked).
    expect(gate).toMatchObject({ action: 'noop', reason: 'declared-holder-gone' });
  });

  it('FIXED shape: daemon acquires with the SAME repoKey the child resolves → the child correctly sees under-lease and proceeds', () => {
    const OWNER = 'Mac:73384:drain-daemon';
    const repoKey = localRepoSlug({ exec: fakeExec('git@github.com:web-everything/web-everything.git') });
    // The fix: the daemon computes repoKey the same way (from the SAME clone) and threads it through its own
    // acquire — now both sides key off the identical lock dir.
    expect(acquireDrainLease(root, OWNER, { nowMs: 0, repoKey }).ok).toBe(true);
    const status = drainLeaseStatus(root, { nowMs: 60_000, repoKey });
    expect(status).toMatchObject({ held: true, owner: OWNER });
    const gate = decideDrainLeaseGate({ underLease: OWNER, status });
    expect(gate).toMatchObject({ action: 'under-lease', heldBy: OWNER }); // the child now proceeds to sweep
  });
});

describe('merge-ai-prs — decideDrainLeaseGate REPO-SCOPE awareness (#2458)', () => {
  const heldScoped = (owner, scope) => ({ held: true, stale: false, owner, heartbeatAt: 'now', scope });

  it('holder scope UNKNOWN (legacy/unscoped lease) → conservative no-op, never a false-negative land (preserves pre-#2458)', () => {
    const g = decideDrainLeaseGate({ repos: ['o/we'], status: { held: true, stale: false, owner: 'mac:9:drain', scope: null } });
    expect(g).toMatchObject({ action: 'noop', reason: 'lease-held', heldBy: 'mac:9:drain' });
  });

  it('this run has NO scope input → conservative no-op (cannot prove disjointness → assume covered)', () => {
    expect(decideDrainLeaseGate({ repos: [], status: heldScoped('mac:9:drain', ['o/we']) }).reason).toBe('lease-held');
    expect(decideDrainLeaseGate({ status: heldScoped('mac:9:drain', ['o/we']) }).reason).toBe('lease-held');
  });

  it('this run ⊆ holder scope → honest no-op (the holder genuinely covers this work)', () => {
    const g = decideDrainLeaseGate({ repos: ['o/we'], status: heldScoped('mac:9:drain', ['o/we', 'o/frontierui', 'o/plateau-app']) });
    expect(g).toMatchObject({ action: 'noop', reason: 'lease-held' });
  });

  it('fully DISJOINT scope → HONEST no-op naming the uncovered repos (NOT a lease-less bypass — that would race two same-scope launches under a narrow holder)', () => {
    const g = decideDrainLeaseGate({ repos: ['o/plateau-app'], status: heldScoped('mac:9:drain', ['o/we']) });
    expect(g).toMatchObject({ action: 'noop', reason: 'lease-held-uncovered', heldBy: 'mac:9:drain' });
    expect(g.uncovered).toEqual(['o/plateau-app']); // reported honestly instead of a false "covers this work"
  });

  it('PARTIAL overlap → same honest no-op, reporting the UNCOVERED repos (no false coverage claim; no shared-repo merge race)', () => {
    const g = decideDrainLeaseGate({ repos: ['o/we', 'o/plateau-app'], status: heldScoped('mac:9:drain', ['o/we']) });
    expect(g).toMatchObject({ action: 'noop', reason: 'lease-held-uncovered' });
    expect(g.uncovered).toEqual(['o/plateau-app']); // named so the message can be honest about what is NOT swept
    expect(g.covered).toEqual(['o/we']);
  });

  it('scope comparison is order-independent (both sides may arrive unsorted)', () => {
    const g = decideDrainLeaseGate({ repos: ['o/frontierui', 'o/we'], status: heldScoped('mac:9:drain', ['o/we', 'o/frontierui']) });
    expect(g.reason).toBe('lease-held'); // fully covered regardless of order
  });

  it('scope awareness never overrides the earlier bypass/under-lease branches', () => {
    // A --only fast drain or --dry-run still bypasses even against a disjoint scoped holder (scope check is only for the plain held path).
    expect(decideDrainLeaseGate({ onlyPr: '5', repos: ['o/plateau-app'], status: heldScoped('mac:9:drain', ['o/we']) }).reason).toBe('single-pr-fast-drain');
    expect(decideDrainLeaseGate({ dryRun: true, repos: ['o/plateau-app'], status: heldScoped('mac:9:drain', ['o/we']) }).reason).toBe('dry-run');
  });
});

describe('merge-ai-prs — batch-aware --until-batches-idle exit (#2330)', () => {
  const feedOf = (runs) => ({ runs });

  it('pickRunningBatches selects only kind:batch status:running runs', () => {
    const feed = feedOf([
      { kind: 'batch', status: 'running', nums: [1, 2] },
      { kind: 'batch', status: 'completed', nums: [3] },   // terminal → not producing
      { kind: 'workflow', status: 'running' },             // not a batch
      { kind: 'batch', status: 'running', nums: [4] },
    ]);
    expect(pickRunningBatches(feed).map((r) => r.nums)).toEqual([[1, 2], [4]]);
    expect(pickRunningBatches(null)).toEqual([]);
    expect(pickRunningBatches({})).toEqual([]);
  });

  it('readBatchFeed: absent / stale / unparseable → known:false (keep watching); fresh → known:true', () => {
    const now = 1_000_000;
    const mk = (opts) => readBatchFeed('/feed.json', { now, staleMs: 30_000, fs: opts });
    // absent
    expect(mk({ existsSync: () => false, readFileSync: () => '', statSync: () => ({}) }))
      .toEqual({ known: false, running: [], reason: 'feed-absent' });
    // stale (mtime older than staleMs)
    expect(mk({ existsSync: () => true, statSync: () => ({ mtimeMs: now - 60_000 }), readFileSync: () => '{"runs":[]}' }).known).toBe(false);
    // unparseable
    expect(mk({ existsSync: () => true, statSync: () => ({ mtimeMs: now }), readFileSync: () => 'not json' }).known).toBe(false);
    // fresh + running batch
    const fresh = mk({ existsSync: () => true, statSync: () => ({ mtimeMs: now - 1_000 }), readFileSync: () => JSON.stringify(feedOf([{ kind: 'batch', status: 'running', nums: [9] }])) });
    expect(fresh.known).toBe(true);
    expect(fresh.running).toHaveLength(1);
  });

  it('decideBatchesIdleExit: the safe conjunction (idle + empty queue + debounced non-running)', () => {
    // disabled → never
    expect(decideBatchesIdleExit({ enabled: false, idlePass: true, considered: 0, batchNonRunningStreak: 5 })).toBe(false);
    // not idle → keep going
    expect(decideBatchesIdleExit({ enabled: true, idlePass: false, considered: 0, batchNonRunningStreak: 5 })).toBe(false);
    // queue not empty → keep going (a labelled PR is still in flight)
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 1, batchNonRunningStreak: 5 })).toBe(false);
    // batch not debounced yet (streak < debounce) → keep going
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 0, batchNonRunningStreak: 1, debounce: 2 })).toBe(false);
    // all conditions met → exit
    expect(decideBatchesIdleExit({ enabled: true, idlePass: true, considered: 0, batchNonRunningStreak: 2, debounce: 2 })).toBe(true);
  });
});
