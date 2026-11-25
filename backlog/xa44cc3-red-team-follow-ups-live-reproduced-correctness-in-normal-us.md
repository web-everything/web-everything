---
kind: story
size: 2
status: open
scope: ["we:wip-relay.js"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from plateauapp/plateau-app#240 (head c58a0d563)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#240 (reviewed head `c58a0d5635c64ba5990d8cf8f793a00b8c1674a7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:wip-relay.js:1529` — (failing-input, degraded) Published workers retain impossible activity timestamps
   - Scenario: In an otherwise valid snapshot, set workers to a single worker with state 'running', description 'task', branch null, and lastActivity '2026-02-30T14:00:00Z'. validateDeliveryPublished returns ok:true and preserves the impossible timestamp without warning. PLT-DS-007 and protocol vector PLT-DS-V21 require calendar-valid RFC 3339 activity timestamps. The malformed worker should be dropped with a named warning.
   - Class: live-reproduced (basis: A direct Node probe against the checked-out exported validator reproduced acceptance and preservation of the impossible date. No route integration is assumed.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:wip-relay.js:1592` — (edge-case, degraded) Applying the warning cap twice understates omitted warnings
   - Scenario: Start with a valid snapshot, append 60 malformed work items with IDs BAD0 through BAD59 and numeric title 42, and set warnings to ['old warning']. validateDeliveryPublished returns 49 named warnings followed by '+2 more warnings'. There are 61 distinct warnings, so the summary should read '+12 more warnings'. validateDelivery caps its warnings first; the publishing merge counts the resulting summary as one warning and discards its represented count.
   - Class: live-reproduced (basis: A direct Node probe reproduced the incorrect '+2 more warnings' result. The same input passed to validateDelivery alone reports '+11 more warnings', confirming that the publishing merge loses the previously summarized count.)
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
