---
bornAs: xobnfjb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/merge-ai-prs.mjs", "we:scripts/__tests__/merge-ai-prs.test.mjs"]
dateOpened: "2026-10-13"
preparedDate: "2026-10-13"
preparedAgainstSha: "e1320124c6b7f6d01e0fe99f5462c6dcd15e9b1d"
tags: []
---

# Prevention — Add a decision-table test for decideDrainReviewGate that crosses each review label (changes, pend… (from web-everything/web-everything#4965 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/merge-ai-prs.mjs:845` — Add a decision-table test for `decideDrainReviewGate` that crosses each review label (`changes`, `pending`, `human`, `accepted`, none) with workflow and non-workflow files and pins the intended action. Alternatively, evaluate the hold after `decideReviewGate` returns `wait-author`.
2. `we:scripts/merge-ai-prs.mjs:850` — Make `filesComplete === true` and a matching non-empty `listedHeadSha` required to trust a listing (anything else triggers the pinned read), plus a unit test for the files-only shape. Optionally a check:standards rule that forbids defaulting evidence-completeness flags to true.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4965@c8971d7d3641c3bdc88ca30c4cc17eea4818e431

## Acceptance

- [A1] **Executable** — `npx vitest run` on the new test file we:scripts/__tests__/drain-review-gate-decision-table.test.mjs fails before this item lands (the table file does not exist, and a files-only listing with no workflow path is trusted and merges instead of deferring) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] Does not move the workflow-edit hold after `decideReviewGate` (the card's "alternatively" branch) — the hold stays before it.
- [N2] Does not add the optional check:standards rule forbidding `!== false` completeness defaults (see Follow-ups).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: the gate takes labels, file paths and SHAs only; no text reaches a shell or regex that this change adds (the pinned read already passes `--end-of-options`).
2. **Truncated reads** — a listing is trusted only when `filesComplete === true`; an absent or false flag (including the files-only shape) takes the pinned `readPinnedChangedFiles` read, and a read error defers. Test: files-only shape + workflow path.
3. **Shared state files** — n/a: pure decision function, no state file written.
4. **Fail closed** — absent `filesComplete`, absent/empty `listedHeadSha`, or a head mismatch never counts as a complete listing; when the pinned read is impossible (`local` false or setting not off) the hold defers, never merges.
5. **Identity scoping** — `listedHeadSha` must equal the acceptance head (case-insensitive) when one is known; test a mismatch case.
6. **State over time** — n/a: evaluated fresh per drain pass from the live listing; nothing persists across ticks.
7. **Who wrote it** — n/a: no author-granted trust added; the existing clear-human ceremony check (`humanClearedSha`) is only exercised by the table, not changed.

## Design

`decideDrainReviewGate` (we:scripts/merge-ai-prs.mjs:836) decides the drain action from labels plus a file listing. Lines 850-852 compute `filesComplete` as `Array.isArray(files) && readOptions?.filesComplete !== false && (listedHeadSha === undefined || …)`. Both `!== false` and `=== undefined` mean a caller that omits the evidence (the files-only shape) is trusted as a complete, head-matched listing, so the pinned read at 853-861 is skipped. Fix: `filesComplete = Array.isArray(files) && readOptions?.filesComplete === true && !!readOptions.listedHeadSha && (!evidence.headSha || listedHeadSha.toLowerCase() === evidence.headSha.toLowerCase())`. Anything else takes the existing pinned read (`readPinnedChangedFiles`) when `local` and the setting is not `off`; otherwise `decideDrainWorkflowEditHold` (we:scripts/lib/drain-workflow-edit-hold.mjs:32) already treats `filesComplete !== true` as unknown evidence and defers. The `workflowOnly` pre-check (837-839) passes the flag straight through, so it already fails closed on an absent flag. Both production callers (we:scripts/merge-ai-prs.mjs:5288, 5674) pass `workflowReadOptions(v)` (4894) with real `listedFilesComplete` and `listedHeadSha`, so live behavior is unchanged: `listedFilesComplete` is a strict boolean (line 1988) and `listedHeadSha` is a non-empty string or `null` (1983); `null` is already non-complete today (`!!null` is false), so it already takes the pinned read.

Guard 1 is a new table test crossing review label (`changes`, `pending`, `human`, `accepted`, none) × files (workflow, non-workflow) with the intended action pinned, built on the `replay` helper in we:scripts/__tests__/drain-workflow-edit-replay.test.mjs:15-24. No `decideReviewGate` reorder (N1).

## MVP

Musts: (1) the stricter `filesComplete` expression; (2) a unit test for the files-only shape (`files` without a workflow path — the truncated-listing case — no `filesComplete`, no `listedHeadSha`) asserting it is not trusted; (2b) update existing tests that pass `files` without the flags and now take the pinned read: we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:546 and we:scripts/lib/__tests__/human-clearance-carry.test.mjs:308-413 (add `filesComplete: true, listedHeadSha`), so the lane stays green; (3) the 5×2 decision-table test file we:scripts/__tests__/drain-review-gate-decision-table.test.mjs. Out of scope → Follow-ups.

## Test plan

- `files-only shape is not trusted` — non-workflow files, flags absent, `local:false`: asserts `defer`. RED today: the listing is trusted and it merges. With `local:true` and an exec returning a workflow diff, asserts the pinned git read ran and it parks (RED today: no git call, merges).
- `filesComplete:true with undefined listedHeadSha reads pinned` — RED today.
- `mismatched listedHeadSha reads pinned` — accepted label plus a `gh` exec mock returning a different `headRefOid`; empty-string SHA also pinned (both green today, regression pins).
- Decision table: each label in {changes, pending, human, accepted, none} × {workflow file, non-workflow file}, asserting `action`. Expected values are recorded from current behavior and `decideReviewGate`; it is a regression pin and fails if the hold ordering changes.

## Proof plan

With the new test file present, `git stash` the one-line fix in we:scripts/merge-ai-prs.mjs and run vitest on the new test file: the files-only and undefined-listedHeadSha cases must be RED; restore the fix and re-run: GREEN. Paste both vitest summaries in the PR body. Then run the drain script we:scripts/merge-ai-prs.mjs with `--dry-run` before and after the fix and compare stderr: pass when the count of "workflow-edit change list unreadable" and "check deferred" lines does not rise.

## Follow-ups

- check:standards rule forbidding `!== false` / `=== undefined` defaults on evidence-completeness flags (the card's optional item).

## Progress

2026-10-13 prepare: premise check — still no decision-table test (existing coverage in we:scripts/__tests__/merge-ai-prs-acceptance-restamp-and-review-coverage.test.mjs:596-690 and the replay test is spot cases only) and lines 850-852 still default-trust. Card cites 845/850; code is now at 836/850. Goal unchanged.
