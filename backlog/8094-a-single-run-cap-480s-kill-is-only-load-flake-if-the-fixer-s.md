---
bornAs: xd4cjmw
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/stand-down.mjs", "we:scripts/conveyor/stand-down-auto-proceed.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# A single-run-cap (480s) kill is only load-flake if the fixer's free-text reason matches three prose regexes; …

Flow-sim gap R5b-G2, class K13 (precondition mismatch fails closed to the operator). Failing input: Fix session ran a wrapped heavy command; heavy-admission killed it at the single-test run cap (we:heavy-admission.mjs:2458-2464 sets exitCode 124 and logs 'single-test run exceeded Nms and was stopped'). No verify marker is written for this kill, so await-verify-pass's structured detector sees nothing (isLoadFlakeRed needs mark… Cited: we:scripts/conveyor/stand-down.mjs:792, we:scripts/conveyor/stand-down.mjs:404-414, we:scripts/conveyor/stand-down.mjs:540-541, we:scripts/conveyor/stand-down-auto-proceed.mjs:53, we:scripts/conveyor/reconcile-core.mjs:2589-2599. Soak-break sketch: Fixture: trusted stand-down reason=gate-red, detail 'red only on host load: run killed at the 480s single-run cap', no alt sha. Action: isLoadOnlyRedStandDown(c) and countUnresolvedStandDowns([c]). Assert true / 0. Fails today (false / 1). Better: a structure…

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
