---
bornAs: xrjjagi
kind: story
size: 3
status: resolved
dateOpened: "2026-11-17"
dateResolved: "2026-11-17"
tags: []
---

# Rebuild herd: dry-run holds a smoke slot, rebuild-job interval jitter, step timing lines

On 11-17 00:21Z seven daemons rebuilt at once (600-2176 s vs 27-130 s normal). Hold a smoke slot for the whole dryRunRebuild, jitter rebuildAsJob.minIntervalMs, log timing for the object-DB and overlay-merge steps.

## Acceptance

- [A1] **Executable**:

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest run scripts/lib/daemon-rebuild/__tests__/preview.test.mjs scripts/lib/daemon-rebuild/__tests__/rebuild-job.test.mjs scripts/lib/__tests__/daemon-smoke-slots.test.mjs
```

- [A2] Every dry run acquires its own shared smoke ticket through object setup and merge planning, releases it on failure, and refuses with `smoke-queue-timeout` when capacity expires. Admission is unconditional; callers already holding capacity must allow room for a separate ticket. A timed-out attempt can retry after capacity is released.
- [A3] Job spacing uses stable daemon-name jitter: default 20%, clamped to 0–100%, never below the base interval; 0 disables it. Dry runs emit separate elapsed-ms lines for object-db and overlay-merge.

### Acceptance tests

Preview cases live in `we:scripts/lib/daemon-rebuild/__tests__/preview.test.mjs`; spacing cases live in `we:scripts/lib/daemon-rebuild/__tests__/rebuild-job.test.mjs`.

| Guarantee | Named test and observable assertion |
| --- | --- |
| Default acquisition, separate ownership, setup/merge hold and failure cleanup | Preview: `default admission holds its own real shared smoke ticket through setup and planning, then releases it (failure=%s)` — two distinct tickets during work; only the outer holder remains afterwards, for success and both phase failures. |
| Root inspection failure cleanup | Preview: `releases the slot when initial root inspection throws` — release called once. |
| Timeout and retry | Preview: `fails closed on queue timeout without initializing/fetching or merging; next attempt may retry` — first attempt refuses without fetch/plan, preserves the original holder and removes its waiter; second attempt on the same root plans successfully after the holder releases, leaving no holders or waiters. |
| Corrupt admission state | Preview: `default admission rejects corrupt shared state before root inspection or planning` — rejects without root inspection/fetch/plan and leaves corrupt bytes intact. |
| Default and clamped jitter with historical settings | Spacing: `settings reader defaults or clamps jitter %s to %s without dropping historical entries` — missing field resolves to 20%, values clamp to 0–100%, entries survive. |
| Stable daemon identity | Spacing: `default jitter is stable by daemon basename across restarts and paths, and spreads distinct entries` — same basename gives the same bounded interval; distinct entries differ. |
| Interval floor and disable | Spacing: `bounds injected fraction %s to an interval of %s, never below the configured minimum`, `zero percent disables jitter and oversized percentages are capped at 100`, and `tick enforces jitter=%s at elapsed=%s including disable and exact due boundary` — bounded intervals, disabled RNG, and job start at the due boundary. |
| Phase timing, including failures | Preview: `emits separate object-db and overlay-merge elapsed milliseconds with the injected clock`, `logs object-db elapsed time and releases capacity when object setup throws`, and `logs overlay timing even when the merge throws` — separate exact timing lines and release on setup failure. |

## Non-goals

- [N1] Does not bypass dry-run admission, reuse a caller's ticket, change the shared slot allocator's locking/format, or change overlay selection and adoption. Timing lines observe phases without setting new phase deadlines.

## Edge cases this change must handle

1. **Untrusted text** — Daemon entry paths supply basenames to the jitter hash, never shell commands; timing lines contain fixed step names and numeric elapsed times.
2. **Truncated reads** — The existing slot reader parses complete JSON and rejects malformed/incomplete state; it does not interpret a partial read as empty capacity.
3. **Shared state files** — Admission uses the existing allocator's lock, atomic state replacement and unique ticket per acquisition; releasing a preview preserves another acquisition by the same process.
4. **Fail closed** — Queue expiry returns a refusing plan with `smoke-queue-timeout`, without object setup or merge planning. Corrupt/unreadable slot state rejects the dry-run promise before root inspection; inspect the shared state and writer ownership before retrying rather than bypassing admission.
5. **Identity scoping** — Each acquisition owns a distinct ticket even within one process. Default jitter uses daemon basenames, so moving a checkout does not change spacing.
6. **State over time** — A timed-out preview removes its waiter and may retry when capacity frees. Existing settings that omit jitter now use 20%; setting `rebuildAsJob.minIntervalJitterPct` to 0 restores the base interval. The base interval remains the minimum.
7. **Who wrote it** — The preview process acquires and releases only its own smoke ticket through the shared allocator. It reads the target clone and writes scratch object/merge data in a disposable bare repo.

## Prevention follow-ups from PR #6972

- Card gate for unfinished acceptance/non-goal/edge-case placeholders: already tracked by [#5360](5360-prevention-add-a-check-standards-rule-that-fails-a-card-movi.md).
- Guarantee-to-named-test/assertion gate: already tracked by [#6484](6484-prevention-file-a-card-validation-gate-requiring-guarantee-t.md). This card now provides the mappings above, including the two-attempt recovery assertion and separate-ticket ownership assertions.
- Documented environment-switch source validation and real-default seam review coverage: filed in [#8570](8570-validate-documented-switches-and-default-seam-test-coverage.md). Future rollback switches must include a named test exercising the explicit override value; admission currently has no bypass switch.
