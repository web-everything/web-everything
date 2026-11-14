---
bornAs: xa9u7rr
kind: story
size: 5
status: open
dateOpened: "2026-11-14"
tags: []
related: ["6821"]
---

# R612 delegated final approval: round-3 audit findings (live holds, binary diffs, check producer) + escalation ownership marker

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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

## Duplicate admission

Parked branch lane/review-daemon-r612-parked @a752a40e2c; audit findings verbatim: (1) we:scripts/lib/delegable-final-approval.mjs:138 eligibility permits live review:changes and review:held-mechanical holds; writer removes both labels. (2) we:scripts/lib/delegable-final-approval.mjs:183 binary-only diffs reach the scorer without inspectable content; probe humanRequired=false. (3) we:scripts/lib/delegable-final-approval.mjs:98 required checks match names alone; reader discards app_id/integration_id so another producer's success authorizes. Option (b): escalation writes a review:human ownership marker the drain humanPinned reader uses.

no card for R612 delegation hardening or an escalation-written hold marker
