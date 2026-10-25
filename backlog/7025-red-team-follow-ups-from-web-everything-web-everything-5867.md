---
bornAs: xuhvots
kind: story
size: 2
status: open
scope: ["we:scripts/operations/adoption-matrix.mjs", "we:scripts/codex-direct-task.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5867 (head 771d58fc2)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5867 (reviewed head `771d58fc2b02bafb811eb0c7bc2e249ae1ea16f2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/adoption-matrix.mjs:21` — (edge-case, degraded) Refreshing a ref does not update its eviction order when timestamps tie.
   - Scenario: Supply 50 records for fix/0 through fix/49 with identical timestamps, then another fix/0 record with a new SHA and the same timestamp, followed by fix/50 at that timestamp. The reader drops fix/0 and retains fix/1. This was reproduced through createAdoptionMatrixReader. Map.set preserves the original insertion position, so eviction loses the second-most-recent record despite the documented later-line tie breaker. It should retain refreshed fix/0 and evict fix/1.
   - Claude's re-check: demonstrated break
2. `we:scripts/codex-direct-task.mjs:1411` — (edge-case, degraded) A backward clock adjustment stalls detection of a completed job inside the new sleep loop.
   - Scenario: Call waitForJob with maxMs=5000 and pollMs=1000. During the first sleep, complete the job and move the clock backward 60000 ms. An injected-clock probe reproduced sleep requests of [1000,60000], with the completed result returned after 61000 simulated milliseconds. The new inner loop waits for the old wall-clock target before reading the completed record again. Completed-job detection should continue at the polling interval despite wall-clock adjustments, using monotonic elapsed time.
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
