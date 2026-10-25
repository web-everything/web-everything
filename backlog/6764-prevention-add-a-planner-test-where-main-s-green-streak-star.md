---
bornAs: xprao70
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/exhausted-retry.mjs", "we:scripts/conveyor/ci-red-recovery-watch.mjs", "we:scripts/conveyor/__tests__/exhausted-retry.test.mjs", "we:scripts/conveyor/__tests__/ci-red-recovery-watch.test.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Prevention — Add a planner test where main's green streak started before the PR failure and the signature matc… (from web-everything/web-everything#5331 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/exhausted-retry.mjs:152` — Add a planner test where main's green streak started before the PR failure and the signature matches, and assert the age fallback or an own-failure outcome applies.
2. `we:scripts/conveyor/ci-red-recovery-watch.mjs:432` — Wrap each candidate's body in try/catch that records a refusal. Add a test with a throwing first PR and a healthy second PR, and assert the second is still processed.
3. `we:scripts/conveyor/exhausted-retry.mjs:50` — Add a `retryOutcome` test with a completed post-retry failure plus a missing required row, and assert `failed`. Alternatively give the pending state a timeout.
4. `we:scripts/conveyor/ci-red-recovery-watch.mjs:383` — Require the failing job's conclusion to be timed_out or cancelled, or the match to come from runner-emitted annotations rather than free log text. Alternatively require the same failed job name in the main run as well as the same signature. File as a backlog item.
5. `we:scripts/conveyor/ci-red-recovery-watch.mjs` — Add a deterministic multi-sweep fault-injection test that fails the durable marker write and asserts the refresh/trigger call count never exceeds the configured budget; reserve consumption durably before executing the action.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5331@94566b220d1c8172471f4c9350e4ac6b03af1036

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
