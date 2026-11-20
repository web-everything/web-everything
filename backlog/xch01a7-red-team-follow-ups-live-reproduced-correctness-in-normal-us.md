---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7190 (head fd20d70cc)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7190 (reviewed head `fd20d70cc84e0261143fbed494e70258ef8e2edd`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:155` — (failing-input, degraded) The review-gate label check falsely proves that a reviewer started
   - Scenario: For PR 7 on head a repeated 40 times, supply worker-push at 00:00 and only a review-gate check starting at 00:01. Evaluate at 00:16 with complete evidence and no actual reviewer. The collector classifies review-gate as review-started, and the evaluator returns push-no-review as met. The repository's review-gate workflow only checks hold labels; it does not launch a reviewer. This should remain missed when complete evidence proves no review started, or unknown if reviewer evidence is unavailable. The same misclassification can satisfy update-no-restart when CI also starts.
   - Class: live-reproduced (basis: A read-only Node probe invoked the actual collector and evaluator with injected GitHub responses and observed status met. The current review-gate workflow confirms that this check only evaluates labels.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pass-daemons/pr-expectation-pass.mjs:159` — (failing-input, degraded) Successful red-team completion never satisfies the verdict expectation
   - Scenario: Supply a current-head red-team:pending timeline event at 00:00, a red-team check starting at 00:01 and completing successfully at 00:05, and red-team:clear applied at 00:05. At 01:01, the actual collector and evaluator return red-team-no-verdict as missed. The collector records red-team-started but never translates its completed verdict or the clear transition into red-team-verdict. A successful verdict within five minutes should satisfy the expectation instead of generating a false miss after sixty minutes.
   - Class: live-reproduced (basis: A read-only Node probe reproduced status missed using the actual collector and evaluator. The existing redTeamCheckRunPayload publisher produces the completed/success red-team check shape used in the probe.)
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
