---
bornAs: x3cjzvz
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/conveyor/build-dispatch-orphan-adopt.mjs", "we:scripts/operations/deliver-item-wrapper.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs", "we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs", "we:scripts/conveyor/build-dispatch-failures.mjs", "we:scripts/conveyor/build-dispatch-orphan-streak.mjs", "we:scripts/conveyor/__tests__/build-dispatch-orphan-streak.test.mjs", "we:scripts/conveyor/health-smells/orphan-release-streak.mjs", "we:scripts/conveyor/health-smells/__tests__/orphan-release-streak.test.mjs"]
dateOpened: "2026-09-29"
preparedDate: "2026-11-07"
preparedAgainstSha: "5185d06a16a2b4f4a448ba395b721f4f01fa3c2f"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2921's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:330` — Track orphan-release counts per item (in a marker or hold) and place a hold after N consecutive releases. Add a test with repeated dead-wrapper cycles for one item.
2. `we:scripts/operations/deliver-item-wrapper.mjs:460` — In the resume path, fail the gate-retry step cleanly (settle as gate-red) when there is no real agent session id. Add a wrapper test where resume:true meets a red gate and asserts no `--resume` spawn.
3. `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:200` — A unit test explicitly asserting that `checkResumable` rejects resumption when `rowStartedAt` is missing or invalid.
4. `we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs:66` — A code review focusing on keeping test prose aligned with assertions, or a lint rule against contradictory terms in test names.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2921@5264fae59e61a56c18c0c7f85c578b438fb5c900

## Ruling (operator, 2026-10-09 ~13:20 ET)

The open choice from the prepare run (threshold N, and when the per-item streak resets) is ruled:
- **N = 3** consecutive orphan releases of the same item → hold. N is a setting (policy cascade: standard
  default 3, platform preference, tool override), defaulting to `MAX_RESUME_ATTEMPTS`.
- **Reset only on a real outcome** (the item's dispatch opens a PR or resolves the card). Hold expiry does NOT
  reset the streak: one more orphan release after expiry re-holds at once.
- **Operator addition: a hold must trigger a root-cause investigation, not just park the card.** Placing the
  streak hold raises a health smell (one episode per item) that the health daemon's existing investigation
  dispatch (#4078, `we:scripts/conveyor/health-investigate-plan.mjs`) picks up; when the investigation names a
  product change, the existing filing path (#4079, `we:scripts/conveyor/health-file-request.mjs`) files it.
  The hold reason links the episode, so the item is visibly "under investigation", never silently parked.

## Progress

Prepare pass (2026-11-07), premise checked against `origin/main` 5185d06a16. `git log` shows no commit delivering #4476/x3cjzvz's guards. Citations drifted; the goals stand:
- Guard 1: `adoptOrphanedBuildClaims` (`we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:505-628`) now charges each orphan release to the card's backoff via `recordBuildFailure` (`we:scripts/conveyor/build-dispatch-failures.mjs:75`, PR #5453). That is a retry delay, not the ruled streak-hold and not the investigation hook. Still owed. The only hold today is `exhausted` (`we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:612`), which counts resume attempts of one dispatch, not releases across dispatches.
- Guard 2: still real. `deliverItem` mints a fresh `claudeSessionId = newSessionId()` on EVERY run (`we:scripts/operations/deliver-item-wrapper.mjs:425`), including `resume: true`. A resumed wrapper whose gate is red reaches `runGateWithOneRetry` (`we:scripts/operations/deliver-item-wrapper.mjs:1767`, resume call `:1796`) and spawns `--resume <uuid>` for a session no agent ever ran under.
- Guard 3: `checkResumable` (`we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:343-364`) SKIPS the predates-dispatch check when `rowStartedAt` is missing or blank (`:360`), so it resumes. The existing test (`we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs:268-293`) covers only a valid-but-older report.
- Guard 4: the test-name lint idea (`we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs:66`) is a review habit, not a guarantee. Dropped from the MVP; see Follow-ups.

## Design

**G1 — orphan-release streak hold.** Persist a per-item streak `{ releases, lastRunId }` in a small atomic JSON file beside the failure state (same `read/save` pattern as `we:scripts/conveyor/build-dispatch-failures.mjs:75`; keyed by item number, normalised with `normNum` so hash and NNN spellings agree). In the release branch of `adoptOrphanedBuildClaims` (`we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:608-626`), after the hold-before-release ordering, bump the streak keyed by the same `attemptKey` aliases `recordFailure` uses, so a retried pass after a failed release never double counts. At streak `>= N` place the hold via `placeBuildDispatchHold` BEFORE `releaseClaim`, and raise one health episode per item (see below). Reset only where a real outcome is observed: the existing `readDelivery`/`settleDeliveredRow` branch (`we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:568-573`, which already calls `clearFailure`) also clears the streak. Hold expiry never touches it, so the first orphan release after expiry re-holds at once. N comes from a setting on the policy cascade (standard default 3, platform preference, tool override), defaulting to `MAX_RESUME_ATTEMPTS` (`we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:143`); an invalid or non-positive value falls back to the default, never to 0.

**G1 — investigation hook.** Add a health smell `orphan-release-streak` under `we:scripts/conveyor/health-smells/` (shape of `we:scripts/conveyor/health-smells/build-session-looping.mjs:1`) with `action: 'investigate'`, so `planInvestigations` (`we:scripts/conveyor/health-investigate-plan.mjs:71`) dispatches one investigation per `(smell, subject)` and `we:scripts/conveyor/health-file-request.mjs` files any named product change. The subject is `item:<num>`. The hold reason is `orphan-release-streak: <n> consecutive releases — investigation <episodeId>`; if the episode id is not yet known the reason names the smell and the next pass refreshes it (a hold refresh restarts its TTL, which is already the semantics of `placeBuildDispatchHold`).

**G2 — resume has no real session.** `deliverItem` passes `claudeSessionId: resume ? null : newSessionId()` down; `runGateWithOneRetry` returns a red `{ status: 'red' }` settle (`gate-red`, with reason `resume-without-agent-session`) when `claudeSessionId` is absent instead of calling `resumeAgentWithGateFailure`. Same refusal for a Codex provider with no recorded thread id (it already errors loudly at `we:scripts/operations/deliver-item-wrapper.mjs:1469`; this makes the path uniform and clean).

**G3 — fail closed on an unknown dispatch time.** `checkResumable` returns `{ resumable: false, reason: 'row-start-unknown' }` when `rowStartedAt` is not a string parseable by `Date.parse`, and compares via parsed milliseconds for both sides instead of string `>=`. The one caller (`we:scripts/conveyor/build-dispatch-orphan-adopt.mjs:587`) passes `row?.entry?.startedAt ?? null`; a missing row already classifies elsewhere, so only a row with a bad timestamp newly releases.

**Review clarifications (adversarial pass).**
- *Streak module:* the streak state lives in a new `we:scripts/conveyor/build-dispatch-orphan-streak.mjs` (bump / clear / read, mirroring the failure file); `we:scripts/conveyor/build-dispatch-failures.mjs` is only the pattern, not edited beyond an optional shared path helper.
- *Episode handoff:* the adopt pass does not create the episode. The smell reads the streak file as a probe and breaches for each item at `releases >= N`; the health watch (`we:scripts/conveyor/health-watch-core.mjs:588`) mints the episode id. The hold reason first says `orphan-release-streak: <n> consecutive releases — under investigation`; the smell's recommendation carries the episode id once it exists, so the investigation and the hold are linked by item subject `item:<num>`.
- *G2 seam and existing tests:* the five `runGateWithOneRetry` tests that pass no `claudeSessionId` (`we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs:1651,1678,1706,1711,1734`) must be updated to pass one. The new test calls `runGateWithOneRetry` with `claudeSessionId: null` and a red gate (the same injected `run`/`commitTurn` seam), and separately asserts `deliverItem` with `resume: true` passes `null` through.

## MVP

Musts only: G1 (streak file, N setting, hold, smell, reset on real outcome), G2 (no `--resume` without a session id, settles gate-red), G3 (missing or invalid `rowStartedAt` refuses resume). OUT: the test-prose lint (guard 4), any UI for the streak, an operator CLI to clear a streak.

## Edge cases this change must handle

1. **Untrusted text** — the hold reason and smell summary embed only the item number and a count, never card, PR or CLI text; the episode id is validated against `^[A-Za-z0-9_-]+$` before it is written into the reason.
2. **Truncated reads** — n/a: the change reads no `gh`/`git` output; the streak file read treats a missing file as empty only on ENOENT.
3. **Shared state files** — the streak file is written by the adopt pass and cleared by the delivery branch; use `writeJsonAtomic` and `withFileLock` (`we:scripts/lib/atomic-json-file.mjs`) with re-read compare-and-set. Test: two interleaved bumps give exactly +2.
4. **Fail closed** — an unreadable or corrupt streak file counts as "streak unknown, hold now" (never as zero); an unparseable `rowStartedAt` refuses resume; a missing session id refuses `--resume`. Each names its reason.
5. **Identity scoping** — streak keyed by `normNum(num)`; the double-count guard reuses the `attemptKey` aliases (claim, members, run row). Hash and NNN spellings resolve to one entry.
6. **State over time** — hold expiry does not reset the streak (test: expire the hold, one more release re-holds); a daemon restart mid-pass re-reads the file; a stale-lock steal is guarded as in `we:scripts/lib/atomic-json-file.mjs`; a clock skew only affects hold TTL, not the count.
7. **Who wrote it** — n/a: no label, comment or ref grants trust here; the episode link is read from the health episode store, which only the health daemon writes.

## Test plan

- `we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs`: (a) three consecutive dead-wrapper cycles for one item place a hold on the third release and not before — fails RED today (only the `exhausted` hold exists); (b) two releases, a delivered outcome, then two more releases places NO hold (asserts the streak count is 0 after the outcome; RED today because no streak exists to assert on); (c) hold expiry then one release re-holds; (d) the same attempt key released twice leaves the streak at exactly 1; (e) corrupt streak file holds; (f) N=2 override holds on the second release, and an invalid N (0, 'x') holds on the third, not the first; (g) `checkResumable` with `rowStartedAt` missing, `''`, `'garbage'` returns `row-start-unknown` — RED today (it resumes).
- `we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs`: `resume: true` with a red gate asserts no `provider.spawn` with `resumeSessionId`, and the run settles `gate-red` — RED today (a fresh UUID is resumed).
- `we:scripts/conveyor/health-smells/__tests__`: the new smell breaches on a held-by-streak item, closes once the streak clears, and is `investigate`-actioned so the planner picks it up.

## Proof plan

Before/after on a real surface: run the adopt pass of `we:scripts/conveyor/build-dispatch-orphan-adopt.mjs` against a temp claim/failure root with three synthetic dead wrappers for one item. Before: `listBuildDispatchHolds` is empty after three releases. After: one hold exists whose reason names the streak, and the health episode store has one `orphan-release-streak` episode that `planInvestigations` returns in its dispatch list. Capture both outputs in the PR body.

## Follow-ups

- Lint or review rule against contradictory test names (guard 4).
- An operator command to clear a streak early.
- Surfacing the streak in the build dashboard.

## Done when

1. [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/build-dispatch-orphan-adopt.test.mjs` — three consecutive orphan releases of one item place a streak hold (reason links the health episode) and raise one `orphan-release-streak` episode; a real outcome resets it; hold expiry does not. Fails before (no streak hold exists), passes after. Covers the changed default N=3 and the corrupt-file fail-closed path.
2. [A2] **Executable** — same command, `checkResumable` cases: missing, blank and unparseable `rowStartedAt` return `row-start-unknown`. Fails before (it resumes), passes after. Covers the fail-closed path and the one caller in `adoptOrphanedBuildClaims`.
3. [A3] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/operations/__tests__/deliver-item-wrapper.test.mjs` — a `resume: true` wrapper meeting a red gate spawns nothing with `resumeSessionId` and settles `gate-red`. Fails before (a fresh UUID is resumed), passes after. Covers the `deliverItem` → `runGateWithOneRetry` caller.
4. [A4] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/health-smells/__tests__` — the new smell is `investigate`-actioned and planned by `planInvestigations`. Fails before (smell absent), passes after.
