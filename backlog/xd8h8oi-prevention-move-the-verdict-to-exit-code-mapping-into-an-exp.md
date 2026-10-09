---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs", "we:scripts/lib/__tests__/daemon-load-overlay.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Prevention — Move the verdict-to-exit-code mapping into an exported pure function (exitCodeFor(result)) and un… (from web-everything/web-everything#4673 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-load-overlay.mjs:762` — Move the verdict-to-exit-code mapping into an exported pure function (`exitCodeFor(result)`) and unit-test it for each result shape.
2. `we:scripts/lib/daemon-load-overlay.mjs:688` — In `rollBack`, explicitly reset or omit the ancestry and pending fields, and add an assertion to the existing rollback test that `pending` is undefined.
3. `we:scripts/lib/daemon-load-overlay.mjs:749` — Add a deterministic CLI regression test for stale adoption followed by dispatch-smoke rollback, asserting that the message agrees with registered:false and rolledBack:true.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#4673@b0cc35a43f1c5196534c87a6bede94cd8cc0a282

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
