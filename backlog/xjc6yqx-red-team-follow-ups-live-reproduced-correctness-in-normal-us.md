---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/resource-pool-io.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7383 (head 7ad3e6649)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7383 (reviewed head `7ad3e6649f0fdd501bdbade71a00e74ed098c5fd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/resource-pool-io.mjs:150` — (failing-input, degraded) A higher settings layer hides enforce mode instead of preserving the required unknown result.
   - Scenario: With the checked-in tool defaults, set platform resourcePool.mode to enforce and leave numeric and enum overrides absent. loadPoolSettings returns configuredMode shadow and unknown false because the tool's shadow value overwrites enforce before the check. Passing those settings to grantDecision with budget 30, held [], class 4 and size 1 returns grant. Tool enforce overridden by env shadow reproduces the same failure. The unsupported enforce layer should preserve unknown true and produce hold.
   - Class: live-reproduced (basis: Observed using the settings loader and real cascade dependencies, omitting unrelated inventory imports because gray-matter is unavailable. This breaks the stated per-layer fail-closed contract; current decisions remain advisory and do not allocate capacity.)
   - Also class: correctness-in-normal-use
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
