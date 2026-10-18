---
bornAs: xyzpgol
kind: story
size: 3
status: active
scaffoldedBy: "overlap-yield-known-holds"
dateScaffolded: "2026-10-17"
scope: ["we:scripts/conveyor/overlap-yield-recorded-hold.mjs", "we:scripts/conveyor/__tests__/overlap-yield-recorded-hold.test.mjs", "we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Drain overlap-yield uses a target's last recorded hold when this pass has not decided it

Follow-up to #5518. A yield target the pass has not decided yet (ready-not-reached) still counts as a yield target, so the full pass defers #5460 to #5461 although #5461 has been held red-team-pending every pass since 17:39Z. Use the target's last recorded drain hold (the existing per-PR hold record in the drain-hold ledger, no new store) when it is for the same head and fresh (`drain.overlapYieldHoldMaxAgeMin`, default 30, source logged); a hold (red-team-pending, a carry refusal, checks-pending, parked, unrecognized-reason) means not a yield target. No record, a stale one, or a different head keeps today's #5518 behaviour. A hold on the target is never weakened.

Queue: this card queues normally (it was filed with `--queue=false` only to avoid an early dispatch).

**Build after #5518, #5492, #5480 and #5462 land (we:scripts/merge-ai-prs.mjs is occupied).** Do not build it before then. #5510 will release #5461, which frees #5460 anyway, so this is a prevention card, not an urgent unblock.

## Live cases

1. **Full pass, undecided target.** Drain log, full pass ending 21:59Z: "#5460 deferred: waits on overlap-yield:#5461". #5461 was "ready-not-reached" in that pass, so #5518's pass-local rule (decisions of this pass only) still counted it as a target.
2. **Persisted deferral honoured without re-checking.** 22:00:22Z, fast single-PR drain for #5460: "deferred: waits on overlap-yield:#5461 until 22:00Z - enqueue not attempted". The full pass's deferral is persisted and the fast drain honours it without re-checking the target. A persisted overlap-yield deferral must be honoured only while its target is not held (same last-known-hold rule).

## Acceptance

- [A1] **Executable** - tests written first and run red: an undecided target with a fresh same-head hold does not defer; a stale record or a different head defers as before; a decided-enqueueable (merge verdict) target defers. The lane verify is green after.
- [A2] **Executable** - test requirement for live case 2: a persisted overlap-yield deferral whose target has a fresh same-head recorded hold is NOT honoured by the fast single-PR drain (the PR proceeds to its normal checks); with no hold, a stale hold, or a different head the deferral is still honoured.
- [A3] **Executable** - test: `drain.overlapYieldHoldMaxAgeMin` resolves CLI > env > default 30, an invalid value is a usage error, and the setting with its source is logged each pass.
- [A4] **Live proof** - after review accept and loading on the drain: #5460 is not deferred to #5461 in a full pass.

## Non-goals

- [N1] No new store for holds: the existing drain-hold record is reused (the head sha is added additively to that event only if it is missing).
- [N2] Does not change any hold on the target, or how the target itself is decided.

## Edge cases this change must handle

1. **Untrusted text** - n/a: hold reason codes come from the drain's own bounded codes, never PR text.
2. **Truncated reads** - an unreadable or partial hold record counts as no record (today's behaviour).
3. **Shared state files** - reads the existing ledger snapshot once per pass; writes nothing new.
4. **Fail closed** - no record, stale, unparseable or head-mismatched record keeps the target a yield target.
5. **Identity scoping** - records are keyed by repo plus PR number, never a bare number.
6. **State over time** - freshness is bounded by `drain.overlapYieldHoldMaxAgeMin`; a later release event ends the hold.
7. **Who wrote it** - Code written by Codex when built.
