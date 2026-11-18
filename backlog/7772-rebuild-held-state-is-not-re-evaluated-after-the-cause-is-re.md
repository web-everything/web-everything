---
bornAs: xenjmgf
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-11-02"
tags: []
---

# Rebuild "held" state is not re-evaluated after the cause is removed (10-29

HIGH priority hint. - [HIGH] Rebuild "held" state is not re-evaluated after the cause is removed (10-29: review daemon held since 20:27 ET on established-overlay-conflict for lane/forge-remote-heavy-admission-m1; overlay removed ~20:29 ET; at 20:46 ET still held, no rebuild attempt, so quick-mode/ci-parallel/deadlock prototypes cannot adopt). daemon-overlay remove/add should wake the rebuild and clear a hold whose failing ref is gone.   - UPDATE 20:52 ET: deadlock premise was partly wrong — those merge-gate reds were from red main; re-run fires once main green (00:01Z). Draft fix audited WEAKENED (breaks card 273/278 "real merge-gate failure remains healable"); discarded. Better shape: dispatch review IN PARALLEL with a merge-gate-only rerun/heal (no heal-attempt spend) — fold into R231 #6085 review.startBeforeCi.

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
