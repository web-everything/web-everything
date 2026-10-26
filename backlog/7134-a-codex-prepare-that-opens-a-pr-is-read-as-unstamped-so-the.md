---
bornAs: x86vjdu
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# A Codex prepare that opens a PR is read as "unstamped", so the builder re-dispatches it and opens duplicate prepare PRs

[held entry 347] (coroner 2026-10-14, held, HIGH) A Codex prepare that opens a PR is read as "unstamped", so the builder re-dispatches it and opens duplicate prepare PRs. Started after prepare.runner=codex went live (#5303, ~18:00 ET). #5028 was launched 11 times and opened 4 PRs (#5327 merged, #5330 escalated at round 6, #5342 stood down 6h, #5350 merged). #5694 opened 2 PRs (#5324, #5337), both merged. "Parked needs-you" (23:05 ET) did not stop the re-dispatch at 00:22 ET. That makes 9 prepare-failure-policy rows in 6h. Fix idea: the prepare settle step reads the Codex runner's result (the PR opened plus its stamp commit) the same way it reads Claude's; "parked needs-you" holds the card for dispatch; a card with an open prepare PR is never re-prepared. Evidence: build-dispatch-daemon.log prepare-failure-policy rows 10-14 22:46Z–10-15 01:47Z; PRs above. Scope: we:scripts/conveyor/build-dispatch-daemon.mjs (prepare-failure-policy, settle), prepare runner adapter. Size 3.

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
