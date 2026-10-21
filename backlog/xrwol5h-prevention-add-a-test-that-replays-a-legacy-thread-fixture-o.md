---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/operator-send-backs.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/lib/__tests__/operator-send-backs.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a test that replays a legacy-thread fixture (operator send-back, unmarked fix, operator accep… (from web-everything/web-everything#5356 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/operator-send-backs.mjs:69` — Add a test that replays a legacy-thread fixture (operator send-back, unmarked fix, operator accept) and asserts the intended outcome. Better, add a lens question to the review checklist for any new fail-closed hold: 'who can release this, and what happens to threads that predate it?'
2. `we:scripts/conveyor/reconcile-core.mjs:2535` — A check:standards rule or test convention: every new `continue`/refusal branch in planReconcile needs a named test that reaches it. This is the same class as the filed card x6pj1po (fail-closed holds need test-covered paths).
3. `we:scripts/lib/operator-send-backs.mjs:63` — Add a deterministic regression matrix to the existing quoted-evidence test covering valid evidence headings followed by fenced, indented, and blockquoted references, asserting that ledger, queue, and verdict holds remain active.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5356@32f04330210174c1b298f9fff4b02097c3160f84

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
