---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-item-tasks.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5933 (head 617ebffc1)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5933 (reviewed head `617ebffc1990dca65d2a1be3189b99a825514def`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-item-tasks.mjs:48` — (failing-input, degraded) An overridden invalid standard timeout bypasses enqueue policy refusal
   - Scenario: For an otherwise valid enqueueItemTask request, supply policyOptions={platform:null,env:{},standard:{timeoutMs:-1},tool:{timeoutMs:500}}. A Node probe with filesystem writes replaced by in-memory no-ops reached store.create and created a task with timeoutMs=500. resolveCascade does not validate the standard layer, and validating only the resolved policy conceals its invalid value. The stated refusal contract requires rejecting invalid values in every cascade layer before creating the task, even when another layer supplies a valid effective timeout.
   - Claude's re-check: demonstrated break
2. `we:scripts/lib/daemon-item-tasks.mjs:94` — (edge-case, degraded) Fact cloning silently shortens sparse arrays and authorizes plans using altered facts
   - Scenario: Supply createRecordingFacts with a fresh, complete live-pr snapshot matching the expected identity and data={checks:new Array(2)}. The probe observed facts.outcome='ready', but facts.read('checks').length was 0 although the supplied array length was 2. validateTaskPlan then accepted an effect with inputs=['checks'] and fences=['checks'], recording inputs.checks=[]. freezeData initializes an empty array and copies only enumerable keys, discarding trailing holes and changing the facts a planner receives. Preserve the original array length and positions, or reject sparse arrays as unreadable; do
   - Claude's re-check: demonstrated break

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
