---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7190 (head ce7d30a87)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7190 (reviewed head `ce7d30a87a886fda34d596b48c951bd24da5d1eb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:162` — (failing-input, degraded) Completed red-team verdicts still produce a no-verdict miss.
   - Scenario: PR 7 receives red-team:pending at minute 0, completes its head-bound red-team check successfully at minute 5, and receives red-team:clear. At minute 61, collection records only red-team:pending and red-team-started; evaluation reports red-team-no-verdict as missed. The completed verdict should satisfy the expectation.
   - Class: live-reproduced (basis: An in-memory probe executed the unchanged collector function and production evaluator against these GitHub responses and observed status missed despite the successful completed check and clear label.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:158` — (failing-input, degraded) The review-gate label check falsely satisfies review-started.
   - Scenario: A confirmed update-branch occurs at minute 0. Unit CI and review-gate start at minute 1, but no reviewer or red-team worker starts. Even when review-gate fails because review:pending remains, evaluation at minute 16 reports update-no-restart as met. The existing review-gate workflow only checks hold labels; its execution must not satisfy the required review restart.
   - Class: live-reproduced (basis: The collector and evaluator probe returned met using only unit and failed review-gate check runs. The repository's we:review-gate.yml confirms that this job checks labels rather than running a review.)
   - Also class: correctness-in-normal-use
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
