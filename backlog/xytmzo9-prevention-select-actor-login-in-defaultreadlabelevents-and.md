---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/human-surface-repark.mjs", "we:scripts/conveyor/__tests__/human-surface-repark.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Select .actor.login in defaultReadLabelEvents and require the latest add to be by the trusted acc… (from web-everything/web-everything#5273 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/human-surface-repark.mjs:148` — Select `.actor.login` in `defaultReadLabelEvents` and require the latest add to be by the trusted account. Add an in-window foreign-add case to the heal tests. A check:standards rule is hard to write for this, so a review lens is the realistic guard.
2. `we:scripts/conveyor/human-surface-repark.mjs` — Add a deterministic regression test covering foreign remove/re-add events inside the allowed time window, and require the heal to preserve holds when the event sequence cannot establish ownership.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5273@fcd884b785bc7ca83f4192b32ddb2e0629513c18

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
