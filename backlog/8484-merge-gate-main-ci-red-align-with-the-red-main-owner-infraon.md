---
bornAs: xio4i72
kind: story
size: 3
status: active
scaffoldedBy: "fix-4715"
dateScaffolded: "2026-10-11"
scope: ["we:scripts/merge-gate-check.mjs", "we:scripts/conveyor/main-ci-red-io.mjs", "we:.github/workflows/merge-gate.yml"]
dateOpened: "2026-10-11"
tags: []
---

# merge-gate main-CI red: align with the red-main owner (infraOnly runs, wider fix-PR set, actions read, push-event filter)

Follow-up from PR #4715 (operator ruling 2026-10-11: merge-gate reads main CI). (1) The gate counts a failed main run whose bad jobs were only cancelled or runner-lost as red, while the owner probe (infraOnly) sees nothing to fix: deadlock until a rerun. (2) The gate exempts only trusted lane/main-fix-<sha9> PRs; the owner's PR finder also accepts lane/red-main-* branches, sha-in-title and fixes-<sha> bodies, and GitHub revert-<n>-* or human fixes are held (admin bypass only). (3) The we:.github/workflows/merge-gate.yml permissions have no actions read; the runs read relies on public-repo access, unproven on a live run, and breaks if the repo goes private (workflow edit, human-only). (4) The runs read in we:scripts/conveyor/main-ci-red-io.mjs lacks an --event push filter, so a fork PR on a branch named main counts as a main run.

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
