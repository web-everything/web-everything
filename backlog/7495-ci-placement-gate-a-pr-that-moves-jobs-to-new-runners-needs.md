---
bornAs: xsh72w5
kind: story
size: 5
status: open
scope: ["we:.github/workflows/", "we:scripts/readiness/"]
dateOpened: "2026-10-29"
tags: []
---

# CI placement gate: a PR that moves jobs to new runners needs one green run of the real jobs there before merge

#6003 moved unit shards onto hetzner-we and merged although every hetzner job died at startup (EACCES), so no test ever ran on Forge; 11 env-dependent failures surfaced only after #6064/#6067. A job-placement change (runs-on / runner-group edits in we:.github/workflows/) must carry a green run of the moved jobs on its own head on the target runners; a job that fails before running tests must block, not pass silently.

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
