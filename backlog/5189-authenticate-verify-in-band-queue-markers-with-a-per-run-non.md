---
bornAs: xhtuli0
kind: story
size: 2
tier: pinned
status: resolved
scope: ["we:scripts/conveyor/verify-dispatch.mjs", "we:scripts/verify-lane.mjs", "we:scripts/conveyor/__tests__/verify-dispatch.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs", "we:scripts/lib/lane-verify.mjs", "we:scripts/__tests__/lane-verify.test.mjs"]
dateOpened: "2026-10-06"
dateStarted: "2026-10-07"
dateResolved: "2026-10-07"
preparedDate: "2026-10-07"
preparedAgainstSha: "f0dc3af2af5539764d8fc5708ee5988b4a897265"
tags: []
---

# Authenticate verify in-band queue markers with a per-run nonce

Goal: gate output must not stretch its own ceiling by printing a line-anchored queue marker. Today we:scripts/conveyor/verify-dispatch.mjs:162 GATE_QUEUED_MARKER and scanLaterMarkers (:447-454) accept any line starting with the marker as a re-queue and swap the gate timer for the ~2 h queue ceiling; writer is we:scripts/verify-lane.mjs:513; the existing test at we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:364 only covers non-anchored text. Design: dispatcher makes a random nonce per run, passes it by env WE_VERIFY_MARKER_NONCE, verify-lane echoes it in both markers, scanLaterMarkers accepts only the current nonce; verify-lane strips the nonce from env handed to gate commands. Done when: new test with a spoofed no-nonce marker then hang gives timedOutPhase gate at the gate ceiling; real nonce marker still pauses the budget; vitest passes on we:scripts/conveyor/__tests__/verify-dispatch.test.mjs and we:scripts/__tests__/verify-lane.test.mjs; mutation proof (remove the nonce check, spoof test goes red). Out of scope: stdout/exit paths, supersede policy. Checklist: operator handoff checklist item 58. Follows #4054 (merged).

## Progress

Prepare pass (2026-10-06): premise check against `main` @ cc47a8e8. `git log --grep` for 5189/5189 finds only the JIT-numbering commit, so the goal is undelivered. All cited lines hold: `GATE_QUEUED_MARKER` at `we:scripts/conveyor/verify-dispatch.mjs:162`, `scanLaterMarkers` at `:447-454` (accepts `line.startsWith('⏳ gate queueing for admission')`), spawn at `:404`, writer at `we:scripts/verify-lane.mjs:513`/`:515`, existing test at `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs:364`. No drift; scope and size 2 unchanged.

Re-prepare (2026-10-07) against `main` @ f0dc3af2: goal still undelivered (no nonce in `we:scripts/conveyor/verify-dispatch.mjs`, `we:scripts/verify-lane.mjs`, `we:scripts/lib/lane-verify.mjs`). `we:scripts/verify-lane.mjs` grew ~186 lines, so line cites were refreshed: spawn `:405`, `scanLaterMarkers` `:448-457`, markers `:575`/`:577`, gate spawn `:540`, started marker `:523`, test describe `:322`. Design, MVP and scope unchanged.

## Design

1. `spawnGateBounded` (`we:scripts/conveyor/verify-dispatch.mjs:397`) mints `randomBytes(16).toString('hex')` per call and spawns the child with `env: { ...process.env, WE_VERIFY_MARKER_NONCE: nonce }` (the spawn at `:405` currently passes no env).
2. `scanLaterMarkers` (`:448-457`) skips any line that does not end with ` [nonce=<nonce>]` before testing the `⏳`/`⏱` prefixes. Unauthenticated lines are ignored, so a forged queue line can no longer swap the gate timer for the ~2 h queue ceiling (`onRequeue`, `:437`).
3. `we:scripts/verify-lane.mjs` reads `WE_VERIFY_MARKER_NONCE` once at startup, then deletes it from `process.env` so `runGate`'s spawn (`:540`, `env: { ...process.env, ... }`) and every gate command never see it. It appends the ` [nonce=...]` suffix to both later markers (`:575`, `:577`). If the env var is absent (verify-lane run directly), the suffix is empty and nothing changes.
4. Shared constant `VERIFY_MARKER_NONCE_ENV` and a `markerNonceSuffix(nonce)` helper live in `we:scripts/lib/lane-verify.mjs`, which both files already import, so the two sides cannot drift on the format.
5. **Residual limit (stated, accepted):** the nonce is echoed into stderr, which with `logPath` is the dispatch log in the lane dir, so a hostile gate that reads that file could replay a nonce. This card defends against gate OUTPUT text and env reads, not a deliberately hostile gate; hiding the nonce (e.g. a per-marker HMAC) is a Follow-up.
6. **Other callers / adoption:** `we:scripts/operations/probation-build-run.mjs`, `we:scripts/operations/probation-heal-run.mjs` and `we:scripts/operations/verify-io.mjs` invoke verify-lane directly and never parse these markers; with no env var the suffix is empty, so they are unaffected. The marker scan lives only inside the live `spawnGateBounded` call (the tail is in-process); no code re-parses a log after a daemon restart, so there is no adopter to lose a nonce. A restarted daemon may adopt an in-flight gate (`restartInFlight: adopt`, `we:scripts/conveyor/verify-dispatch.mjs:400`), but adoption tracks the pid only and does not rescan markers; if markers are ever rescanned, the nonce must be persisted or real markers fail closed to the gate ceiling. Rolling-upgrade window: a gate started by an old `verify-lane` has no suffix, so under a new dispatcher its re-queue waits count as gate time (one-time, fails closed).
7. The first `⏱ gate execution starting` marker (`we:scripts/verify-lane.mjs:523` writer; reader is the `includes()` check in `spawnGateBounded`) is left as is: spoofing it only arms the (shorter) gate timer early, it cannot lengthen anything.

## MVP

Musts only: nonce minting + env hand-off, nonce-checked `scanLaterMarkers`, nonce echoed on both later markers, nonce stripped from gate-command env, the new tests, and the existing queue/requeue fixtures updated to echo the nonce. Out of scope: stdout/exit paths, supersede policy, authenticating the first started marker (see Follow-ups).

## Test plan

In `we:scripts/conveyor/__tests__/verify-dispatch.test.mjs` (describe block at `:322`):
- Use `queueCeilingMs` ~1000 and a small `gateCeilingMs` in the spoof tests (today the spoof run is killed as `queue` at the queue ceiling; the `timedOutPhase: 'gate'` assertion is what distinguishes it). Also add: a nonce-suffixed queue line in the same chunk as the started marker still pauses the budget (the `:482` first-chunk path).
- Spoof, no nonce: child prints the started marker, then a bare `⏳ gate queueing for admission` line, then hangs. Asserts `timedOutPhase: 'gate'` at the gate ceiling. RED today: the bare line is accepted, the queue ceiling replaces the gate one, and the run is not killed as `gate`.
- Wrong nonce (`[nonce=deadbeef]`): same assertion, RED today for the same reason.
- Real nonce still pauses the budget: the existing requeue fixtures (`writeRequeueGate`, split-emoji test) are changed to read `process.env.WE_VERIFY_MARKER_NONCE` and echo it; they must stay green, proving authenticated markers still work. They go RED if only the checker is changed.
- `we:scripts/__tests__/verify-lane.test.mjs` (near the `⏱ gate execution starting` assertion at `:1554`): add a case (later markers only emit when `phaseAdmission` is on, `we:scripts/verify-lane.mjs:487`, so enable it via `verifyPhaseAdmissionEnabled`'s env knob with a multi-phase gate) asserting a `printenv`-style gate command does not see `WE_VERIFY_MARKER_NONCE` in its env, and that markers carry the suffix when the env is set. RED today: the var is not handled at all.
Mutation proof: delete the `endsWith(nonceSuffix)` check, confirm the spoof tests go red, restore.

## Proof plan

Run `npx vitest run we:scripts/conveyor/__tests__/verify-dispatch.test.mjs we:scripts/__tests__/verify-lane.test.mjs` (drop the `we:` prefixes when typing the command) green after the change, and record the mutation run (nonce check removed, spoof tests red) in the PR body. Live probe: run `spawnGateBounded` against a throwaway script that prints a forged queue line then sleeps, with a 300 ms gate ceiling, before and after; before the child outlives the ceiling, after it is killed with `timedOutPhase: 'gate'`.

## Edge cases this change must handle

1. Untrusted text: gate output lines are untrusted; compare the `[nonce=…]` suffix by exact `endsWith` on the whole line, never a regex built from output; a line with the nonce embedded mid-line is rejected.
2. Truncated reads: a marker split across stdout chunks is already rejoined by `lineCarry` (capped 4096); the nonce suffix must survive that split (test the split-emoji fixture with the suffix).
3. Shared state files: n/a: nonce is in-process env only, nothing written to a shared file.
4. Fail closed: a missing or wrong nonce means the line is ignored (timer unchanged); never accept on parse failure.
5. Identity scoping: one fresh nonce per `spawnGateBounded` call, so a nonce from a prior run never authenticates a later one.
6. State over time: n/a: no log is re-parsed after a daemon restart (Design item 6); a new adopter must persist the nonce.
7. Who wrote it: only the verify-lane child holds the nonce; it is deleted from `process.env` before any gate command spawns, so gate code cannot read it from env.

## Follow-ups

- Authenticate the first `⏱ gate execution starting` marker too (today a spoof can only shorten the ceiling, so low priority).
- Keep the nonce out of the readable log (per-marker HMAC or counter) to resist a hostile gate.
- Stdout/exit-path forgery and supersede policy, as noted out of scope on the card.

## Done when

1. **Executable** — `npx vitest run we:scripts/conveyor/__tests__/verify-dispatch.test.mjs we:scripts/__tests__/verify-lane.test.mjs` fails before this lands (the new spoof tests) and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
