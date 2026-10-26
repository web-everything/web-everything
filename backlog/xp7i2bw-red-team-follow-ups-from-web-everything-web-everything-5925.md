---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/orphan-fix-round.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5925 (head dcbd47f4d)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5925 (reviewed head `dcbd47f4d22b37e26c3d8fc6cc2c4934a0409223`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/orphan-fix-round.mjs:119` — (failing-input, degraded) Malformed ruling history falls through to automatic re-arm
   - Scenario: On an unchanged head with review:changes and no review:human, append: a blocked-referral verdict containing 'on head' but no Net basis; a valid operator not-real ruling settling all referrals; a trusted operator-ruling comment with '&lt;!-- mandatory-referral-operator-ruling-v1: not-base64 --&gt;'; a trusted fix-evidence comment; and FIX_END_MARKER. After the grace period, the gate reports protectionMalformed=true and pending=[malformed-operator-ruling], yet the planner returns rearm. The malformed-history exception is swallowed, and fallback interprets the absent Net basis as head movement. Malform
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
