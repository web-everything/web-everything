---
bornAs: xsz63q0
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/rearm-review.mjs"]
dateOpened: "2026-11-02"
tags: []
---

# Send-back preamble contradicts the fixer brief's re-arm step

MED priority hint. ## (held 2026-10-25 15:34 ET) Send-back preamble contradicts the fixer brief's re-arm step Operator send-back preamble says "Do not touch any review label", while the fixer brief says to run we:rearm-review.mjs (which changes review state). Seen on #5878 (fixer refused / denied). Fix: one source for the re-arm instruction. The preamble should exempt the sanctioned rearm-review step by name. - 2026-10-25 16:22 ET: 2nd case: #5922 needs-you at 20:21Z was stale (its only referral already had a card ruling; the PR was already back in review). Two false alarms in one hour; raise priority.

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
