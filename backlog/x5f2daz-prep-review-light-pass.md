---
kind: story
size: 5
status: open
scope: ["we:scripts/conveyor/prep-review.mjs", "we:scripts/conveyor/prep-review-io.mjs", "we:skills-src/conveyor/review-daemon.mjs", "we:scripts/merge-ai-prs.mjs", "we:scripts/lib/review-escalation.mjs", "we:scripts/backlog/edge-case-classes.mjs"]
dateOpened: "2026-10-08"
tags: []
---

# Prep review: a light single-reviewer pass on prepare PRs (advise mode)

Prepare PRs (card-only) land with no review, so the drain posts "Incomplete review - no-recorded-review" and the health watch posts a "review-label-missing" note (live: PR #4280). Add a single-reviewer pass using `prepReview.model` (mode `off | advise | block`, default `advise`). It checks the 7 edge-case classes, that the scope names real files, that the done-when is an executable command, and that the work is not already on main. Output is `we.worker-result` JSON, schema-checked. Findings go back to the preparer for ONE round. Advise mode posts a labelled note, records a verdict, and never blocks.

## Design

An additive stage in the review daemon (like convert-advisory), WE only, off with `WE_PREP_REVIEW_MODE=off`.

- A PR is a prepare PR only if its head ref is `lane/<n>-prepare-item-...` AND its whole diff is the one `we:backlog/<n>-*.md` card. Anything else keeps the normal review.
- Code decides three checks (scope has a real `we:` file on main, `## Done when` has a backticked command, no merged PR already delivers the item via the prepare-outcomes already-done check) and finds the unanswered edge-case classes. A tool-free model (`prepReview.model`, read from `we:scripts/lib/model-settings.json` with a `claude-haiku-5-5` fallback) judges whether the answered classes are real or hollow.
- Result: one `we.worker-result` v1 object, role `review`: no finding is `done`; any finding is `blocked` / `spec-defect`. Validated on the way out; the model's answer is validated on the way in and dropped whole if it breaks the schema.
- The note carries the headline `PREP_REVIEW_HEADLINE`, a marker with head sha and round, and the JSON. The drain reads it as a review record (`prep-advised`) only on a `-prepare-item-` head ref and only from a trusted author, so a code PR gets no credit for it. The PR gets the new label `review:prep`, which stops `review-label-missing`.
- `block` mode adds `review:changes` in round 1 only (the one round for the preparer). Default and our setting are `advise`.

## Done when

1. **Executable** — Running vitest (`npx vitest run`) on `we:scripts/conveyor/__tests__/prep-review.test.mjs` fails before this item lands (no module) and passes after; its replay block asserts PR #4280's two noises stop for a prepare PR and do not stop for a code PR.
2. **Live** — the next prepare PR carries one `prep advisory` note and `review:prep`, and the drain posts no `no-recorded-review` for it.

## Edge cases this change must handle

1. **Untrusted text** — the card goes to the model inside a fence it cannot close; model notes are folded to one line with control characters and backticks removed; the card path and sha are regex-checked before they reach `gh` argv; no value starting with `--` can reach argv.
2. **Truncated reads** — the card is read whole at the head sha through `gh api` with a size cap; a card cut for the model says how much was cut; an unreadable already-on-main history is "not checked", never "clear".
3. **Shared state files** — n/a: the stage writes no local file; the record is a PR comment, and the per-head marker makes a second tick a no-op.
4. **Fail closed** — a model answer that breaks the worker-result schema contributes no findings and the note says so; a failed card read throws and is reported per PR; an unknown mode falls back to `advise`, never `block`.
5. **Identity scoping** — keyed by repo + PR number + head sha + round; only the WE slug is reviewed; a PR with any other file besides its one card is not a prepare PR.
6. **State over time** — a new head is a new round; round 2 is advice only; a lost label is repaired without a second note or model spend; a per-tick cap bounds spend.
7. **Who wrote it** — only comments from a trusted author count as a prior round or as the drain's review record, and only on a `-prepare-item-` head ref; an existing `review:*` label (pending, human, accepted) means the PR is skipped.
