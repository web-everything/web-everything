---
bornAs: x6auqu6
kind: story
size: 1
status: open
scope: ["we:scripts/conveyor/__tests__/resolve-runner-checkout.test.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Deflake resolve-runner-checkout test: inject PATH and a fake ps, no host ps

2026-11-15 11:00 ET MED deflake: 'shells the real default execFn - a fake ps on PATH naming the runner verifies true' failed on main CI (run 43730875744, 74fcb99b7f, after card-only merges; expected true got false). The real-ps shell-out depends on the CI host; make it deterministic (inject PATH and a fake ps, no host ps). Quarantined 24h (owner card:resolve-runner-ps-flake).

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
