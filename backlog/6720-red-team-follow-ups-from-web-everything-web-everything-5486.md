---
bornAs: xeqkchn
kind: story
size: 2
status: open
scope: ["we:scripts/operations/prepare-batch.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5486 (head dfb22d51c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5486 (reviewed head `dfb22d51c23bf2ba4c870bace7f350f985799949`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/prepare-batch.mjs:7` — (edge-case, degraded) Concurrent batches each spend the full external concurrency allowance.
   - Scenario: Start two batches with at least three cards each, batchMaxParallel=3 and batchExternalCap=4. The daemon permits two prepare coordinators, but each independently launches three workers. A read-only probe invoking both coordinators concurrently measured peak=6 with cap=4; both completed successfully. No shared reservation accounts for workers in the other batch or existing external builds. Reserve shared external capacity before launching card workers so overlapping batches cannot exceed the configured allowance.
   - Claude's re-check: demonstrated break

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
