---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-queue-safety.mjs"]
dateOpened: "2026-11-27"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style] from web-everything/web-everything#7616 (head 4501b9fab)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7616 (reviewed head `4501b9fab86bc3bfc7dd599384f66ea726069dc2`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-queue-safety.mjs:1255` — (edge-case, degraded) An earlier merge-conflict removal prevents relief for a confirmed current-head failure
   - Scenario: Give PR #42 a complete timeline containing an older-head merge_conflict removal, a subsequent enqueue, and a failed_checks removal bound to its current head H. The guard holds #42 but assigns cause unknown because the every-event predicate rejects merge_conflict. Consequently, smaller overlapping ready PR #43 still yields to #42. Removing only the older conflict produces cause head-failed and releases #43. The recognized historical conflict should not invalidate the independently confirmed current-head failure; #42 should remain held while #43 receives the promised relief.
   - Class: live-reproduced (basis: A read-only Node probe invoked the actual guard, held-key builder, filter, and overlap planner with injected GitHub responses. The failure-only control returned head-failed with no waits; adding the older-head conflict returned unknown with #43 waiting on #42. Unused missing Markdown and glob dependencies were stubbed for module loading.)
   - Also class: coverage-or-style
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
