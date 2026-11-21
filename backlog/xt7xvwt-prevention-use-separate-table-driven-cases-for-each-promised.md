---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/__tests__/author-stamp-restore.test.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Use separate table-driven cases for each promised refusal and a targeted mutation gate requiring… (from web-everything/web-everything#7297 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/__tests__/author-stamp-restore.test.mjs:206` — Use separate table-driven cases for each promised refusal and a targeted mutation gate requiring the corresponding named test to fail when that refusal is removed.
2. `we:scripts/lib/__tests__/author-stamp-restore.test.mjs:206` — Add independently parameterized refusal cases for each promised construct, including inline <Details> alone, with assertions on the refusal result.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7297@597d2fde59010f22d3894196086ca0c4f663038e

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
