---
kind: story
size: 1
status: open
scope: ["we:scripts/lib/jury-core.mjs", "we:scripts/operations/review-pr-io.mjs"]
dateOpened: "2026-10-12"
tags: []
---

# Carried referral rulings are re-checked, not copied; carry note names the real ruler

Held finding 243 (2026-10-11). The referral carry rule copies an earlier block forward when the cited line text is unchanged, without re-checking the defect; on #4715 that produced a false 3-miss ruling dispute (all 5 were met). Also the carry note always says "the operator ruled" even for reviewer rulings (jury-core REFERRAL_CARRY_REASON), which misled the orchestrator on #4631. Fix: re-judge a carried block against the current head before it counts; word the note by the real actor.

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
