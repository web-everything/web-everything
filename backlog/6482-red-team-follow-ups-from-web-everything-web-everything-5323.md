---
bornAs: xp339sn
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-sweep-job.mjs", "we:scripts/conveyor/pr-sweep-core.mjs"]
dateOpened: "2026-10-15"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5323 (head 0e9d581d6)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5323 (reviewed head `0e9d581d69a333ad30991e34194625c1f5fc1132`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-sweep-job.mjs:23` — (edge-case, degraded) The detached sweep bypasses --no-notify and --no-diagnose.
   - Scenario: Run a live health tick with --no-notify --no-diagnose while a sweep is due. prSweepTickAllowed returns true, and the queued input carries neither flag. With an overdue stuck episode and dispatchDiagnosis=true, the child invokes both notification and diagnosis sinks. A read-only probe with injected sinks observed one call to each. The child should honor the tick's suppression flags.
   - Claude's re-check: prSweepTickAllowed doesn't reject no-notify/no-diagnose, and the queued input carries only dir, sourceRoot and settings. The child's runPrSweep therefore notifies and diagnoses regardless of the tick's suppression flags.
2. `we:scripts/conveyor/pr-sweep-core.mjs:61` — (edge-case, degraded) Future-dated daemon evidence suppresses abandoned-PR alerts.
   - Scenario: After a clock correction, leave this log entry in review-daemon.log: '2026-10-16T16:00:00.000Z review-daemon: web-everything/web-everything#12 dispatched as session'. Sweep starting at 2026-10-14T16:00:00Z with no sessions or health episodes and an unchanged idle PR #12. Probes at 0, 120, 240 and 1440 minutes all reported active ownership, empty episodes and no alerts. Daemon timestamps are only checked for finiteness, so a future timestamp also outranks valid historical evidence. Reject future evidence beyond the clock-skew allowance, as session activity already does.
   - Claude's re-check: Daemon log stamps are only checked with Number.isFinite(Date.parse). resolveOwner then uses the newest at, so a future at gives now-at &lt; 0 and the PR counts as active with no episode. sessionActivity rejects future times but the daemon path doesn't.

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
