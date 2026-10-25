---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# The builder was frozen on every tick for 28h and built nothing

[held entry 348] (coroner 2026-10-14, held) The builder was frozen on every tick for 28h and built nothing. 198/198 ticks were held on "19 of 36 open PRs counted > maxOpenPrs 12". The counted PRs included stood-down, round-cap-escalated and needs-you PRs that only the operator can move (#5237, #5243, #5233, #5242, #5169). Card 186 only excluded card-only and accepted PRs. Fix idea: maxOpenPrs counts only PRs the system is actively moving (not stood-down, at-round-limit, needs-you or review:human waiting on a person). A freeze longer than build.freezeAlertHours (default 2) adds a NEEDS YOU row naming the PRs that hold it. Evidence: build-dispatch-daemon.log tick rows freeze.frozen=true from 10-14 06:42Z to 10-15 11:03Z. Scope: we:scripts/conveyor/build-dispatch-policy.mjs, operator-queue. Size 2.

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
