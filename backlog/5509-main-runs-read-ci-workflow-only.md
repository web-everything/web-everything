---
bornAs: xfrjlsi
kind: story
size: 2
status: open
dateOpened: "2026-10-08"
tags: []
---

# main-red attribution drifts: main run history is read across all workflows, so the red window scrolls away

defaultReadMainRuns lists the last 100 runs of ALL workflows on main (CI, CodeQL, release-please, deploy) then keeps CI only, so it sees ~1.5h of CI history. Live 2026-10-08: PRs #4494/#4446 were 'owed-ci-rerun' (main-red) at 21:59 and 'own-failure' (ci-heal launched 22:29) only because the window's start scrolled out of the read. Pass --workflow to gh run list so the 100 runs are CI runs.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
