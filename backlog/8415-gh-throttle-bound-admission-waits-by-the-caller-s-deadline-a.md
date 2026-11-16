---
bornAs: xnnowik
kind: story
size: 3
status: open
scope: ["we:scripts/lib/gh-throttle.mjs"]
dateOpened: "2026-11-15"
tags: []
related: ["await-checks"]
---

# gh throttle: bound admission waits by the caller's deadline and fail closed on lock-root errors

TODO digest — one ≤100-word paragraph: what this item does and why (replace this line).

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

## Duplicate admission

residual from the await-checks audit (R825): admission waits and retries use their own budgets, and lock-root setup failures let ordinary reads through ungated

## PR #6890 review follow-ups

The 2026-11-15 review requested these additional regression guarantees. They remain follow-up work; the current repair adds state/precedence tables and protects runner-definition presence.

- PR #6890's deadline repair now bounds await-checks admission/retry sleeps and recomputes subprocess timeouts at every read. Production-executor fixtures cover transient retries, successful recovery, and points/slot admission expiry. Generalize deadline support in the shared throttle and address refusal on lock-root errors here; the shared helper's existing fail-open policy is unchanged.
- Pin `parseArgs`'s omitted `--timeoutMin` default of 60 minutes in `we:scripts/operations/__tests__/await-checks.test.mjs`; the simplicity review flagged this separately from the production adapter.
- Evaluate a branch-coverage threshold for `we:scripts/operations/*.mjs`, including the mixed-rerun and StatusContext branches. Mixed failure/success reruns in both orders and all running/pass/fail pairings are covered by this repair, satisfying the duplicate simplicity suggestion about failure precedence.
- Automate the convention that each operation named in the worker brief has a rendered-command assertion in `we:scripts/__tests__/worker-brief.test.mjs`; consider a declared-operation cross-check and a lint against conditional assertions. The repair adds the immediate await-checks assertion, documents the convention beside it, and replaces silent conditional runner assertions with reported skips.

Acceptance for these follow-ups: hermetic tests must fail on throttle bypass, an incorrect remaining read budget, unbounded admission, lock-root fail-open, or a changed default; convention checks must reject an unpinned operation or silently skipped runner assertions while allowing an explicitly reported non-CI bundle skip. No live GitHub calls are needed for these fixtures.
