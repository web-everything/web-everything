---
bornAs: xsgc4w9
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5209-prevention-delete-the-receipt-after-a-successful-apply-or-re.md"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — A deterministic check that every we:path:N-M citation in a backlog card falls inside the file and… (from web-everything/web-everything#5315 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5209-prevention-delete-the-receipt-after-a-successful-apply-or-re.md:26` — A deterministic check that every `we:path:N-M` citation in a backlog card falls inside the file and, ideally, starts and ends on a statement boundary. This would go in check:standards or check-backlog-item.
2. `we:backlog/5209-prevention-delete-the-receipt-after-a-successful-apply-or-re.md` — Add the planned CLI regression with parsed-stdout assertions so automated tests enforce the structured failure contract.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5315@4b8bb0c5490599e2a73634f765f4faf729df4e6e

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
