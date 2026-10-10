---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/review-set-label.mjs", "we:scripts/conveyor/accept-carry-sweep.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Accept carry-forward: recognise a formal GitHub CHANGES_REQUESTED review and an operator free-text hold after a clear-human

PR #4631 residuals. FIXED IN THE PR (round 3): a native GitHub review standing against the accept (any state but APPROVED / DISMISSED, read through the paginated `pulls/{n}/reviews` call; unreadable = retryable refusal) and operator free text after a clear-human (the rule is inverted: a comment that is not a known machine shape — we:scripts/lib/accept-carry-forward.mjs#isKnownMachineBody — supersedes the accept, whoever wrote it), and a person's remove + re-add of `review:human` inside the park window (the timeline since the park row must hold exactly the drain's one add). The label-only hold, the held-park laundering and the sweep cwd/memo findings were fixed in rounds 1-2.

Still owed here, same defect class: (0) the machine-shape list is an allowlist — a NEW bot comment shape that is not added to `KNOWN_MACHINE_SHAPE_RES` refuses the carry (fails safe, the operator re-reviews), and a bot's `COMMENTED` review does the same; extend the list as live threads show new shapes (not yet listed, so they refuse a carry: the red-team advisory, converted-advisory notes, the load-flake hold). (0a) the PLAIN restamp of an already `review:accepted` PR (we:scripts/review-set-label.mjs#decideRestampHumanClearance, and the drain's own restamp) carries a clearance with no later-hold check, so it can re-date a `cleared-human` record past a later objection; hold forms beyond comments, reviews and `review:*` labels (draft conversion, `blockedBy` edits in the PR body) are not read either. (0b) prevention: a standards rule that flags new decision logic written inline in we:scripts/merge-ai-prs.mjs#runCli (the drain carry was extracted to `carryHumanClearanceOnIdenticalDiff` in round 3 for lack of one). (a) hold origin is still proven by timing plus event counts, not cause: an operator add that lands BEFORE the drain's own (then no-op) add inside the window, from the same login, is indistinguishable from the park; a head-bound drain marker on the park would prove cause. (b) the sweep plan admits `held — a review hold` / escalation-policy / manifest-tamper drain parks but the restamp CLI can only prove a test-gaming park, so those get one settled refusal per head. (c) the ledger is read from the home file only; with `verdictLedger.store=git` the feature silently never fires. (d) no compare-and-swap between the proof reads and the label swap (two concurrent runs). (e) ledger `at` (local clock) vs GitHub event time: skew beyond the 5 s early tolerance refuses.

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
