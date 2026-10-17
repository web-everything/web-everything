---
kind: story
size: 3
status: open
scope: ["we:scripts/lib/numbering-carry.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Fix unfixed red-team break (PR 5233): numbering carry leaves an acceptance when the post-write read fails

Operator 2026-10-17: Ok. Real confirmed red-team break (broken, edge-case) never fixed on PR 5233, which merged 2026-10-15. we:scripts/lib/numbering-carry.mjs:595 - The daemon leaves an authoritative acceptance when its post-write verification is unreadable. Scenario: review:pending plus review:accepted; a formal COMMENTED objection arrives between the successful pre-write check and the numbering comment; the post-write comments read succeeds but the formal-reviews read fails and returns null; restampAfterNumbering returns retry with commentPosted:true without withdrawing its record because check.hold is false; readDrainAcceptance then reports the new head as accepted and reconcileDrainReviewPending invokes to:accepted without reading formal reviews. The new record must stay inert or be withdrawn when post-write verification is unreadable. Confirmed by the Claude re-check. Source: red-team-analysis quality sample (20 breaks: 3 real never fixed).

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
