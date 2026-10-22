---
bornAs: xr4hzfs
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/pr-status-label.mjs", "we:scripts/conveyor/__tests__/pr-status-label.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a precedence table test that enumerates every status state against a DIRTY PR, so any change… (from web-everything/web-everything#5388 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/pr-status-label.mjs:123` — Add a precedence table test that enumerates every status state against a DIRTY PR, so any change in which state wins is an explicit, reviewed assertion. File this as a backlog item.
2. `we:scripts/conveyor/pr-status-label.mjs:123` — Extract a shared 'live repair state' helper used by both the ci-red and conflict branches, and test it with a takeoverUnjudged fixture. File this as a backlog item.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5388@ad08d607a0dddc7bf6bc2ee9867cbb0814d017de

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
