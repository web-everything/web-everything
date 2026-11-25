---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/drain-merge-strategy.mjs", "we:scripts/lib/red-team-dispatch-queue.mjs", "we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs", "we:scripts/lib/red-team-queue-state.mjs", "we:scripts/lib/__tests__/drain-merge-strategy.test.mjs", "we:scripts/lib/__tests__/red-team-queue-state.test.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Prevention — Add a drain test for the default wiring in both mode with no matching planner-skip entry, asserti… (from web-everything/web-everything#7462 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/drain-merge-strategy.mjs:332` — Add a drain test for the default wiring in `both` mode with no matching planner-skip entry, asserting that the operator note still publishes at the first deadline. Have the requester return requested:true only when a matching planner-skip entry is readable (readQueuePlannerBlock).
2. `we:scripts/lib/red-team-dispatch-queue.mjs:309` — Add a case to 'planner-skip re-request through the queue object' where the request head differs from the entry head and lastProbeTurn stays unchanged. A mutation check on guard conditions would cover the class.
3. `we:scripts/lib/drain-merge-strategy.mjs:333` — Add a default-wiring test with dryRun:true that asserts the inbox directory does not exist after the deadline.
4. `we:scripts/lib/red-team-dispatch-queue.mjs:315` — Add a test that runs a pending request through runWithRedTeamQueue with a throwing runner, asserts the .req file survives, then succeeds and asserts .done. Add an injected-exists race case for wx.
5. `we:scripts/lib/red-team-dispatch-queue.mjs:392` — Add a case that blocks with a reason, probes, settles a skip with no why, and asserts the entry is runnable and redteam-skip-unreasoned is logged.
6. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs:2033` — Have the card acceptance lint require each item to name a test or link recorded evidence.
7. `we:scripts/lib/red-team-queue-state.mjs:49` — Add a drain test for the drain-scan path with default wiring and no planner-skip entry, asserting no redTeamRequested and an immediate operator note; have the requester read the queue (readQueuePlannerBlock plus the block code) before spending.
8. `we:scripts/lib/red-team-dispatch-queue.mjs:309` — Add a queue test with a request for a different head than the stored planner-skip entry, asserting lastProbeTurn is unchanged and reprobeReason is absent; a mutation check on guard conditions would catch the class.
9. `we:scripts/lib/red-team-dispatch-queue.mjs:315` — Add a test that runs reconcile through runWithRedTeamQueue with a throwing runner and asserts the .req file remains, then succeeds and asserts it becomes .done.
10. `we:scripts/lib/drain-merge-strategy.mjs:333` — Add a dryRun:true case with default wiring asserting the inbox directory does not exist, and a requester test with exists() stubbed false over an existing .req asserting requested:false.
11. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs` — Require each Acceptance item to name a test or link recorded live evidence, checked by the card lint.
12. `we:scripts/lib/red-team-dispatch-queue.mjs:309` — Add a required parameterized request-consumption test covering matching identity, stale head, and non-planner block, asserting unchanged probe order and evidence for rejected requests.
13. `we:scripts/lib/red-team-dispatch-queue.mjs:190` — Require a deterministic commit/abort lifecycle test matrix for inbox consumption, asserting both persisted request files and restored queue state.
14. `we:scripts/lib/red-team-queue-state.mjs:56` — Keep an immutable exclusively created ledger file separate from consumption state, and gate changes with a deterministic test interleaving request existence checks, consumption, and creation.
15. `we:scripts/lib/__tests__/red-team-dispatch-queue.test.mjs` — Add these named regression tests to the required suite and require guarantee-to-test mappings for new behavioral promises.
16. `(no file cited)` — Require each live-proof acceptance item to include a named verification procedure and captured observable results before marking it satisfied.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#7462@ff62806853e193d8c8283066e2cf51c737485e7a

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
