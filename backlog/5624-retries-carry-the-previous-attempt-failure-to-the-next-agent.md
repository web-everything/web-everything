---
bornAs: xbld0p4
kind: story
size: 3
status: open
scope: ["we:scripts/operations/dispatch-lane.mjs", "we:scripts/operations/__tests__/dispatch-lane.test.mjs", "we:scripts/conveyor/prepare-failure-policy.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Retries carry the previous attempt failure to the next agent

Operator 2026-10-09: when a build or prepare retry follows an AGENT-caused failure (crash, stopped early, result refused, worker died silently), the retry brief includes the previous attempt evidence: redacted error (capped), the step it reached, minutes run, and the lane state (clean / uncommitted / committed-unpushed). Infra-transient failures (lane busy, git ref lock, rate limit) pass nothing. A silent death says so explicitly. Classification reuses we:scripts/conveyor/prepare-failure-policy.mjs classifyPrepareFailure; evidence comes from the failure ledger and run store; the brief is built in we:scripts/operations/dispatch-lane.mjs. Setting under the policy cascade (default on).

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
