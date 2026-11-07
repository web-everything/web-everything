---
kind: story
size: 3
status: open
scope: ["we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/conveyor/reconcile-core.mjs"]
dateOpened: "2026-11-07"
tags: []
---

# Round cap read three different ways across B, E and A

Flow-sim gap R3-G2, class K9 (divergent predicates for one state). Failing input: PR in a send-back loop. Fix daemon cap = resolveRoundCap(env WE_REVIEW_ROUND_CAP) (RC:1566-1571, copy in we:mechanical-round-cap.mjs:470-474), mechanical rounds excluded from the cap by default (RC:2166). Red-team gate cap = fixed DEFAULT_ROUND_CAP=5 (we:jury-core.mjs:2746), round = distinct reviewed heads incl. mechanical roun… Cited: we:scripts/operations/red-team-gate-apply.mjs:138, we:scripts/conveyor/reconcile-core.mjs:1566-1571. Soak-break sketch: stuck (a: review:changes label with no actor allowed to act) or wrong-escalate (b, c: needless needs-you round-cap). Env-conditional for a/b; (c) needs no env.

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
