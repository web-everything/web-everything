---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/assets/js/backlog-table-sort.js", "we:src/assets/js/__tests__/backlog-table-sort.test.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Prevention — Add a deterministic test named 'preserves newer search while a summary filter is pending' in we:s… (from web-everything/web-everything#7525 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/assets/js/backlog-table-sort.js:304` — Add a deterministic test named 'preserves newer search while a summary filter is pending' in we:src/assets/js/__tests__/backlog-table-sort.test.ts: hold fetch pending, click a summary, enter a query, release fetch, and assert the query and matching visible rows survive.
2. `we:src/assets/js/backlog-table-sort.js:6` — Add a deterministic test named 'reloads rows after hot reload restores the server preview' in we:src/assets/js/__tests__/backlog-table-sort.test.ts, asserting renewed fragment requests, complete unique rows, and working filters after tbody replacement and initialization.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7525@41de9ffb9d87594c2aec3169c831238ad5603a67

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
