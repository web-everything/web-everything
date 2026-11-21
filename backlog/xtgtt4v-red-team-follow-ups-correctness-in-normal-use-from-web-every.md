---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7288 (head 8e6255d9b)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7288 (reviewed head `8e6255d9bdef7439063fd627053acff9857ef5b6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:570` — (edge-case, degraded) The discovery budget leaves green PR comment reads unbounded in the exhausted-retry pass
   - Scenario: With 20 owed red PRs, five green open PRs, and 30-second comment reads, main-red discovery reads six PRs, defers fourteen, and performs a five-second refresh: 185 seconds. main then passes all open PRs into sweepExhaustedRetry. The five green PRs were never discovery candidates, so they lack discoveryDeferred and each triggers another comment read. Total elapsed time reaches 335 seconds, exceeding the 300-second deadline before the later recovery passes complete. The shared discovery budget must also cover these additional open-PR reads.
   - Class: correctness-in-normal-use (basis: Confirmed the exhausted-retry function's source in an isolated read-only harness with injected helpers and simulated 30-second reads: it skipped all fourteen deferred red PRs but read all five green PRs, adding 150 seconds. The production main function supplies result.prs to this pass. Deadline termination is inferred from the stated 300-second limit; no live GitHub request was made.)
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
