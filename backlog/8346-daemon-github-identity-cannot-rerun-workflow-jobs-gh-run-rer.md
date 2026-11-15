---
bornAs: xod4ae8
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/review-pr-io.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Daemon GitHub identity cannot rerun workflow jobs (gh run rerun returns 404): grant Actions write or route reruns through an ops workflow

we:scripts/conveyor/review-pr-io.mjs (2026-11-15 04:41 ET, HIGH): the identity used by daemons gets HTTP 404 on gh run rerun on this host, so the B16 S2 stale-gate re-run fails with 'CI gate rerun failed' on #6769. Grant Actions write to the daemon App or token, or route reruns through an ops workflow. Prove on the live case with before/after evidence, not only unit tests.

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
