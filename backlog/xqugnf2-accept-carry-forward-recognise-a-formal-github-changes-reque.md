---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs", "we:scripts/review-set-label.mjs", "we:scripts/conveyor/accept-carry-sweep.mjs"]
dateOpened: "2026-10-10"
tags: []
---

# Accept carry-forward: recognise a formal GitHub CHANGES_REQUESTED review and an operator free-text hold after a clear-human

PR #4631 residuals. FIXED IN THE PR (round 3): a native GitHub review standing against the accept (any state but APPROVED / DISMISSED, read through the paginated `pulls/{n}/reviews` call; unreadable = retryable refusal) and operator free text after a clear-human (the rule is inverted: a comment that is not a known machine shape — we:scripts/lib/accept-carry-forward.mjs#isKnownMachineBody — supersedes the accept, whoever wrote it), and a person's remove + re-add of `review:human` inside the park window (the timeline since the park row must hold exactly the drain's one add). The label-only hold, the held-park laundering and the sweep cwd/memo findings were fixed in rounds 1-2. Round 10 (operator ruling 2026-10-10 ~14:20 ET, option a) SUPERSEDES the rounds 2-9 hold-origin proofs (ledger row, live-read attestation, label timeline, event counts — all removed): the drain's mechanical park now holds with its OWN label `review:held-mechanical` (we:scripts/merge-ai-prs.mjs#decideTestGamingPark, only on a carry read miss; a decided refusal parks `review:human`), the carry lifts only that label, and `review:human` is never removed automatically. The concurrent-add and remove + re-add holes are closed by construction (a person's `review:human` is a different label). A decided refusal across the drain label hands the hold to the operator (`review:human` + awaiting-advisory, with a comment). Round 11 (operator ruling 2026-10-10 ~19:25 ET: a native GitHub "changes requested" review from any trusted reviewer identity, including plateau-reviewer[bot] and the operator, stops the carry; check the LATEST formal review state): we:scripts/lib/accept-carry-forward.mjs#laterReviewHold now also holds when any reviewer's latest decisive review (APPROVED / CHANGES_REQUESTED / DISMISSED) is CHANGES_REQUESTED, whatever its time (a restamp re-dates the accept record, so timing alone laundered a change request filed between the clearance and a restamp), and counts a review in the same second as the accept; and every restamp that carries an operator clearance (the plain and CI-heal restamps through `decideRestampHumanClearance`, not only the across-hold carry) reads the formal reviews first (unreadable = retryable refusal, standing = decided refusal, nothing written).

Still owed here, same defect class: (0) the machine-shape list is an allowlist — a NEW bot comment shape that is not added to `KNOWN_MACHINE_SHAPE_RES` refuses the carry (fails safe, the operator re-reviews), and a bot's `COMMENTED` review does the same; extend the list as live threads show new shapes (not yet listed, so they refuse a carry: the red-team advisory, converted-advisory notes, the load-flake hold). (0a) the PLAIN restamp of an already `review:accepted` PR (we:scripts/review-set-label.mjs#decideRestampHumanClearance, and the drain's own restamp) checks only the formal reviews before carrying a clearance (round 11), not later COMMENT holds, so it can still re-date a `cleared-human` record past a free-text objection; a restamp of a plain AGENT accept (no clearance) reads no formal review at all, so it carries `review:accepted` past a standing change request; hold forms beyond comments, reviews and `review:*` labels (draft conversion, `blockedBy` edits in the PR body) are not read either. (0b) prevention: a standards rule that flags new decision logic written inline in we:scripts/merge-ai-prs.mjs#runCli (the drain carry was extracted to `carryHumanClearanceOnIdenticalDiff` in round 3 for lack of one). (a) observability surfaces that list hold labels by hand do not yet name `review:held-mechanical`: we:scripts/conveyor/pr-watch.mjs#PARK_LABELS (a held PR polls to timeout instead of exiting parked), we:skills-src/conveyor/review-daemon.mjs#EXPLAINED_HOLD_LABELS (no per-tick "why" line), and we:scripts/lib/verdict-ledger.mjs#labelVerdictOf (the drain writes no ledger row for the mechanical park; the comparator reads the label as no verdict); the operator views (progress-board, operator-queue, status-artifact, pr-state holds, tick-core, status-board) key on the literal `review:human`, so a PR on the drain label reads as unheld until the sweep lifts it or hands it off. (b) we:scripts/lib/review-escalation.mjs#decideReviewGate has no branch for the drain label (merge safety holds via `hasUnclearedReviewLabel`; with escalation on it may add `review:pending`, dispatching agent reviews whose accept is refused). (c) the drain parks `review:human` (not the drain label) when its first `gh pr view` of the clearance fails, or the clear-human is past its one comment page: a read miss there still costs a second operator approval. (e) "only the drain writes `review:held-mechanical`" is not enforced: a person with triage rights adding it by hand gets a carry (still only on a proven identical-diff clear-human). (d) no compare-and-swap between the proof reads and the label swap (two concurrent restamp runs).

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
