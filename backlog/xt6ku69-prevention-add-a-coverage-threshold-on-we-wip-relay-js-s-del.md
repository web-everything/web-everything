---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:src/delivery/delivery-validate.test.ts", "we:wip-relay.js", "we:./__tests__/wip-relay.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a coverage threshold on we:wip-relay.js's delivery validator section, or a table-driven test generate… (from plateauapp/plateau-app#240 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:src/delivery/delivery-validate.test.ts:1` — Add a coverage threshold on we:wip-relay.js's delivery validator section, or a table-driven test generated from the list of reason categories and 'dropped …' labels in the validator, so a new branch without a test fails CI.
2. `we:wip-relay.js` — Add a deterministic regression test for a sole invalid step that asserts a named warning and preservation of unrelated progress, workers, and PR data.
3. `(no file cited)` — Capture a named deterministic size check that runs measureNonTestLines against the base and asserts the 300-line limit.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#240@c58a0d5635c64ba5990d8cf8f793a00b8c1674a7

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
