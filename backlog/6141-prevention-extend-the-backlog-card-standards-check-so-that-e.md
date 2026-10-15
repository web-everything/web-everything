---
bornAs: xmp4wwb
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/x9w8zdl-soak-replay-gate-fail-a-pr-that-adds-a-soak-break-whose-fix.md"]
dateOpened: "2026-10-14"
tags: []
---

# Prevention — Extend the backlog-card standards check so that each non-n/a line under 'Edge cases this change m… (from web-everything/web-everything#5351 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:
1. `we:backlog/6140-soak-replay-gate-fail-a-pr-that-adds-a-soak-break-whose-fix.md:29` — Extend the backlog-card standards check so that each non-n/a line under 'Edge cases this change must handle' must map to an Acceptance item that names a test case.

Already tracked on open cards (recorded there as "Also raised by", not refiled): finding 2 → #5360.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5351@5726955be04ed530007972059ddbc4eff8db72b2

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
