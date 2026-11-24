---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-self-sync.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7445 (head 4986b05f9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7445 (reviewed head `4986b05f917a324f49fd08392dd60af2d7b0d704`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-self-sync.mjs:236` — (failing-input, degraded) Urgency ignores stale-refusal shapes used by build-dispatch and fix-dispatch
   - Scenario: After a recent rebuild finishes, build-dispatch returns cloneStale containing a 29-commit STALE refusal. Its hasStaleRefusal callback returns true, but staleRefusalBehind reads only failed[].error and repos[].error, returns 0, and requests another ordinary spaced rebuild. The same failure occurs when a CI-heal phase reports refusals[].why while the fix phase's repos entries succeed. Both should request urgent rebuilding because 29 exceeds 10; instead dispatch remains blocked until spacing expires.
   - Class: correctness-in-normal-use (basis: A read-only probe evaluating the shipped parser returned 0 for both production result shapes and 29 for the review-shaped control. Caller inspection confirms build-dispatch uses cloneStale and fix-dispatch aggregates other phases into refusals[].why. Full module execution was unavailable because this checkout lacks js-yaml.)
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
