---
kind: story
size: 2
status: open
scope: ["we:scripts/readiness/forge-exec-run.mjs"]
dateOpened: "2026-11-12"
tags: []
---

# we:forge-exec-run.mjs:789 COVERAGE: The guarantee that all four credential IDs must match lacks a mixed-ID test. (web-everything#6745)

1. `we:scripts/readiness/forge-exec-run.mjs:789` — COVERAGE: The guarantee that all four credential IDs must match lacks a mixed-ID test.

Operator card follow-up for web-everything/web-everything#6745 (head e9b03e68e26e79dc1a2e2ece551a7918342cfb0c).

Not worse than main (R903): coverage-only gap: main has no mixed-ID test for this guard either; the PR adds the guard, so it is not worse than main

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
