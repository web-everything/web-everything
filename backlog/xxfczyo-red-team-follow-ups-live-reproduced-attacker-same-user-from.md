---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/check-scope.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user] from web-everything/web-everything#7256 (head ee55c22ed)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7256 (reviewed head `ee55c22edc6c52a66e06d46ce0f1f243ca6308c3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/check-scope.mjs:27` — (failing-input, degraded) Path normalization erases globstars and misses a live claim
   - Scenario: Register a live worker with files=['we:src/**/../a.mjs'], then check declaredFiles=['we:src/sub/a.mjs']. canonicalScope collapses the claim to we:src/a.mjs, and checkScope returns ok:true with no overlaps. The existing assessFreeScope returns occupied for the same registered claim and target. A globstar can span multiple directories, so removing '**/..' narrows the scope incorrectly. Preserve conservative overlap detection or refuse this ambiguous pattern instead of declaring it clear.
   - Class: live-reproduced (basis: Observed in a read-only Node probe using the actual registerScope, assessFreeScope, canonicalScope and checkScope functions with an injected snapshot containing the live registered worker.)
   - Also class: attacker-same-user
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
