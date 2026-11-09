---
bornAs: xyfw7x1
kind: story
size: 3
status: open
scope: ["we:scripts/operations/prototype-load-io.mjs", "we:scripts/lib/verify-lane-gate.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Prototype-load combined-tree proof demands the WHOLE tracked test inventory but caps it at the 300 input-targ…

Flow-sim gap R6c-G1, class K19 (proof or inventory check mismatch). Failing input: Prototype load of a daemon fix whose registered overlay refs overlap the candidate (overlapping non-empty and every blocking ref overlapping). Repo has 2126 tracked test files (git ls-files, spec/test pattern). any prototype-load with overlapping stale registrations reaches the combined-tree test Cited: we:scripts/operations/prototype-load-io.mjs:507-516, we:scripts/operations/prototype-load-io.mjs:96-99, we:scripts/operations/prototype-load-io.mjs:100-104, we:scripts/lib/verify-lane-gate.mjs:102, we:scripts/operations/prototype-load-io.mjs:523-530. Soak-break sketch: Fixture: fake repo with 301 tracked *we:.test.mjs files and one overlapping stale registration whose tip is contained in the candidate. Action: run createPrototypeLoader load with the real defaultCombinedTest and stubbed exec. Assertion (fails today): reason …

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
