---
bornAs: x3ugt7s
kind: story
size: 2
status: resolved
scope: ["we:scripts/operations/ci-heal-pr-dispatch.mjs", "we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs"]
scopeRationale: "we:scripts/conveyor/timeout-retry-state.mjs is cited only for its state-dir location and named as an explicit no-change file."
dateOpened: "2026-10-02"
dateResolved: "2026-10-03"
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# Timeout re-run reservations stop being polled once their PR closes or ages out

Follow-up from the #3559 advisory (2026-10-02). we:scripts/operations/ci-heal-pr-dispatch.mjs:490 flushTimeoutFollowups re-observes every unresolved pending reservation (three GitHub reads each) on every reconcile tick, with no PR-open or age bound, spending GitHub budget on dead entries. Retire entries whose PR is closed or merged or whose age passes a cap; test that a closed PR pending state stops polling.

## Progress

- **Final verification:** we:scripts/verify-lane.mjs completed green (exit 0): **69 test files, 3,321 tests passed**; its standards gate reported **0 errors** (5,278 warnings). The standalone standards gate also passed. Only the two scoped implementation/test files and this card changed; no helper files or shared agent docs were created or edited.

- Implemented 2026-10-03 in the two scoped files: seven-day pending retirement, durable reservation timestamps (including legacy first-sight stamping), closed-PR retirement after the existing confirmation check, and the retirement reason in flush result rows. Retirement preserves request status, retry budget, heal hold, and owed follow-up filing.
- **Before proof:** clean lane HEAD and local `main` both at `54a42d3e61b3a8876833be2f7831b91bdd5cf796`; no diff in we:scripts/operations/ci-heal-pr-dispatch.mjs. Inline Node replay (no helper file) wrote a temporary version-1 ledger for PR #3559 with one pending request, synthetic head/run/job, and counting `observe` returning `{ open: false }`. Three flushes produced **3 observations**, no retirement. This is a replay, not a live GitHub observation.
- **Red regression proof:** ran the targeted Vitest suite in we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs against the unchanged implementation with the added tests: **55 passed, 4 failed**. Closed-PR retirement, age retirement, legacy stamping, and the final-confirmation/owed-filing soak failed. The new age constant was absent on that baseline; the age case failed because it still performed a read.
- **After proof:** repeated the same inline replay against the implementation: three flushes produced **1 observation** and persisted `retired: { reason: 'pr-closed', at: '2026-10-03T17:07:47.944Z' }`. The live directory returned by `timeoutStateDir()` was absent both before and after, so no live reconcile was applicable. Temporary replay ledgers were removed.
- **Regression/soak proof:** the targeted suite now passes **59/59** tests. Added the five requested cases to the existing `4863 retry reservation and restart soak` block (the current name of the card's cited block), plus a 100-tick soak: the last closed-PR observation confirms the newer attempt, retirement persists, a failed owed-card filing retries successfully, exactly one observation and two filing attempts occur. The young-entry case also pins the exact age-cap boundary as still eligible for polling.

- Old premise: `flushTimeoutFollowups` sits at `we:scripts/operations/ci-heal-pr-dispatch.mjs:490`.
  Corrected: it now sits at `we:scripts/operations/ci-heal-pr-dispatch.mjs:523 (flushTimeoutFollowups)`. Line 490 is inside `fileTimeoutFollowup`.
- The premise itself still holds. The loop at `we:scripts/operations/ci-heal-pr-dispatch.mjs:533-535` finds a `pending` request and calls `effects.observe` with no open-PR or age check.
- `observe` makes three `gh api` reads (pull, job, run) at `we:scripts/operations/ci-heal-pr-dispatch.mjs:447-454 (timeoutGithubEffects.observe)`. It already returns `open: pull.state === 'open'`, so a merged PR (GitHub state `closed`) reads as `open: false`. No new GitHub read is needed.
- The flush runs on every reconcile tick: `we:scripts/operations/ci-heal-pr-dispatch.mjs:288 (runReconcileCiHealDispatch)`.
- Reservations carry no timestamp today (`we:scripts/operations/ci-heal-pr-dispatch.mjs:579`), so the age cap needs a new `reservedAt` field.
- Not already delivered: the git log of `we:scripts/operations/ci-heal-pr-dispatch.mjs` shows no change bounding the flush poll since `e213282e0` (PR #3559).
- No live state dir exists on this host today (`we:scripts/conveyor/timeout-retry-state.mjs:7 (timeoutStateDir)` → `.lanes/.admission/gh/ci-timeout-reruns` is absent). The proof is a replay of the recorded shape.

## Design

"Retire" means **stop polling only**. It does NOT change any request's `status`.

Why: a `pending` request may already have been sent (ambiguous outcome). The file says pending is never failure or free budget (`we:scripts/operations/ci-heal-pr-dispatch.mjs:554-555`). Flipping it to `rejected` would free budget for a third re-run. So the pending request stays `pending`. The budget and the heal hold (`we:scripts/conveyor/timeout-retry-state.mjs:22 (readTimeoutBudget)`, `we:scripts/operations/ci-heal-pr-dispatch.mjs:475 (readTimeoutHold)`) keep their current meaning. The dispatch path in `dispatchTimeoutRetry` keeps its current refusal logic. It only runs on fresh live evidence, so it is already bounded.

The retire mark lives on the state file, as `state.retired = { reason, at }`:

1. **PR closed or merged.** In `flushTimeoutFollowups`, after `effects.observe` returns, if `observed.open === false`, write `retired = { reason: 'pr-closed', at }` under `timeoutTransaction`. The existing confirm check still runs first in the same pass, so a newer attempt seen on that last read is still recorded.
2. **Aged out.** Before calling `observe`, compute the pending request's age from `pending.reservedAt`. If age > `TIMEOUT_PENDING_MAX_AGE_MS`, write `retired = { reason: 'aged-out', at }` and skip `observe`.
3. **Skip.** At the top of the per-file loop, a state with `state.retired` skips `observe`. It still calls `fileTimeoutFollowup` (local file work only, no GitHub read) so an owed card can still be filed.

Supporting changes in `we:scripts/operations/ci-heal-pr-dispatch.mjs`:

- Add `export const TIMEOUT_PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;` (7 days). A real re-run shows a newer attempt within hours, so 7 days only catches dead entries. This is an implementation constant, not policy.
- `flushTimeoutFollowups` gains injectable `now = Date.now` and `maxAgeMs = TIMEOUT_PENDING_MAX_AGE_MS` options.
- `dispatchTimeoutRetry` stamps `reservedAt: new Date(now()).toISOString()` on a new reservation (line 579). It gains an injectable `now = Date.now`. Nothing else in it changes.
- Legacy pending entries with no `reservedAt`: on first sight in the flush, stamp `pending.reservedAt = now` (one transaction write) and poll as usual. Their age clock starts then. This is simpler than file mtime, which changes on every write.
- Add `retired: <reason>` to the flush result row so the CLI's `--json` output shows it.

## MVP

Only `we:scripts/operations/ci-heal-pr-dispatch.mjs` (`flushTimeoutFollowups`, the reservation stamp in `dispatchTimeoutRetry`, one new constant) and its test file. No change to `we:scripts/conveyor/timeout-retry-state.mjs`.

## Test plan

Add to the `describe('4863 retry reservation and restart soak')` block in `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs` (vitest; reuse its `evidence`, `observe`, `harness`). Each test creates a pending reservation with `dispatchTimeoutRetry` and a `request` that returns `{ status: 'ambiguous' }`, then counts `observe` calls during `flushTimeoutFollowups`.

1. `a closed-PR pending reservation stops being polled after one observation` — flush `observe` returns `open: false`. Flush 3 times. Expect exactly 1 observe call, state `retired.reason === 'pr-closed'`, and the request still `status: 'pending'`.
2. `a pending reservation older than the cap is retired without a GitHub read` — reserve with `now` at T0. Flush with `now = T0 + TIMEOUT_PENDING_MAX_AGE_MS + 1`. Expect 0 observe calls, `retired.reason === 'aged-out'`, request still `pending`.
3. `an open, young pending reservation is still polled every tick` — flush 3 times with `open: true`. Expect 3 observe calls and no `retired`. This guards against over-retiring.
4. `a legacy pending entry without reservedAt gets stamped, then ages out` — write a state file by hand with a pending request lacking `reservedAt`. First flush: 1 observe and `reservedAt` set. Flush again past the cap: no extra observe, `retired.reason === 'aged-out'`.
5. `a retired state still keeps the heal hold` — after test 1's setup, `readTimeoutHold` still returns a refusal. This pins that retiring does not free budget.

## Proof plan

No live state directory exists on this host now, so prove it with a replay of the recorded live shape:

- **Before:** on `main`, run a small node script in the scratchpad. It writes a state file in the exact `version: 1` shape `dispatchTimeoutRetry` writes (one `pending` request, `evidence` for a real closed PR such as #3559). It then calls `flushTimeoutFollowups` three times with a counting stub `observe` that returns `open: false`. Record 3 observe calls.
- **After:** run the same script on the lane. Record 1 observe call and `retired: 'pr-closed'` in the file.
- If a real `ci-timeout-reruns` directory exists by build time, also list its files. Show that any closed-PR entry gets `retired` after one live reconcile tick of the `we:scripts/operations/ci-heal-pr-dispatch.mjs` CLI run with `--json`.

## Done when

1. **Executable** — `npx vitest run scripts/operations/__tests__/ci-heal-pr-dispatch` passes, with the five new tests in `we:scripts/operations/__tests__/ci-heal-pr-dispatch.test.mjs`. Tests 1, 2 and 4 fail on `main` before the change.
2. A pending reservation whose PR reads closed or merged is observed at most once more, then never polled again.
3. A pending reservation older than `TIMEOUT_PENDING_MAX_AGE_MS` is retired with no GitHub read.
4. Retiring never changes a request's `status`. The retry budget and heal hold behave as before.
5. New reservations carry `reservedAt`. Legacy ones get stamped on first flush.
6. Replay proof (before: 3 observes, after: 1) is pasted in the PR.

## Follow-ups

- An aged-out pending reservation on a still-open PR keeps the heal hold forever (`readTimeoutHold`). Whether age should also release the hold is a separate policy call. File it only if it shows up live.
- A PR that gets a new head leaves the old-head state polling until it ages out. The age cap bounds it. A head-change retire could be added later if it matters.
- Retired state files are never deleted. A cleanup pass could prune them later.
