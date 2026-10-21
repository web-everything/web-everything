---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/accept-carry-forward.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5506 (head ba61f750d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5506 (reviewed head `ba61f750d646af8cdb5b625de5228f6cf6a7e76c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/accept-carry-forward.mjs:144` — (failing-input, degraded) Valid hash-card notices still block clearance carry
   - Scenario: After a human clearance, retry prevention filing when findFiledApprovalPrevention returns {num:'x3k9ab2',rel:'we:backlog/x3k9ab2-prevention.md'}. runApprovalPreventionFiling emits its normal notice ending '— we:backlog/x3k9ab2-prevention.md (#x3k9ab2).'. Hash IDs are supported by findApprovalPreventionCardOnDisk, but fixedText only permits numeric IDs or '?'. An in-memory probe of the production function bodies confirmed that this exact notice from chalbert returns isKnownMachineBody=false and makes latestAcceptRecord report laterVerdict=true; numeric and '?' controls pass. Consequently, a subsequen
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
