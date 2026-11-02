---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# After a main-ci-retriggered the recovery watch never says whether main went green

MED priority hint. - (coroner 2026-10-26, held) After a main-ci-retriggered the recovery watch never says whether main went green. On 2026-10-26 the 22:01Z retrigger was reported as success and nobody checked the result; main stayed red from 21:25Z for hours and about 15 ready PRs sat behind the red-main hold. R151 only covers the orchestrator habit. Fix idea: after a retrigger, the watch follows that run and emits main-ci-green or main-ci-still-red (with the failing test name), and re-escalates when still red after the second run. Evidence: orchestrator session bd616854 (23:17Z admission), drain log "main is red since 21:25:58Z". Scope: we:scripts/ (ci-red-recovery pass). Size 3.

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
