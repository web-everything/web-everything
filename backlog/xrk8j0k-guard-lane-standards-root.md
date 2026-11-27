---
kind: task
status: active
scaffoldedBy: "steward-7583"
dateScaffolded: "2026-11-27"
scope: ["we:scripts/guard-lane.mjs", "we:scripts/__tests__/guard-lane.test.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# guard-lane: derive the Standards root from the guard script's own location, not the operated checkout (we#7583 red-team break)

Red-team break at we#7583 head 5bc8d513: we:scripts/guard-lane.mjs:230 builds the Standards root from the operated checkout (WE_HOOK_ROOT via we:scripts/hooks/run-pinned-guard.mjs:335), so a seat-pool or scratch-clone cwd gets no Standards protection. Not a regression (main has no Standards ownership check); fix: also check the workspace derived from the guard script's own location, with a red-green seat-pool test in we:scripts/__tests__/guard-lane.test.mjs. Judge ruling 2026-11-27 15:46 ET: we#7583 CLEAR; this is the fix-now follow-up GUARD-LANE-STANDARDS-ROOT (security).

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
