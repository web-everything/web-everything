---
bornAs: xi75vqb
kind: story
size: 2
status: active
scaffoldedBy: "fix-5242"
dateScaffolded: "2026-10-15"
scope: ["we:scripts/operations/__tests__/dispatch-lane-io.test.mjs", "we:scripts/operations/dispatch-lane-io.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Contract test: every dispatch effect payload key reaches the provider request

PR #5242 review found the operatorPostBuild route flag could be dropped between the dispatch-lane effect payload and the createDispatchSinks provider request with no test noticing. PR #5242 pins that one key. The class is wider: the sink in we:scripts/operations/dispatch-lane-io.mjs copies about twenty payload keys onto the provider request by hand (headRefOid, claimOwner, claimRoot, launchKind, groupMembers, lane, scope, pr, reason, probationWorker, repo, policyRoute, num, sessionSlug, operatorPostBuild and more), and a dropped key silently changes routing or settlement. Add one contract test in we:scripts/operations/__tests__/dispatch-lane-io.test.mjs: build a payload with a sentinel value for every key the provider reads, run it through createDispatchSinks with a recording provider, and assert each sentinel arrives on the request. Done when: the test fails if any one forwarding line in the sink is removed.

Also in this class, found by the PR #5242 fix self-review:
- The read-to-payload copy in we:scripts/operations/dispatch-lane.mjs: PR #5242 pins the route keys (num, launchKind, lane, sessionSlug, scope, groupMembers, prompt, routing, taskType, operatorPostBuild). Extend the same sentinel check to the rest (itemSpecPath, occupancyWarning, modelReason, pr, reason and others).
- The resume path: spawnResumeDelivery in we:scripts/conveyor/build-dispatch-orphan-adopt.mjs restarts a dead build from its stored payload on the mechanical wrapper and never reads payload.operatorPostBuild. Check whether an operator build can reach it, and route it to the agent if so.
- The run record: when the operator override clears the policy route, the record still writes the policy route's effort and never says the override fired.

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
