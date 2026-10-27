---
bornAs: x589k42
kind: story
size: 2
status: open
scope: ["we:scripts/lib/delivery-policy.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5936 (head c98424019)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5936 (reviewed head `c984240191356fa460333af21a88183e836f356a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/delivery-policy.mjs:77` — (edge-case, degraded) A partial journal tail swallows the next valid event.
   - Scenario: Start with journal contents '{"at":"2026-10' without a trailing newline, as after an interrupted append. Call recordPolicyEvent with a valid mergeGate refusal event, then readPolicyEvents. The probe returned an empty list: the new event was concatenated directly onto the incomplete JSON, making the entire line invalid. Appending after a corrupt partial tail should preserve the new event as a separate readable record.
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
