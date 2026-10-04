---
bornAs: xpl4fjv
kind: story
size: 2
parent: "3383"
status: resolved
scope: ["we:scripts/conveyor/session-reaper.mjs", "we:scripts/conveyor/__tests__/session-reaper.test.mjs"]
dateOpened: "2026-09-25"
dateResolved: "2026-10-03"
graduatedTo: none
preparedDate: "2026-10-03"
preparedAgainstSha: "e1f0523e0881357fc863f3e88da72e0164eb7091"
tags: []
---

# Session-reaper chat-spawn ceiling is defeated by a future-dated recordedAtMs

PR #2678 merged with its review's CONFIRMED security finding unfixed: we:scripts/conveyor/session-reaper.mjs classifyChatSpawnGuard checks nowMs - link.recordedAtMs >= ceilingMs, so a link file whose recordedAt is in the future yields a negative elapsed time that never reaches the ceiling and restores permanent reap-immunity - the exact bug the ceiling exists to close, contradicting its own comment that the ceiling holds regardless of what a link file claims. Fix: treat recordedAtMs greater than nowMs plus a small clock-skew tolerance as invalid (expired, not blocked), in tryReadChatSpawnLink or the guard. Math.max(0, nowMs - recordedAtMs), the review's suggested prevention, does NOT fix it (elapsed stays 0 forever). Add a ceiling test with a future-dated recordedAt. Done when that test fails on main and passes after.

## Progress

- Final verification: `npx vitest run we:scripts/conveyor/__tests__/session-reaper.test.mjs` (strip the locus prefix for shell execution) passed all 310 tests. `node we:scripts/verify-lane.mjs` passed 1,699 tests across 23 files and `npm run check:standards` completed with 0 errors (5,274 warnings); lane verdict green. `git diff --check` passed. Parent #3383 remains active with other open/active children, so no parent edit is needed.

- Implemented in this checkout on 2026-10-03, baseline HEAD `4f3995a8e7094eedc47ec66752bc6bc022b6b6f3`; the scoped implementation matched local `origin/main` before editing. Added the fixed five-minute constant, future-date rejection inside the existing clamp, and reason documentation in `we:scripts/conveyor/session-reaper.mjs`. Ended-link precedence and disabled-clamp behavior are unchanged.
- Before proof: ran the new #4184 tests in `we:scripts/conveyor/__tests__/session-reaper.test.mjs` against the unchanged implementation. Required tests 1, 2, and 6 failed with blocked results (`chat-not-ended`, `ambiguous-chat-link`, `chat-not-ended`, respectively). The corrupt-mtime soak also failed; the constant/boundary check failed because the new constant was not yet exported. Seven other selected cases passed.
- IO replay before/after: an inline Node module imported `makeChatSpawnGuardResolver`, used a disposable directory through `OPERATION_CHAT_SPAWNS_DIR` and `OPERATION_CHAT_ENDED_DIR`, fixed the clock at `2026-10-03T00:00:00Z`, and wrote a child link with a never-ended parent and `recordedAt: "2099-01-01T00:00:00.000Z"`. It then replaced that same file with corrupt JSON and set its mtime to the same 2099 instant using `utimesSync` (equivalent to the planned touch). Identical replay before and after the fix, with temporary fixtures removed after each run:
  - recordedAt before: `{"blocked":true,"reason":"chat-not-ended"}`; after: `{"blocked":false,"reason":"chat-spawn-link-future-dated"}`.
  - corrupt JSON / mtime before: `{"blocked":true,"reason":"ambiguous-chat-link"}`; after: `{"blocked":false,"reason":"chat-spawn-link-future-dated"}`.
- Regression coverage includes both link shapes, exactly five minutes ahead versus one millisecond beyond, ended precedence, omitted/null/non-positive/non-numeric ceilings, the extended ceiling invariant, real recordedAt IO, and 1,000 repeated corrupt-mtime resolver passes with a simulated clock advancing one minute per pass. No helper files or shared agent documentation were added. Proof is recorded here for human review; no PR was requested.


- Premise checked against current main. Still true. No drift in scope.
- The ceiling check is `we:scripts/conveyor/session-reaper.mjs:1367-1368 (classifyChatSpawnGuard)`: `if (nowMs - link.recordedAtMs >= ceilingMs)`. A `recordedAtMs` in the future makes the difference negative, so it never reaches the ceiling. The link stays blocked forever.
- `recordedAtMs` comes from `we:scripts/conveyor/session-reaper.mjs:1294-1298 (tryReadChatSpawnLink)`: the file's own `recordedAt` field, or the file mtime as a fallback (`mtimeFallbackMs`, line 1290). Both can be future-dated (a forged `recordedAt`, or `touch -t` on the file). So the fix belongs in the guard, which sees both.
- No commit on main fixes it (`git log -- we:scripts/conveyor/session-reaper.mjs`, latest 2789b3efc, does not touch this check).
- Existing ceiling tests: `we:scripts/conveyor/__tests__/session-reaper.test.mjs:2653` (describe "the ceiling — a link can never block reaping forever"). None uses a future `recordedAtMs`. The file runs under vitest.

## Design

Fix it in `classifyChatSpawnGuard` (`we:scripts/conveyor/session-reaper.mjs:1355`), not in `tryReadChatSpawnLink`. Reason: the guard sees both age sources (real `recordedAt` and mtime fallback) in one place, and it already owns the clock (`nowMs`).

- Add an exported constant `CHAT_SPAWN_LINK_FUTURE_SKEW_MS = 5 * 60 * 1000` (5 minutes) next to `resolveChatSpawnGuardCeilingMs`. The writer and the reader run on the same host, so real skew is near zero. 5 minutes is a safe margin. Not env-overridable (keep it simple; no setting asked for).
- Inside the existing clamp block (same `typeof ceilingMs === 'number' && ceilingMs > 0 && Number.isFinite(link.recordedAtMs)` guard), check FIRST:
  `if (link.recordedAtMs - nowMs > CHAT_SPAWN_LINK_FUTURE_SKEW_MS) return { blocked: false, reason: 'chat-spawn-link-future-dated' };`
  then the existing `nowMs - link.recordedAtMs >= ceilingMs` check.
- A future-dated link is treated as invalid: NOT blocked. It applies to both `ok:true` and `ok:false` links, same as the ceiling.
- `ended === true` with `ok:true` still returns `chat-ended` first (unchanged order).
- A link within the tolerance (e.g. 1 minute ahead) behaves as today: blocked, and its elapsed time is measured normally.
- Add `'chat-spawn-link-future-dated'` to the `@returns` union in the JSDoc of `classifyChatSpawnGuard`, and add one line to its doc comment. No caller depends on unblocked reasons (`we:scripts/conveyor/session-reaper.mjs:210 (classifySessionReap)` only reads `reason` when `blocked === true`).
- Do NOT use `Math.max(0, nowMs - recordedAtMs)`: elapsed would stay 0 forever and the bug remains.

## MVP

One new constant, one new early return in `classifyChatSpawnGuard`, JSDoc update, and the tests below. No other file changes.

## Test plan

In `we:scripts/conveyor/__tests__/session-reaper.test.mjs`, inside the describe "the ceiling — a link can never block reaping forever (security fix, PR #2678)" (line 2653). Import `CHAT_SPAWN_LINK_FUTURE_SKEW_MS` in the existing import block (line 12).

1. `it('a future-dated recordedAtMs is invalid — not blocked, chat-spawn-link-future-dated (#4184)')`: link `{ ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 + 365 * 24 * 60 * 60 * 1000 }`, `ended: false`, `nowMs: T0`, `ceilingMs: 10_000` → `{ blocked: false, reason: 'chat-spawn-link-future-dated' }`. Fails on main (returns `chat-not-ended` blocked).
2. `it('a future-dated ambiguous/corrupt link (mtime fallback) is also not blocked (#4184)')`: link `{ ok: false, recordedAtMs: T0 + 60 * 60 * 1000 }`, `nowMs: T0`, `ceilingMs: 10_000` → `{ blocked: false, reason: 'chat-spawn-link-future-dated' }`. Fails on main.
3. `it('a link within the clock-skew tolerance is still blocked (#4184)')`: link `{ ok: true, spawnedByChatSessionId: 'chat-1', recordedAtMs: T0 + CHAT_SPAWN_LINK_FUTURE_SKEW_MS }`, `nowMs: T0`, `ceilingMs: 24 * 60 * 60 * 1000` → `{ blocked: true, reason: 'chat-not-ended' }`. Passes before and after (guards against over-reach).
4. `it('ended still wins over a future-dated link — reason chat-ended (#4184)')`: future link with `ended: true` → `{ blocked: false, reason: 'chat-ended' }`.
5. Extend the invariant test at line 2696 ("every blocked reason ... reachable to unblocked") with a loop asserting that for each of the two link shapes with `recordedAtMs: T0 + 10 * CHAT_SPAWN_LINK_FUTURE_SKEW_MS`, `classifyChatSpawnGuard({ link, ended: false, nowMs: T0, ceilingMs: 10_000 }).blocked` is `false`.
6. End-to-end through IO: `it('makeChatSpawnGuardResolver does not block a session whose link file claims a future recordedAt (#4184)')`: in a `mkdtempSync` dir, write `<id>.json` with `{ v: 1, spawnedSessionId: id, spawnedByChatSessionId: 'chat-x', recordedAt: '2099-01-01T00:00:00.000Z' }`, build `makeChatSpawnGuardResolver({ spawnsDir, endedDir, now: () => Date.parse('2026-10-03T00:00:00Z') })`, call it with `{ sessionId: id }` → `{ blocked: false, reason: 'chat-spawn-link-future-dated' }`. Fails on main.

## Proof plan

There is no live future-dated link on this host (`~/.claude/we-chat-spawns/` is empty), so replay the exploit shape the card describes:

- Before (on main, in a temp dir via `OPERATION_CHAT_SPAWNS_DIR` and `OPERATION_CHAT_ENDED_DIR`): write a link file with `recordedAt: "2099-01-01T00:00:00.000Z"` and a parent id never marked ended. Run `node -e` importing `makeChatSpawnGuardResolver` and call it for that session id. Record `{ blocked: true, reason: 'chat-not-ended' }`, which is the permanent immunity.
- After (on the build branch): same command, same file. Record `{ blocked: false, reason: 'chat-spawn-link-future-dated' }`.
- Also replay the mtime variant: corrupt JSON body plus `touch -t 209901010000` on the file. Before: `ambiguous-chat-link` blocked. After: `chat-spawn-link-future-dated` not blocked.
- Paste both before/after outputs in the PR body.

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/session-reaper.test.mjs` (file `we:scripts/conveyor/__tests__/session-reaper.test.mjs`) passes, and the new tests 1, 2 and 6 from the Test plan fail on main before the change.
2. `classifyChatSpawnGuard` (`we:scripts/conveyor/session-reaper.mjs`) returns `{ blocked: false, reason: 'chat-spawn-link-future-dated' }` when `recordedAtMs - nowMs > CHAT_SPAWN_LINK_FUTURE_SKEW_MS`, for both `ok:true` and `ok:false` links, and only when a numeric `ceilingMs` is given.
3. All existing `classifyChatSpawnGuard` and ceiling tests still pass unchanged.
4. The before/after replay from the Proof plan is recorded in the PR body.

## Follow-ups

- None required. If a writer is ever on a different host from the reaper, revisit the 5-minute tolerance.
