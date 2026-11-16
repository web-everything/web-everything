---
bornAs: xlbpghj
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/"]
dateOpened: "2026-11-15"
tags: []
---

# Freeze fixer pushes on an accepted, red-team-clear, cleared PR unless CI is red; carry clearance across a pure rebase

we:scripts/conveyor/review-referral-hold.mjs B19 (2026-11-15 01:46 ET): after clear-human on #6770 a fixer or ci-heal pushed 7e2712b3, voiding the clearance and starting another red-team round at the cap. Freeze fixer pushes on a PR that is accepted, red-team-clear and cleared unless CI is red, and carry clearance across a pure rebase or merge-main push. Prove on the live case with before/after evidence.

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
