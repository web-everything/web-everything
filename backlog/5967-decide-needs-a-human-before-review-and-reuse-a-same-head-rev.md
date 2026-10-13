---
bornAs: xweb502
kind: story
size: 3
status: open
scope: ["we:scripts/operations/review-dispatch.mjs", "we:scripts/operations/review-job.mjs", "we:scripts/operations/land-advance-io.mjs", "we:scripts/operations/review-pr.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/advisory-labels.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/review-settings.json", "we:scripts/operations/__tests__/review-dispatch.test.mjs", "we:scripts/operations/__tests__/review-job.test.mjs", "we:scripts/operations/__tests__/land-advance-io.test.mjs", "we:scripts/operations/__tests__/review-pr.test.mjs", "we:scripts/lib/__tests__/advisory-labels.test.mjs", "we:scripts/lib/__tests__/review-settings.test.mjs", "we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-12"
preparedDate: "2026-10-13"
preparedAgainstSha: "b4676cf68f6edcf092c80d4f878fa7003a340756"
tags: []
---

# Decide needs-a-human before review, and reuse a same-head review as the advisory

Held finding 218 (2026-10-10, operator OK). Live #4763: unattended review accepted 17:11 ET, flipped ready-to-merge, drain parked it gate-self at 17:24 (review:human + awaiting-advisory), mutual exclusivity removed review:accepted, then it waited for a second identical advisory run. Fix: (a) compute humanRequired from the touch-set shape before review and label review:human up front; (b) setting review.reuseAcceptAsAdvisory (cascade, default on): when a PR turns human-required, the latest review on the same head counts as its advisory iff its seated lenses/rounds meet what the shape earned, else re-run; (c) status labels follow (no stale status:ready-to-merge).

## Acceptance

- [A1] **Executable** — run from the WE checkout; selects every test file in scope. The new behavior cases fail before implementation and pass after; existing behavior pins may already pass.

```bash
npx vitest run scripts/operations/__tests__/review-pr.test.mjs scripts/operations/__tests__/review-dispatch.test.mjs scripts/operations/__tests__/review-job.test.mjs scripts/operations/__tests__/land-advance-io.test.mjs scripts/lib/__tests__/advisory-labels.test.mjs scripts/lib/__tests__/review-settings.test.mjs scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs scripts/__tests__/merge-ai-prs.test.mjs
```

- [A2] **Must** — on error (shape unscorable, settings unreadable, advisory comment unreadable) the code refuses to reuse and re-runs the advisory; it never reuses on a failed read.
- [A3] **Must** — the shape scoring and the reuse check treat docs, config, data and backlog paths exactly as `buildShapePlan` does today (no path kind is waived); reuse only ever loosens the re-run, never the `review:human` hold.

## Non-goals

- [N1] Does not let a reused review clear `review:human`; the human ceremony is unchanged (`planRecordDecision` INVARIANT 2, we:scripts/operations/review-pr.mjs:1907).
- [N2] Does not change how `earnedShape` is scored (`buildShapePlan`) or add lenses; it only reads the result earlier.

## Edge cases this change must handle

1. **Untrusted text** — the reused advisory is read only from comments passing `trustedAdvisoryComments` (we:scripts/lib/advisory-labels.mjs:126); its text is parsed for head sha, lenses and rounds only and never reaches argv, a shell or a note unfolded (`foldUntrusted`).
2. **Truncated reads** — the comment list comes from `readCompletePrComments` (we:scripts/conveyor/pr-comments-complete.mjs); a truncated page is an error and means "re-run", never "no advisory found" or "advisory found".
3. **Shared state files** — n/a: no new state file; the setting is read-only from we:scripts/review-settings.json, and labels use the existing label writer.
4. **Fail closed** — an unscorable shape (`assertDeclaredShapeHolds` returns `null`), unreadable settings, or an unparseable advisory means: no early `review:human` guess, no reuse, re-run the advisory; the refusal reason is named in the log line.
5. **Identity scoping** — reuse is keyed by repo + PR + full head sha via `advisoryCoversHead` (we:scripts/lib/advisory-labels.mjs:131); a review of any other head, PR or repo never counts.
6. **State over time** — a new head voids the reuse (the advisory no longer covers it); a daemon restart between review and park re-derives from comments and labels, so no in-memory state is needed; the stale `review:awaiting-advisory` and `status:ready-to-merge` labels are removed in the same park step.
7. **Who wrote it** — only trusted-marker-author comments count (see 1); a comment from anyone else with the same text is ignored, and an operator-added `review:human` label is never removed by this change.

## Design

Today the shape is only read inside `review-pr read` (we:scripts/operations/review-pr.mjs:1219, `assertDeclaredShapeHolds`), and `humanRequired` comes off the LABELS (we:scripts/operations/review-pr.mjs:1271), so a PR whose touch-set earns human review is reviewed as agent-reviewable until the drain parks it later (we:scripts/merge-ai-prs.mjs:865-875, `decideReviewGate`).

(a) Up-front: keep the pure `planReviewDispatch` untouched. Put the shared preflight in `dispatchReviewByMode` (we:scripts/operations/review-job.mjs), after its stack-skip check and before either mode starts. Its injected `readReviewScope` production reader must obtain the scored net diff, current head and labels using the same net-basis reader as `review-pr read`; it supplies `netChangedFiles` to a pure `decideUpfrontHuman` using `buildShapePlan`, and populates the session's `scopePaths` from that list. Do not assume existing callers supply `scopePaths`: they do not. Default `job` mode must execute this preflight too, before `dispatchReviewJob` launches its worker. Route both branches of the review-dispatch CLI and the direct `dispatchReview` call in we:scripts/operations/land-advance-io.mjs through `dispatchReviewByMode` (preserving the latter's session mode and injected actions). Any remaining direct launcher callers must use the same preflight rather than bypass it.

The injected `applyLabels` seam uses the existing label writer and completes before spawn. For a scored human-required shape, ensure `review:human` and `review:awaiting-advisory` are present, even if `review:human` was added by an operator already. Never remove that hold. Empty scope, failed/degraded net reads or null shape mean no early label guess and a named refusal log; preserve existing labels. A failed required label write must prevent launch rather than start a review against stale labels. The downstream review reads the updated labels, so it runs as an advisory.

Give `readReviewScope` a production default, not only a test injection: wrap the existing `createReviewPrReader` export from we:scripts/operations/review-pr-io.mjs in we:scripts/operations/review-job.mjs (no reader-module edit), which resolves the subject checkout and calls `readPr`. Take paths/scored/reason/head from `raw.net.paths`, `raw.net.scored`, `raw.net.reason` and `raw.net.revSha`, and labels from `raw.detail.labels`. This reuses the existing main/stack net basis without substituting the displayed three-dot file list. The wiring test must retain this default adapter and mock its transport inputs; injecting a finished scope object proves only orchestration. The CLI and land caller must forward repo, PR and checkout context to it. Do not change the synchronous dispatch return contract; adapt the existing synchronous reader and label provider.

(b) Reuse: add `reuseAcceptAsAdvisory` (default `true`) to we:scripts/lib/review-settings.mjs (`BUILT_IN_REVIEW_SETTINGS`, `REVIEW_SETTINGS_ENV`, a boolean parser) and we:scripts/review-settings.json. `parseAdvisories` consumes `renderAdvisoryNote` and also accepts ordinary `renderVerdictWriteUp` records through its legacy Verdict/Net-basis fallback. The advisory note currently lacks reusable round metadata. Add one shared completed-coverage renderer for explicit completed-lens and completed-round fields to BOTH producers and parse those fields in we:scripts/lib/advisory-labels.mjs. This makes a newly recorded ordinary accept reusable when it later parks, as in #4763. Populate the fields from actual completed judging results, excluding skipped seats; never copy the earned/requested shape as evidence of work done. If completed rounds cannot be established, emit zero. Legacy/malformed notes with missing fields parse as zero coverage and cannot be reused. Use real output from both renderers for parser fixtures.

Add pure `decideAdvisoryReuse({ advisories, headSha, earnedShape, setting })`: reuse only when the setting is on, the latest trusted advisory is an `accept` covering this head (`advisoryCoversHead`), with both parsed and live heads validated as full 40-hex SHAs and equal (the existing helper alone also accepts prefixes), its completed lenses include every earned lens, and its completed rounds meet the earned rounds. A newer changes/inconclusive note blocks reuse of an older accept. At the park-to-human site in we:scripts/merge-ai-prs.mjs, successful reuse explicitly removes any existing `review:awaiting-advisory` and omits adding it; failed reuse ensures it is present. No new advisory comment is posted. Preserve `review:human` on both branches, regardless of who added it, and keep merge disallowed (N1).

(c) Labels: `stripReadyOnPark` (we:scripts/merge-ai-prs.mjs:5323, via `decideParkReadyStrip`) already strips `status:ready-to-merge` at all three park sites (:5524, :5644, :5720). The Must here is only a regression test replaying the #4763 order (accepted, ready-to-merge, then a gate-self park) proving the strip and the `review:accepted` removal both happen; if that test is RED, fix `stripReadyOnPark` for the missed case.

## Preparation review checks

Before implementation, cross-check every design seam against a production caller that supplies its required inputs, including the default job dispatch branch. Parser fixtures must come from the real advisory renderer, and every scoped test file must be explicitly selected by A1. Each acceptance criterion and edge case above must map to a named test; isolated helper tests do not prove production wiring. The reusable prepare-lens/lint prevention work is tracked in [x5967pv](x5967pv-prevention-check-prepare-wiring-renderer-fixtures-and-test-selection.md); the two label regression preventions are Must tests in this card.

## MVP

Musts: (a) shared up-front preflight in `dispatchReviewByMode`, with production net-file reader and CLI/land-advance wiring in both modes, (b) the setting, advisory renderer/parser coverage contract and reuse decision with stale-awaiting removal and human-hold preservation, (c) a #4763-order regression test for the existing strip (code change only if RED), with the A2/A3 refusals. Out of scope: any change to scoring, the human clearance flow, or other advisory providers.

## Test plan

- **`default job dispatch reads net files and labels before launch`** in `we:scripts/operations/__tests__/review-job.test.mjs`: invoke the real `dispatchReviewByMode` with mode omitted and no `scopePaths`; inject only I/O, return a gate-self net list, and assert the production reader arguments, both labels and ordering before job spawn. **`session dispatch receives the scored net scope`** covers the alternate branch and worker input. These are the wiring proof for (a), not helper-only tests (A1, edge 6).
- **`CLI modes share the preflight`** in `we:scripts/operations/__tests__/review-dispatch.test.mjs` and **`land advance supplies the review preflight reader`** in `we:scripts/operations/__tests__/land-advance-io.test.mjs` exercise the actual entry/caller paths with mocked external effects and no supplied file list; both must reach the same net reader before launch (A1).
- **`production scope adapter uses scored subject net paths`** in `we:scripts/operations/__tests__/review-job.test.mjs`: keep the default reader adapter, mock the existing reader's transport, and return different net and display file lists. Assert scoring and session scope use only the net paths, with repo/PR/checkout preserved; cover main and stack bases and a degraded read. This closes the gap between an injected preflight unit test and the production input supplier (A1, A2, edges 4, 5).
- **`path kinds preserve buildShapePlan decisions`** in `we:scripts/operations/__tests__/review-job.test.mjs`: table of docs, config, data and backlog net lists plus gate-self source; assert exact agreement with current `buildShapePlan`, including docs-only no-label behavior (A3, N2).
- **`empty or unscorable scope adds no early label`** in `we:scripts/operations/__tests__/review-job.test.mjs`: empty list, null shape, failed/degraded net read; named refusal, no label mutation, existing operator hold retained. **`required label write failure prevents launch`** pins the error branch (A2, edge 4).
- **`renderAdvisoryNote round-trips completed coverage`** in `we:scripts/operations/__tests__/review-pr.test.mjs`: generate a real note from judging results, pass it to `parseAdvisories`, assert completed lenses/rounds and reuse. Include skipped seats and unknown completed rounds; earned shape must not inflate completion. No hand-written success fixture (A1, A3).
- **`ordinary accepted review round-trips into park reuse`** in `we:scripts/operations/__tests__/review-pr.test.mjs` and the merge coverage suite: generate the actual `renderVerdictWriteUp` accept record, parse its shared completed coverage, then use that record in the real park-pass fixture. It must reuse without a second advisory, clear awaiting and retain human; an advisory-note-only success fixture cannot prove #4763 (A1, A3, edge 6).
- **`reuse requires latest trusted same-head sufficient coverage`** in `we:scripts/lib/__tests__/advisory-labels.test.mjs`: matching coverage reuses; missing/wrong earned lens, too few rounds, missing/malformed/legacy metadata, newer changes/inconclusive, different head, abbreviated/malformed head and untrusted/missing author all refuse. Read comments within the requested repo/PR only; other repo/PR fixtures never enter the decision. Text stays parser data, with no effect execution (A2, edges 1, 5, 7).
- **`reuse setting defaults on and explicit false disables`** in `we:scripts/lib/__tests__/review-settings.test.mjs` and **`failed reads refuse reuse with named reasons`** in the merge coverage suite: unreadable settings, incomplete/truncated comment pages, unreadable comments and null earned shape all retain/ensure awaiting-advisory (A2, edges 2, 4).
- **`reuse clears an existing awaiting-advisory label`** in `we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs`: start with human + awaiting-advisory + matching rendered accept; run the real park pass, assert awaiting removed, human retained, no advisory posted/dispatched. Also cover awaiting initially absent (edge 6).
- **`default-enabled advisory reuse preserves the human hold`** in that same merge suite: omit the setting and parameterize shape-added/operator-added `review:human`; matching reuse keeps the hold, strips accepted/ready and leaves merge disallowed (A3, N1, edge 7).
- **`4763 accept-ready-park strips accepted and ready`** in that merge suite: replay the recorded order at all three park sites. This may already pass; fix `stripReadyOnPark` only if red (A1, edge 6).
- **`restart rederives reuse and a new head invalidates it`** in that merge suite: two fresh park invocations using only persisted comments/labels; no new state file or cached verdict, new head ensures awaiting and retains human (edges 3, 5, 6).

## Proof plan

Replay the #4763 shape on a throwaway lane PR touching a gate-self path, running the drain's park pass with label writes on (not DRY_RUN) against that PR only: before, the log shows accepted → parked → second advisory wait; after, it shows `review:human` up front, a single advisory run, and (with a matching same-head review) a reuse line and no second run. Capture both logs in the PR body.

## Follow-ups

- Report the reuse decision in the pr-watch status line.
- Extend reuse to advisories posted by other providers once their lens counts are comparable.
