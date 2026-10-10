---
bornAs: xf77029
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5785-one-event-stream-and-one-state-manager-for-all-daemons-the-o.md"]
dateOpened: "2026-10-10"
tags: []
---

# Prevention — Add "Read access and data scrubbing (who may read each kind, what is scrubbed before it leaves th… (from web-everything/web-everything#4822 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/5785-one-event-stream-and-one-state-manager-for-all-daemons-the-o.md:55` — Add "Read access and data scrubbing (who may read each kind, what is scrubbed before it leaves the host)" as a required edge-case class in the decision-card template. Back it with a prepare-time check:standards rule that rejects a card ruling on a shared or hosted store while that class is empty.
2. `we:backlog/5785-one-event-stream-and-one-state-manager-for-all-daemons-the-o.md` — Define stream generation identity or an explicit reset exception, and gate the informer implementation on a deterministic reset-to-lower-sequence conformance test.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 3 → #5668.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4822@3760fbbe0b14f8447eda1168f528a6e47ac1f55f

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
