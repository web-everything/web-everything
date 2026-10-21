---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/exhausted-retry.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs", "we:scripts/conveyor/__tests__/exhausted-retry.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Wrap per-candidate IO in a try/catch that degrades only that candidate. Add a shared sweep-harnes… (from web-everything/web-everything#5331 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/ci-red-recovery-watch.mjs:283` — Wrap per-candidate IO in a try/catch that degrades only that candidate. Add a shared sweep-harness test that injects a throwing reader for one of N candidates and asserts the others are still planned.
2. `we:scripts/conveyor/ci-red-recovery-watch.mjs:530` — Add a test that passes a trigger result of `{ok:false, deferred:true, action:'pull-request-push'}` and asserts whether the retry budget is refunded. Alternatively, have the result type distinguish 'no mutation attempted' from 'ambiguous'.
3. `we:scripts/conveyor/exhausted-retry.mjs` — Add a deterministic regression test covering both exhaustion kinds when rebase changes HEAD and outcome publication fails, asserting that subsequent sweeps preserve consumption and produce an operator handoff.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5331@bba248efe7e73a7eea99d7733834dd7e6ef9d480

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
