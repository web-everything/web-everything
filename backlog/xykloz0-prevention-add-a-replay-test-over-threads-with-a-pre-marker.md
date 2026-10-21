---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/operator-send-backs.mjs", "we:scripts/conveyor/reconcile-core.mjs", "we:scripts/lib/__tests__/operator-send-backs.test.mjs", "we:scripts/conveyor/__tests__/reconcile-core.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a replay test over threads with a pre-marker send-back followed by a fix-end and an operator… (from web-everything/web-everything#5356 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/operator-send-backs.mjs:46` — Add a replay test over threads with a pre-marker send-back followed by a fix-end and an operator accept comment. Decide the intended behaviour explicitly, for example a grandfather cutoff time or treating a later operator acceptance as resolution. Longer term, a fixture-based thread-replay gate for new comment-derived holds.
2. `we:scripts/conveyor/reconcile-core.mjs:2523` — Add planner tests for a draft PR and a ci-red PR that carry an open send-back, asserting the intended precedence. A deterministic gate that checks a new `dispatch.push` branch has an ordering test against its neighbours would be ideal.
3. `we:scripts/lib/operator-send-backs.mjs:56` — Require an explicit evidence head or an immutable head recorded at evidence creation, and add a deterministic regression asserting that appending an unrelated push cannot resolve previously insufficient headless evidence.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5356@2457ddbd86f3926f688e06cd57bc0bdc602eaee3

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
