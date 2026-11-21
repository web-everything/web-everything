---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:docs/agent/testing.md"]
dateOpened: "2026-11-21"
tags: []
---

# Prevention — Add a doc lint that cross-checks documented env defaults against the named exported predicate. A… (from web-everything/web-everything#7196 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:docs/agent/testing.md:5900` — Add a doc lint that cross-checks documented env defaults against the named exported predicate. A lower-cost alternative is a single canonical 'strict evidence default' paragraph that the other sections link to.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7196@58342be8f853bc1238321bea0e7775a28b019480

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
