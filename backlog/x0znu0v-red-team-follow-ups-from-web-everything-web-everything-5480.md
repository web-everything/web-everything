---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/drain-prestage.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5480 (head cc896d30e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5480 (reviewed head `cc896d30e430f156f88eef0251d358fe14f88fd6`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/drain-prestage.mjs:95` — (edge-case, degraded) Cached admission survives changes to the acceptance evidence
   - Scenario: Pre-stage accepted head A while CI is pending. Before CI completes, the trusted reviewer edits the acceptance comment's reviewed-sha from A to B, leaving the head, labels, body and base unchanged. When CI becomes green, enqueuePrestage still enqueues A. A read-only probe using the real review gate and merge strategy reproduced one enqueue mutation, while decideDrainReviewGate on the updated comments returned park with staleAcceptance=true. The shortcut should revalidate acceptance coverage or invalidate preparation when that evidence changes. A later merge-group gate may reject it, but enqueue
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
