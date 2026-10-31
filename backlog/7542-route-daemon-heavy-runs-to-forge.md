---
bornAs: xz5f6n4
kind: story
size: 8
status: open
scope: ["we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs", "we:scripts/lib/daemon-rebuild/auto-rebase.mjs", "we:scripts/readiness/remote-exec.mjs", "we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/__tests__/", "we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs", "we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs"]
dateOpened: "2026-10-31"
preparedDate: "2026-10-31"
preparedAgainstSha: "2ee4dcbf9bf17c1674e7948339d0b15c164151b6"
tags: []
---

# Route daemon heavy runs to Forge

Daemon heavy test runs never reach Forge. The health-watch overlay sync (we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs) and daemon-rebuild auto-rebase (we:scripts/lib/daemon-rebuild/auto-rebase.mjs) run vitest from a TMPDIR scratch clone, so heavy admission takes the no-pool bypass and skips both the host pool and the remote decision; their JSON-report flags are also refused by the Forge command allowlist. Reuse the lane remote path (we:scripts/readiness/heavy-admission.mjs, we:scripts/readiness/remote-exec.mjs) so these runs queue on the host pool and go to Forge, falling back to local on any remote failure, with no secrets shipped.

Ruling R244 (operator, 2026-10-31) delegates Forge routing to the orchestrator, with the aim of running most or
all heavy commands on Forge. Operator go for this prepare: 2026-10-31 07:58 ET.

## Proposed blockedBy changes

- (land-after, not an edge) PR #6059 (`lane/forge-remote-exec-s2`, S2 of PR #6017) has no backlog card — its body
  cites only PRs #6017 and #6058 — so it cannot be a `blockedBy` target. This card extends the remote client and
  Forge runner that PR rewrites (we:scripts/readiness/remote-exec.mjs, we:scripts/readiness/forge-exec-run.mjs);
  build only after #6059 merges. The edge below covers it, since 7533 itself must land after #6059.
- add 7533 (xw51scb) — binds every remote-exec git call to the cwd and checks the manifest against a filesystem
  walk (we:backlog/7533-forge-remote-exec-bind-git-to-cwd-and-verify-manifest-agains.md). A daemon scratch clone
  is exactly the kind of cwd whose git evidence must be bound before its tree is shipped.

## Progress

- 2026-10-31 — premise check on `origin/main` 2ee4dcbf9b. Not delivered: no daemon heavy run reaches the remote
  decision. Per-daemon causes found:
  - **health-watch overlay sync** (we:scripts/conveyor/health-watch.mjs:92 → we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:378-441):
    tests run from `$TMPDIR/we-overlay-main-sync-*/repo`. Admission derives the pool from that path and from the
    wrapper's own checkout, which is the same scratch copy (we:scripts/readiness/heavy-admission.mjs:1169-1180,
    we:scripts/lib/lane-pool-paths.mjs:44-82). Neither pool exists, so `admissionBypassReason` returns `no-pool`
    (we:scripts/readiness/heavy-admission.mjs:2047-2053) and the run skips both the host queue and the remote branch
    (we:scripts/readiness/heavy-admission.mjs:2342). The `WE_HEAVY_ADMISSION_HELD=1` seen on the live process is the
    marker the wrapper puts on its own child (we:scripts/readiness/heavy-admission.mjs:2103), not the cause.
    Second blocker: its `--reporter=json` and JSON output-file flags are not in `VITEST_ALLOWED_OPTIONS`
    (we:scripts/readiness/forge-exec-run.mjs:28-32), so even an admitted run would fall back `command-not-allowed`
    (we:scripts/readiness/remote-exec.mjs:521 on main; :572 on PR #6059).
  - **daemon-rebuild auto-rebase** (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:136-242): same two causes —
    `$TMPDIR/we-auto-rebase-*/repo` scratch clone, and the JSON report it needs for `alwaysRunInventory`.
  - **verify daemon, and the fix daemon's verify** (the fix daemon only awaits verdicts,
    we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs:61-63; the verify daemon spawns
    we:scripts/verify-lane.mjs with `--repo=<lane>`, we:scripts/conveyor/verify-dispatch.mjs:646): already on the
    lane path. verify-lane sets `WE_HEAVY_ADMISSION_HELD=1` plus `WE_FORGE_GATE_DISPATCH=1`
    (we:scripts/verify-lane.mjs:692), which is the one held case still allowed to try remote. These runs stay local
    only when host load is at or under the threshold (mode `above-threshold`). Its always-run phase uses the same
    JSON-report flags (we:scripts/lib/verify-lane-gate.mjs:817), so that phase always falls back today. The report
    return below is one step toward fixing it: that phase also adds `--testTimeout`/`--hookTimeout` when the
    timeout factor is not 1 (we:scripts/lib/verify-lane-gate.mjs:92-95), and those are not allowlisted either.
  - **review-daemon jurors**: tests are model-issued bare `npx vitest run <file>` inside a Codex read-only sandbox
    (we:scripts/operations/review-extra-seats.mjs:1219-1222, we:scripts/lib/codex-judge-spawn.mjs:233). No wrapper
    at all, the sandbox cannot write admission locks or reach ssh, and the juror carries an AI login that must
    never travel. Out of this card (Follow-ups).
  - **drain merge gate**: the drain runs no local test gate; its merge gate is the GitHub `test` check. Its one heavy
    run, the id-collision heal's `check:standards` (we:scripts/pr-land.mjs:1497), runs from the drain clone under
    `~/workspace/.lanes/we-drain-daemon/`, is not held, and is allowlisted, so it already reaches the remote
    decision. Nothing to change.
  - **daemon-rebuild live smoke** (we:scripts/lib/daemon-live-smoke.mjs): real `gh` reads, real lane leases and a
    reconcile dry-run with the daemon's tokens. It must stay local (no secrets on Forge). The soak suite
    (`test:soak*`, we:package.json:33-34) is not run by any daemon.
- Logs agree: no `heavy-admission: local|remote (…)` decision line appears in the health-watch, review or fix
  daemon logs. That line prints only once the remote branch is reached, so its absence matches a bypass.
- Adversarial review (2026-10-31): fixed realpath name matching, overlay sync's lost exit code, test 3 restated as
  a GUARD, Forge runner install added to the proof. Split suggestion kept as two ordered slices in one card: size 8
  is within the split limit and slice 1 lands alone.
- Scope corrected: test files live at `we:scripts/lib/__tests__/daemon-rebuild-*.test.mjs`, not a
  `daemon-rebuild/__tests__/` folder.

## Design

One remote path — the lane path — gets one small extension, and two daemon call sites start using it.

**1. Scratch runs join the host pool.** In overlay-main-sync (we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:438)
and auto-rebase (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:241), invoke the wrapper from the daemon checkout,
not from the scratch copy: the daemon checkout's copy of we:scripts/readiness/heavy-admission.mjs, as `node <that path> run --repo=<scratch> --wait-ms=540000 -- npx vitest run …`,
with cwd still `<scratch>`, and `--repo` passed as `realpath(scratch)` (macOS `/var/folders` is really
`/private/var/folders`; both daemons compare report names to `realpathSync(scratch)`,
we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:449, we:scripts/lib/daemon-rebuild/auto-rebase.mjs:247). `--repo` already feeds both the lock root and the remote cwd
(we:scripts/readiness/heavy-admission.mjs:2183-2190, 2349). Because the wrapper module now lives in the daemon
checkout, `admissionLockRoot`'s own-checkout fallback (we:scripts/readiness/heavy-admission.mjs:1176-1179) finds
`~/workspace/.lanes`. Do NOT set `LANE_POOL_ROOT`: the tests would inherit it and could touch the real pool.
The run then queues on the shared pool like any lane run and reaches `runWithRemoteDecision` unchanged.

**2. The Vitest JSON report comes back from Forge.** Both daemons (and verify-lane's always-run phase) need a
JSON report written to a local file, separate from stdout, because stdout can be forged by any test that prints.
Extend the existing client/runner pair, gated by a new runner capability (same pattern as `gitWorktree`,
we:scripts/readiness/remote-exec.mjs:683-689):
- `allowedCommand` (we:scripts/readiness/forge-exec-run.mjs:33-63) accepts `--reporter=json` plus exactly one
  JSON output-file flag (`--outputFile.<json>=<local path>`). The client removes that path from the wire argv and sends `report: 'vitest-json'`
  instead. The runner picks its own path inside the run directory; the client's path never reaches Forge.
- After the run the runner reads that file (regular file, no symlink, ≤ 8 MiB) and returns it in the result frame,
  covered by the same receipt check that covers the exit code (`verifyReceipt`, we:scripts/readiness/remote-exec.mjs:754).
- The client rewrites each `testResults[].name` from the Forge run root to `realpath(cwd)`, refusing any name outside
  that root (mirror of `portableCoverage` in PR #6059), then writes the file atomically to the caller's path.
- A runner without the capability answers `not-started` → local fallback, so the client can ship before Forge is
  re-installed.

**3. Remote failure never turns a daemon red.** Lanes already fall back on `not-started`. The one case that does not
fall back is `unconfirmed` → exit 124 "refusing local rerun" (we:scripts/readiness/heavy-admission.mjs:754). Today
both daemons read any non-zero exit as a test failure. Overlay sync cannot even see the code: its `runTests`
maps every exit to `status: error ? 1 : 0` (we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:320-322), so it must
pass through the real exit code; auto-rebase must keep it through `requireOk`
(we:scripts/lib/daemon-rebuild/auto-rebase.mjs:242). Both then read exit 124 with that stderr line as an
infrastructure skip: no sync, no push, retry next tick, and never a pass.

No secrets move: the wire env stays the 7-key `filterEnv` list (we:scripts/readiness/remote-exec.mjs:43-55), the
manifest is the tracked tree, credential-named files still need public `origin/main` evidence
(we:scripts/readiness/remote-exec.mjs:183-200), and the report travels Forge → Mac only.

## MVP

Musts, built in this order (slice 1 lands alone and is useful: runs join the host pool and still fall back cleanly):
- Slice 1: overlay sync and auto-rebase call the daemon checkout's wrapper with `--repo=realpath(scratch)`; their
  runs hold a host pool slot and reach the remote decision; both daemons treat exit 124 "remote termination
  unconfirmed" as an infrastructure skip, never a red, never a pass.
- Slice 2: `allowedCommand` accepts the one JSON-report form; the report returns through the receipt with path rewriting;
  runner capability gate with `not-started` fallback for older runners;
  the Forge runner is re-installed with the capability.
- The existing `alwaysRunInventory` check runs unchanged on the returned report.

Out (Follow-ups): juror test routing, verify-lane always-run wiring beyond what falls out for free, policy changes to
`mode` / `loadPerCoreThreshold`, soak suite routing.

## Test plan

Each RED on `main` before the fix unless marked GUARD:
1. `we:scripts/lib/__tests__/daemon-rebuild-overlay-main-sync.test.mjs` — "runs tests through the daemon checkout's wrapper with --repo=scratch":
   assert the spawned argv runs the daemon root's copy of we:scripts/readiness/heavy-admission.mjs with `run --repo=<scratch>` and env has no
   `LANE_POOL_ROOT`. RED: today the argv is the relative scratch path with no `--repo`.
2. Same for `we:scripts/lib/__tests__/daemon-rebuild-auto-rebase.test.mjs`. RED for the same reason.
3. GUARD, `we:scripts/readiness/__tests__/heavy-admission.test.mjs` — "a temp-dir repo resolves the own-checkout pool":
   unit test of `admissionLockRoot(tmpRepo, env, { ownCheckout, exists })` with injected `exists` and an env that is
   not under test; assert it returns the own checkout's pool. Green on main already (the fallback exists, and it is
   off under Vitest, we:scripts/readiness/heavy-admission.mjs:1176); it pins the behaviour slice 1 relies on.
4. `we:scripts/readiness/__tests__/remote-exec.test.mjs` — "JSON reporter form is allowed and the local path never reaches the wire": RED, today
   `command-not-allowed`. Also: two JSON output-file flags, or a plain `--outputFile=` with no reporter key, are refused.
5. `we:scripts/readiness/__tests__/remote-exec.test.mjs` — "returned report is rewritten to realpath(cwd) and written atomically" (fixture cwd under a symlinked dir); a name outside
   the Forge run root, a report over 8 MiB, or a report that fails the receipt check → fallback/refusal, no file
   written. RED: no report-return path exists.
6. `we:scripts/readiness/__tests__/remote-exec.test.mjs` — "runner without report capability → not-started fallback". RED: capability unknown.
7. Both daemon tests — "exit 124 with remote-unconfirmed is a skip, not an operator-review alert". RED: today overlay sync throws
   "selected tests did not pass or execute" and auto-rebase throws "selected test failed or incomplete"
   (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:242); overlay sync also loses the code at :320-322.

## Proof plan

Live, on the health-watch overlay sync, before/after:
- Before (now): overlay sync output has no `heavy-admission: local|remote (` line; the run's slot never shows in
  `node we:scripts/operations/run.mjs heavy-queue --json`.
- Install: re-install the Forge runner from the merged branch, then confirm the capability is live by reading the
  runner's `bases`/prepare capabilities reply (a report run that answers `not-started` with a too-old reason means it
  is not).
- After (loaded on the health-watch prototype via `prototype-load`): the sync's run appears in `heavy-queue` as a
  holder, its log carries `heavy-admission: remote (…)` when host load is above the threshold, and
  the host remote health file (`.admission/remote/health` under the lane pool) `recent[]` gains a run id at that time. The sync still finishes
  with the same pass/fail verdict as a local run on the same head.
- Fallback proof: with Forge unreachable (ssh to a bad host name in a throwaway run), the same sync falls back to
  local and completes; no alert is raised.

## Edge cases this change must handle

1. **Untrusted text** — report test names come from Forge files: refuse names outside the run root, NUL, or `..`;
   stderr text used for the exit-124 match is matched against a fixed literal, never interpolated into argv or a shell.
2. **Truncated reads** — report over 8 MiB or a short frame → refusal and local fallback, never a partial file; the
   daemons keep their own 8 MiB check (we:scripts/lib/daemon-rebuild/overlay-main-sync.mjs:443).
3. **Shared state files** — the local report is written temp-then-rename; remote slots stay under the existing
   `remote/slot-N` locks and `.unconfirmed` markers; no new shared file.
4. **Fail closed** — missing, malformed or unverified report → `alwaysRunInventory` sees `null` and fails as today;
   a remote failure is a skip, never a pass.
5. **Identity scoping** — the report is bound to the run's nonce and receipt; the run id keys the Forge run dir; the
   daemon still checks HEAD and clean tree after tests (we:scripts/lib/daemon-rebuild/auto-rebase.mjs:257).
6. **State over time** — a slot marked unconfirmed stays retained (existing rule); a retried tick starts a new run id;
   a daemon restart mid-run leaves only the existing remote slot recovery to apply. Admission policy is read with
   `checkoutRoot: repo` (we:scripts/readiness/heavy-admission.mjs:2184), i.e. from the candidate tree — same as lanes;
   `remote.clientPath` stays host-file-only (we:scripts/readiness/heavy-admission.mjs:339-358), so a candidate cannot
   pick the client code. The scratch's `../frontierui` symlink points at the live Frontier UI checkout; a dirty or
   moving sibling must end in `not-started` (local fallback), never `unconfirmed` — the build adds a test for it.
7. **Who wrote it** — only the receipt-verified frame from the `ops` runner is trusted; the client's local path is
   never sent, so Forge cannot choose where on the Mac the report lands.

## Follow-ups

- Juror tests on Forge: a host-side broker the read-only juror can ask to run one allowlisted test file through the
  lane path, with no AI login leaving the Mac.
- Wire verify-lane's always-run phase to the returned report (plus allowlist its `--testTimeout`/`--hookTimeout`)
  and prove it live on a lane.
- Revisit `mode: above-threshold` / `loadPerCoreThreshold: 1` for daemon runs once these routes exist (R244 aims
  at most/all heavy runs on Forge).
- Allowlist and route `test:soak:shard` if a daemon starts running it.
