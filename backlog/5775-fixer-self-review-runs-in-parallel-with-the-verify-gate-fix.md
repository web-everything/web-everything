---
bornAs: xloi1c0
kind: story
size: 3
priority: high
status: resolved
scope: ["we:scripts/conveyor/await-verify.mjs", "we:scripts/conveyor/await-verify-pass.mjs", "we:scripts/conveyor/fix-procedure.mjs", "we:scripts/lib/fix-push-policy.mjs", "we:skills-src/conveyor/fix-agent-brief.md", "we:scripts/conveyor/__tests__/await-verify-self-review-parallel.test.mjs"]
dateOpened: "2026-10-10"
dateResolved: "2026-10-10"
tags: []
---

# Fixer self-review runs in parallel with the verify gate (fix.selfReviewParallel)

In 65% of fix rounds the fixer blocks ~2.0 min (p90 4.4) on its self-review subagent, fully serial before the ~8.6 min verify wait. Start the self-review concurrently with the verify request/early push; a must-fix becomes a new commit pushed under the same claim; the harness withholds the green resume and fix-end refuses a hand-back release until verify is green AND the self-review returned clean.

Source: the read-only fixer work-efficiency study (2026-10-10 ~11:45 ET), recommendation #1. Stacked on #4771
(push-before-gate). The setting lives beside `fix.pushBeforeGate` in we:scripts/lib/fix-push-policy.mjs (same
four-layer cascade: standard → platform → tool → env `WE_FIX_SELF_REVIEW_PARALLEL`), because the shared policy
cascade (#4772) has not landed.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- we:scripts/conveyor/__tests__/await-verify-self-review-parallel.test.mjs`
  fails before (the exports do not exist) and passes after: early push + verify wait proceed while the review is
  pending; a green verdict is withheld until the review returns; must-fix → the repair commit is re-marked and
  early-pushed under the same claim and verified as the new head; `fix-end` refuses a hand-back release while the
  review is pending or must-fix.
- [A2] **Harness, not prose** — `self-review start|clean|must-fix|show` in we:scripts/conveyor/await-verify.mjs
  records the review; the verdict pass (we:scripts/conveyor/await-verify-pass.mjs) reads it and holds the green;
  `fix-end` in we:scripts/conveyor/fix-procedure.mjs reads it and refuses the release. The brief only tells the
  fixer when to call them.
- [A3] **Live proof** — after adoption on the fix daemon, a real fix round's log shows the self-review window
  (`startedAt`..`returnedAt`) overlapping the verify wait, and the round's active time vs the study's 11.5 min median.

## Non-goals

- [N1] Not the other study recommendations (local-test reruns, context pack, harness-owned begin/end, effort routing).
- [N2] Not a second self-review of the must-fix repair commit (one bounded round, as today).

## Edge cases this change must handle

1. **Untrusted text** — `--note` is truncated to 500 chars and only stored; nothing executes it.
2. **Truncated reads** — an unreadable/malformed self-review record reads as null (no record = today's flow).
3. **Shared state files** — one record per (repo key, PR), atomic temp+rename writes like the await store.
4. **Fail closed** — fix-end refuses a hand-back release while a record of THIS session is pending/must-fix; a green is withheld; bounded by `selfReviewMaxMs` (30 min), after which the green resumes with a finish-the-review instruction and fix-end still refuses.
5. **Identity scoping** — a record binds to the session id (else `who`); another session's record never holds a round, and only the owning session may record clean/must-fix.
6. **State over time** — states pending → clean | must-fix → repaired (the repair's `mark` flips it); a red verdict is never withheld.
7. **Who wrote it** — the session's own `CLAUDE_CODE_SESSION_ID` wins over a typed id, as for `mark`.
