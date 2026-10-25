---
bornAs: x23h9ub
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/operations/red-team-gate-apply.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/operations/__tests__/red-team-gate-apply.test.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Prevention — A deterministic check (check:standards rule or test) that every call site of roundExtensionGrants… (from web-everything/web-everything#5758 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this PR's latest advisory review named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-merge-strategy.mjs:221` — A deterministic check (check:standards rule or test) that every call site of roundExtensionGrants, gateRoundGrants, readRedTeamDisposition and liveResultGateState in non-test code passes a standingRuling argument explicitly. Failing that, one wiring test per entry point.
2. `we:scripts/operations/red-team-gate-apply.mjs:247` — One test per injectable that asserts the production default is wired. The PR's own `personalRoute` test is the model. Where cheap, add a lint rule that flags a new injectable default with no test that omits the injection.
3. `we:scripts/lib/drain-merge-strategy.mjs:218` — Add a drain-merge-strategy test with an injected `readGrantScope` that asserts it is called and its result is forwarded to `redTeamEnqueueHold` and `syncRedTeamStatusLabels`. The same test pattern would cover the operator-queue enrich call.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#5758@f67947e6d37da630e6760c9cab2d9e3141590df5

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
