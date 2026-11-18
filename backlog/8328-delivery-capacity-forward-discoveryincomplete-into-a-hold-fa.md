---
bornAs: xmkzaom
kind: story
size: 2
status: open
scope: ["we:scripts/lib/delivery-capacity.mjs"]
dateOpened: "2026-11-15"
tags: []
---

# Delivery-capacity: forward discoveryIncomplete into a hold; fail closed on rows without provenance when population=builder

Reinforce-later residuals from PR #6876 (R825): (1) forward discoveryIncomplete from the shared PR reader into a capacity hold in we:scripts/lib/delivery-capacity.mjs instead of dropping it; (2) when population=builder, fail closed on rows that carry no provenance rather than counting them. Each needs a named test for the closed path.

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

## Added 2026-11-15 (cards batch 20)

2026-11-15 15:09 ET MED (R940 follow-up slice): replace the S2 auto-tune time-to-merge rule with resource signals (host headroom averaged, memory pressure, heavy-queue wait, free lanes, open-PR ACTIVE resource use). It must also ignore manual holds as "cap binding" (red-team #6896, we:scripts/lib/delivery-capacity-tune.mjs line 86) and never move a configured cap below/above its bounds by clamping to minUnits (same file, line 30).
