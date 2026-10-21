---
bornAs: xb5ub6g
kind: story
size: 5
status: open
scope: ["we:.github/workflows/", "we:scripts/ci/"]
dateOpened: "2026-10-18"
tags: []
---

# Nightly CI stress run that finds flaky and slow tests

Add a scheduled GitHub Actions workflow (nightly, off-peak ET) in we:.github/workflows/ that runs the unit suite N times (cascade setting testStress.repeats, default 5) under CPU strain (setting testStress.parallelism, plus an optional stress-ng style load), on CI runners, not the laptop. It reports tests that pass on some runs and fail on others (flaky) and per-file durations above testStress.slowFileSec (default 30; shares the value with the proto-test step in card x2bm019). Every setting's source is logged. Output: an artifact or JSON report, plus one card per newly found flaky or slow test, deduped by test id. The filer is the same Sonnet-class one already in use. Helper scripts live in we:scripts/ci/. No node or merge gate: it only reports, never blocks a PR. Why: merge-queue CI failures and slow local runs (for example we:scripts/__tests__/review-set-label.test.mjs at 62 s; an integrator spent more than 1 h on suite runs on 2026-10-18). Operator 2026-10-18: Might want to build the nightly ci stress test to find unstable or slow tests.

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
