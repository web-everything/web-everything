---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-sweep.mjs", "we:scripts/conveyor/pr-stall-detector.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5856 (head 797927fd6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5856 (reviewed head `797927fd6c20d5acd1a3e89a6cffa8ebc3041ecc`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-sweep.mjs:122` — (edge-case, degraded) Compressed refusals from an old head can falsely stall a newly observed head.
   - Scenario: Probed with the real logger, collector body, and detector: log seven identical refusals between 15:58:50 and 15:59:50 on head A, observe head B at 15:59:55, then flush the logger at 16:00:00. The resulting marker says '(repeated 6 times since 15:59:00)' but expandRepeatedLines timestamps all six copies at 16:00:00. With B's saved clock at 15:59:55, the detector counts six refusals against B and emits stalled-same-head with stalledMinutes=0. All attempts preceded B. Historical compressed occurrences must not count as six observations during the new head's lifetime.
   - Claude's re-check: demonstrated break
2. `we:scripts/conveyor/pr-stall-detector.mjs:143` — (edge-case, degraded) Reapplying a blocking label resurrects its cleared age from unrelated historical refusals.
   - Scenario: Probed this sequence: remove status:fixing from head A and run detection, which correctly drops its saved clock; reapply it at 16:00. Supply two supported head-attributed health refusals for A at 14:00 and 14:01 with reason 'no lane', plus a current dispatch progress signal at 16:00. Despite only two repetitions and current progress, detection restores the label clock to 14:00 and emits a 120-minute stall with remedy 'fix claim has no live job'. Head attribution does not establish continuous label presence. The reapplied label should start a new clock at 16:00 and produce no stall.
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
