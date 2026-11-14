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

- [A1] **Executable** — a vitest case in we:scripts/readiness/__tests__/heavy-admission.test.mjs asserting that, under `wholeSuite=refuse`, `vitest run --coverage --coverage.include <a coverage path>` and `--coverage --coverage.thresholds.lines=0` exit 125 without calling the executor, while the same command naming a test file still runs.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] This item does not change how a selected or related test run is classified or routed, and does not re-implement Vitest's CLI parser: coverage options are stripped by a closed list of boolean leaves, and anything unknown is read as value-taking.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the command string is quoted-word aware (`'\''` escapes, double quotes, values with spaces) when coverage options are stripped; sibling-path detection in the Vitest config reads dot, bracket (any quote) and non-literal `SIBLING_PATHS` use.
2. **Truncated reads** — n/a: no bounded read is added; the classifier reads the whole command string and the whole config text.
3. **Shared state files** — n/a: no state file is written.
4. **Fail closed** — an untargeted coverage run is refused (exit 125); a non-literal `SIBLING_PATHS` use keeps every sibling in the snapshot rather than dropping one.
5. **Identity scoping** — n/a: no identity or per-caller state is read.
6. **State over time** — n/a: both checks are pure functions of the command and config text at call time.
7. **Who wrote it** — n/a: no marker or authorship is read.
