---
bornAs: xlgphzy
kind: story
size: 3
status: active
scaffoldedBy: "fix-6526"
dateScaffolded: "2026-11-08"
scope: ["we:scripts/lib/review-escalation.mjs", "we:scripts/lib/accept-carry-forward.mjs", "we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-08"
tags: []
---

# Human-clearance readers: repeated comment copies and the label-level accept record are not bound to the shared carry chain

(1) humanClearanceStates processes every occurrence of a repeated comment id in list order, so an overlapped page read placed after the full thread can re-establish an old human source after a plain accept; pick one position per id (or order by createdAt) and test both concatenation orders. (2) latestAcceptRecord (accept-carry-forward) marks humanCleared for any trusted cleared-human marker, including carriers the shared scan rejects, and the across-hold restamp lifts review:held-mechanical on that without checking parseLatestHumanClearedSha; bind it to the shared scan. (3) merge-ai-prs reads a carrier sha through the case-insensitive fallback without the latestHumanClearance guard. Found by the PR 6526 fix self-review (R728).

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
