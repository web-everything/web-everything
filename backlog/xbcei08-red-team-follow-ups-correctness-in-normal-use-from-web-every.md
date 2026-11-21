---
kind: story
size: 2
status: open
scope: ["we:scripts/lane-pool.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7208 (head 079ee7616)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7208 (reviewed head `079ee761603ca2cfec5c13c759c8840356edbcb1`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lane-pool.mjs:3693` — (failing-input, degraded) release --discard cannot recover a pinned lane with conflicting tracked edits
   - Scenario: Let main contain file.txt='initial' and pushed lane/target tip T contain file.txt='target'. Acquire with --lane=1 --at=T --branch=lane/target, modify file.txt to 'worker edit', then run release --lane=1 --discard. The discard flag bypasses both tracked-work refusals, but the final checkout omits --force. Git refuses because switching to main would overwrite file.txt, returning reset-failed and retaining the pinned lease. The explicit discard should permit discarding these tracked edits, restoring main and clearing the lease while preserving protected ignored files.
   - Class: correctness-in-normal-use (basis: Code-path evidence rather than a live filesystem reproduction: discard bypasses the dirty checks but never changes the checkout arguments. Git's checkout help confirms that --force discards local modifications; the invoked checkout lacks it. This requires ordinary tracked edits, without concurrency or attacker-controlled metadata.)
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
