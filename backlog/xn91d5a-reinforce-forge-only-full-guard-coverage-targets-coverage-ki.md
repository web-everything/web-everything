---
kind: story
size: 3
status: open
scope: ["we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/forge-exec-bases.mjs", "we:scripts/readiness/forge-exec-run.mjs"]
dateOpened: "2026-11-13"
tags: []
---

# Reinforce Forge-only FULL guard: coverage targets, coverage-kind test, git-head-unavailable root cause

Follow-ups from the forge-no-mac-full-fallback PR: (1) wholeSuiteRefused in we:scripts/readiness/heavy-admission.mjs does not recognise 'vitest run --coverage --coverage.include <path>' as an untargeted whole-suite run (the option value looks like a test target); (2) add named negative tests for the coverage-kind branches of the FULL no-Mac guard (we:scripts/readiness/__tests__/heavy-admission.test.mjs); (3) git-head-unavailable root cause on Forge: why a temp overlay-main-sync repo has no readable git head (we:scripts/readiness/forge-exec-bases.mjs, we:scripts/readiness/forge-exec-run.mjs); the PR only guards it.

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
