---
kind: story
status: open
size: 2
dateOpened: '2026-10-31'
scope: ['we:scripts/readiness/forge-setup.sh', 'we:scripts/readiness/__tests__/forge-worker-pool.test.mjs']
tags: [forge, testing]
---

# Test the Forge installer's default of eight worker slots

Two advisory findings in PR #6059 (simplicity and codex-correctness, 2026-10-31)
describe the same missing case: `we:scripts/readiness/forge-setup.sh:21` defaults
an unset `FORGE_EXEC_SLOTS` to eight, but the review found no named test of that
unset environment. Track both reports here without changing installer behavior
in the coverage repair.

## Acceptance

- A named hermetic installer test removes `FORGE_EXEC_SLOTS` from the child
  environment and observes exactly eight planned slot users/directories.
- The test executes the installer path with fixture system commands; it must not
  create host users or change the host sudoers file.
- Retain explicit-count and invalid-count coverage.

## Test plan

Extend the installer fixture in `we:scripts/readiness/__tests__/forge-worker-pool.test.mjs`.
Prove the default case fails if the shell default changes to another count.

## Non-goals

No change to the default count, pool isolation policy or production host state.
