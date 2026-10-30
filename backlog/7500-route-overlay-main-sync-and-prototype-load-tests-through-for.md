---
bornAs: xvcutvt
kind: story
size: 5
status: open
scope: ["we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs", "we:scripts/operations/prototype-load-io.mjs", "we:scripts/readiness/heavy-admission.mjs", "we:scripts/readiness/__tests__/heavy-admission.test.mjs", "we:scripts/readiness/__tests__/heavy-admission-remote.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs", "we:scripts/operations/__tests__/prototype-load.test.mjs", "we:scripts/operations/__tests__/prototype-load-io-real.test.mjs"]
dateOpened: "2026-10-30"
preparedDate: "2026-10-30"
preparedAgainstSha: "52ea97e920a86e2852108299a2e04e00a5bed1e9"
tags: []
---

# Route overlay-main-sync and prototype-load tests through Forge

overlay-main-sync (we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs) fails 'test selection over 100' and times out on the Mac; prototype-load combined tests (we:scripts/operations/prototype-load-io.mjs) run the whole tracked inventory locally. Route both through the Forge remote path (we:scripts/readiness/heavy-admission.mjs, we:scripts/readiness/remote-exec.mjs), drop the 100 cap when routed to Forge, select from the overlay's own changed plus conflict-resolved files. R239.

## Design

Today `runOverlayMainSync` (we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:306) selects tests = overlay-own test files plus reverse-import dependents of files both the overlay and main changed, throws `test selection over 100` (line 306), then runs `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <tests> --reporter=json` locally inside a scratch clone (lines 314-318, `runTests` line 236, 30 min timeout). `we:scripts/operations/prototype-load-io.mjs` (lines 86-135) builds a combined-tree worktree and runs the WHOLE tracked test inventory (bounded by `MAX_RELATED_TARGETS`, line 92) through the same heavy-admission wrapper. Both therefore consume Mac slots and the cap makes the first fail closed on any real overlay.

Mechanism: both callers already go through `we:scripts/readiness/heavy-admission.mjs run`, which owns the remote routing decision (`heavyAdmission.remote.*`, we:scripts/readiness/heavy-admission.mjs:411-485) and the Forge remote path from PR #6059 (warm bases, delta ship, telemetry, remote cap/back-off). Supported remote command classes are `npx vitest run|related` and `test:unit`. So:

1. Add one pure helper `forgeRoutedTestRun({scratch, tests, ...})` in a new we:scripts/lib/forge-test-route.mjs that (a) asks heavy-admission policy whether a run is Forge-routed (new `--route=forge` flag meaning "remote required, never fall back to a local full run"), (b) returns `{routed, reason}`.
2. overlay-main-sync: selection becomes the overlay's own changed files (`own`) PLUS the files git left conflict-resolved by the merge (`git diff --name-only --diff-filter=U` before resolution is already read as `conflicts`; for a clean merge use files changed on both sides, i.e. `own` intersect `mainFiles`), expanded through the existing reverse import graph. The cap of 100 applies only when the run is local; when routed to Forge it is replaced by a settings bound (`overlayMainSync.forgeMaxTests`, default 2000) so a runaway selection still fails closed. Local fallback keeps the 100 cap.
3. prototype-load-io: the combined-tree test run is passed `--route=forge`; the scratch worktree is delta-shipped as in #6059. The inventory-size refusal (line 92) is lifted only when routed to Forge, using the same settings bound.
4. A single setting `forgeOverlayTests.enabled` (default false) gates both; off = today's behaviour byte for byte (rollback).
5. Receipts: each routed run records the Forge run id, test count, and Mac-hold seconds (time a local heavy slot was held) in the overlay event log and the prototype-load verdict.

## MVP

Musts only: the setting; overlay-main-sync selection from own + conflict/overlap files; cap lifted only when Forge-routed with a bound; prototype-load combined run routed; receipts with Forge run id and Mac hold; fail closed when Forge is unreachable (no silent local fallback for a routed run, matching heavy-admission's remote-failed refusal, exit 124).
Out of scope (Follow-ups): per-slot worker pool, check:standards remote, auto-enabling the setting, selection smarter than reverse-import.

## Test plan

- `overlay-main-sync routed: 250 selected tests do not throw` - RED today: it throws at the 100 cap; passes with the setting on and Forge routing.
- `selection uses own plus conflict-resolved files` - RED today: only main-overlap dependents are selected, so a conflict file's dependents are missing.
- `routed run with Forge unreachable fails closed, no local rerun` - RED today: no routed mode exists, so the run starts a local vitest; asserts no local spawn.
- `prototype-load routed: inventory above MAX_RELATED_TARGETS proceeds` - RED today: refused as related-tests-truncated.
- `receipt contains forge run id and macHoldSeconds` for both callers - RED today: no such field exists.
- `overlay-main-sync local: 101 tests still throws` - preservation, green today and after; mutation proof: removing the local cap makes it fail.
- `setting off: argv and selection identical to today` - preservation, passes on both; mutation proof: routing while off changes the argv snapshot and fails it.
- `routed selection above forgeMaxTests refuses` - RED today: the bound does not exist; mutation proof not needed.

## Proof plan

On Forge with the setting on: (1) run a real overlay-main-sync against a registered overlay whose selection exceeds 100 (the case that fails today) and show the before refusal text, then the after run with Forge run id, test count, pass, and Mac hold ~0 s (heavy-queue shows no local holder for it); (2) run `prototype-load` for a real green+audited fix and show the combined test executed on Forge with receipts and Mac hold ~0. Then set the setting off and show the next run uses the local path unchanged.

## Follow-ups

- Route `check:standards` once the remote class lands.
- Per-slot Forge worker pool for parallel overlays.
- Default the setting on after N clean routed runs.
- Smarter selection (vitest `related`) instead of reverse-import graph.

## Acceptance

- [A1] **Executable** - `npx vitest run we:scripts/lib/daemon-rebuild/__tests__/overlay-main-sync-forge.test.mjs` fails before the build (cap throws at 250 tests) and passes after.
- [A2] **Executable** - `npx vitest run we:scripts/operations/__tests__/prototype-load-forge.test.mjs` fails before (no route flag, inventory refusal) and passes after.
- [A3] **Executable** - `npx vitest run we:scripts/lib/__tests__/forge-test-route.test.mjs`: setting off yields identical local argv and the 100 cap; Forge unreachable while routed yields refusal, never a local run.

## Non-goals

- [N1] Does not change which tests are trusted as evidence, does not enable the setting by default, and does not add check:standards or worker-pool routing.

## Edge cases this change must handle

1. **Untrusted text** - overlay ref and file names come from git; keep `isSafeBranchName` and `cleanText`, pass test paths after `--` style argv only when they do not start with `--`; reject paths with NUL or newline.
2. **Truncated reads** - git diffs read with `-z` and full buffers; a Forge report over 8 MiB or a missing/short JSON report is an error, never "all passed"; selected-vs-executed set must match.
3. **Shared state files** - receipts append through the existing atomic overlay event log; the sync marker lock and heartbeat are unchanged.
4. **Fail closed** - Forge unreachable, back-off, report missing, or selection above `forgeMaxTests` refuses with a named reason; no silent local rerun of a routed run.
5. **Identity scoping** - receipts keyed by overlay ref + head sha + main sha + Forge run id; a stale receipt for an older head is not accepted.
6. **State over time** - a retry after a timeout must confirm the remote run is terminated before rerun (heavy-admission exit 124 contract); restart mid-run resumes via the marker token.
7. **Who wrote it** - overlay and candidate tests are untrusted code: they run only in the Forge sandbox with the filtered env (`filterEnv`), never with Mac credentials; receipts are trusted only when written by the daemon itself.

## Rollback

Set `forgeOverlayTests.enabled=false`: selection cap, local execution and prototype-load inventory bound return to current behaviour with no data migration.

## Dependencies

Needs PR #6059 (lane/forge-remote-exec-s2) merged for the `npx vitest run|related` remote classes.
