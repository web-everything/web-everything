---
kind: story
size: 3
status: open
scope: ["we:scripts/conveyor/liveness-sweep.mjs", "we:scripts/conveyor/liveness-sweep-core.mjs", "we:scripts/conveyor/__tests__/liveness-sweep.test.mjs", "we:scripts/conveyor/__tests__/liveness-sweep-core.test.mjs"]
dateOpened: "2026-10-13"
tags: []
---

# Prevention — Record a distinct outcome such as escalation-failed that does not count towards dedupe, and add a… (from web-everything/web-everything#5236 review)

Filed mechanically by the unattended review loop (#2749) — every finding below reduced web-everything/web-everything#5236's review (reviewed head `09ee3e296f6b0f28e4aa9495991512beda304edf`) to prevention-outstanding by naming a guard neither captured nor filed:

1. `we:scripts/conveyor/liveness-sweep.mjs:78` — Record a distinct outcome such as `escalation-failed` that does not count towards dedupe, and add an IO test that two runs with a failing notify produce two delivery attempts. Failing that, make the operator-queue wiring in card xozb05m a prerequisite for enabling `--apply`.
2. `we:scripts/conveyor/liveness-sweep.mjs:87` — Give the core a `requires`-style marker for rungs with no executor yet, or add a test asserting that every rung that can plan as enabled either has an executor or falls back to notify.
3. `we:scripts/conveyor/liveness-sweep-core.mjs:150` — Count attempts per kind and subject since the last adoption or clear, not since `since`. Add a replay fixture for a retry cycle that interleaves non-refusal alerts.
4. `we:scripts/conveyor/liveness-sweep-core.mjs:51` — Add a test that an env rungs override changes only the named leaves. Merge the env rungs over the lower layers.
5. `we:scripts/conveyor/liveness-sweep.mjs:195` — Add 'both PR sources fail → prior movement-store entries survive in the written store' to `we:liveness-sweep.test.mjs`.
6. `we:scripts/conveyor/liveness-sweep.mjs:118` — Pass `jobId` to the release path, or read the claim record in the executor and refuse unless claim.jobId equals evidence.jobId and that job record is finished. Add a regression test with a mismatched jobId. A lint or test helper requiring every auto-executing rung to re-prove its precondition from live state, not from the snapshot, would catch this class.
7. `we:scripts/conveyor/liveness-sweep-core.mjs:99` — Restrict marker comments to the bot or operator logins, as the extension-grant check does. Require a minimum sha length of 7, or an exact match. Add negative tests for a forged marker from a non-bot author. A shared 'authenticated-marker' helper used by every comment-marker reader would cover this class.
8. `we:scripts/conveyor/liveness-sweep.mjs:55` — Add a deterministic multi-sweep regression test in we:scripts/conveyor/__tests__/liveness-sweep.test.mjs covering meaningful new comments and repeated chatter, asserting that only meaningful activity resets the stall clock.
9. `we:scripts/conveyor/liveness-sweep-core.mjs:179` — Add a deterministic sequential-job regression test in we:scripts/conveyor/__tests__/liveness-sweep.test.mjs with old ledger attempts and fresh HEALTH evidence for a different job on the same lane.
10. `we:scripts/conveyor/liveness-sweep.mjs:133` — Add a deterministic filesystem-seam test in we:scripts/conveyor/__tests__/liveness-sweep.test.mjs asserting readSync length is at most the cap and its offset is max(0, size minus cap), including a file larger than the cap.

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
