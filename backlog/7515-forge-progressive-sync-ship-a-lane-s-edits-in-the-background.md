---
bornAs: xig5aoo
kind: story
size: 8
status: open
scope: ["we:scripts/readiness/remote-exec.mjs", "we:scripts/readiness/forge-exec-run.mjs", "we:scripts/readiness/forge-exec-bases.mjs", "we:scripts/readiness/__tests__/remote-exec.test.mjs", "we:scripts/readiness/__tests__/forge-exec-run.test.mjs"]
dateOpened: "2026-10-30"
preparedDate: "2026-10-31"
preparedAgainstSha: "2ee4dcbf9bf17c1674e7948339d0b15c164151b6"
tags: []
---

# Forge progressive sync: ship a lane's edits in the background while the worker edits

HIGH cards-to-file entry 2026-10-30 07:08 ET (operator: yes to track). Baseline: 42s wall for a 3s test (manifest 11.8s, rsync 5.9s, receipt 2.3s, Forge setup). The delta manifest (#6100) and pre-warmed slots (#6104) are built; the remaining item is pushing a lane's changes to Forge in the background as the worker edits, so run time ships almost nothing. Core: we:scripts/readiness/remote-exec.mjs.

## Progress

- 2026-10-31 — premise check against `origin/main` 2ee4dcbf9b and PR #6059 head 4186445120.
  - Not delivered: no `presync`/background-sync code exists on main or #6059 (`git grep -nE "presync|progressive"`
    in we:scripts/readiness is empty), and no commit references 7515/xig5aoo.
  - Premise holds with one correction. The delta manifest reached main through PR #6101 (stacked on #6100), and
    pre-warmed slots through PR #6104. But on #6059 the delta path refuses every real lane
    (`Projected memory inputs require full ship`, we:scripts/readiness/remote-exec.mjs:499 on #6059). Card 7534
    fixes that. Without 7534, a background sync would have no delta to send. So this card builds on 7534 and
    7533, and must not invent its own manifest.
  - Run-time ship today (on #6059): build the delta manifest (:669), stage the changed leaves into a temp dir
    (:680-750), `prepare` on Forge (:771), then one rsync of the `deltaPaths` list (:800-811). The Forge runner
    assembles base leaves plus the shipped leaves and re-checks the whole tree with `verifyManifest`
    (we:scripts/readiness/forge-exec-run.mjs:827-875).
  - **Scope corrected:** added the two test files the plan needs. **Size 5 → 8:** three new runner subcommands
    (we:scripts/readiness/forge-exec-run.mjs:997 lists the allowed ones), a cache directory with a size cap and
    pruning (beside the base store in we:scripts/readiness/forge-exec-bases.mjs), and a client sync loop plus its
    lock and state.
  - Overlap: card 7542 (xz5f6n4, PR #6125) edits the same client and runner (admission, allowlist). It touches
    different functions; whichever lands second rebases.
  - Adversarial review (2026-10-31): added the Forge ownership and install model, the 7533 walk-first rule,
    `--no-optional-locks`, the watcher's minimal env and retention, and positive controls for T3/T5. Kept the
    watcher as a Must (it is the card's goal) but moved lease-end stop to Follow-ups. One finding was dismissed:
    the `protocolText` citation (:558) is correct on the #6059 head.

## Design

One idea: **send changed file contents to Forge early, keyed by their sha256; at run time, ship only what Forge
does not already hold.** Nothing about what is trusted changes. The run-time manifest is still built, bound and
walk-checked exactly as 7533 and 7534 define, and Forge still verifies the assembled tree. Presync only changes
where the bytes come from.

1. **Client: a new `presync` subcommand** in we:scripts/readiness/remote-exec.mjs.
   - It builds the manifest with the same function the run uses (`buildDeltaManifest`, under 7533's `bindGit` and
     filesystem walk). It never uses a separate scan, so the exclusion rules are identical: credential files
     (`classifyManifestPath(...).credentialSource`, we:scripts/readiness/forge-exec-manifest.mjs:93) and
     ignored paths are never sent.
   - If the delta build falls back to full scan, presync does nothing that round. It never ships a full tree in
     the background.
   - It stages the changed leaves the same way the run does (:680-750, re-hashing every byte). It asks Forge which
     sha256 values it already has (`presync-have`), then rsyncs only the missing ones with the same rsync safety
     flags as the run (:800-801: `--no-links --safe-links --no-recursive`). The files go into the lane's cache
     on Forge, named by sha256, and `presync-put-done` asks Forge to check and keep them.
   - **7533's checks run first.** Each round runs the full 7533 walk check on the manifest before anything is
     staged. A walk mismatch skips the round. Presync adds no git call of its own. The git reads that can take
     `index.lock` (`status`) get `--no-optional-locks` through `bindGit`, so a round never blocks the worker's
     own git.
   - **No env and no logins travel.** Presync sends no environment at all. Its ssh call uses the same
     `connectionOptions()` as the run (:18). The command only ever reads the lane's own tree, so home-directory
     logins (Claude, Codex, gh) are never in scope. The walk check already refuses any extra symlink.
     The detached watcher is spawned with a minimal env (`PATH`, `HOME`, `SSH_AUTH_SOCK` only), never the
     caller's env.
   - **Retention:** sent bytes stay in the lane's Forge cache until pruned (24h at most), even if the file is
     later deleted locally. They are only files the run itself would ship, under the same credential exclusions.
2. **Client trigger: a watcher, started on demand.** The watcher is what makes the sync happen "while the worker
   edits", which is this card's goal, so it is a Must. `presync --watch` runs a recursive `fs.watch` on the lane
   with a 2s debounce. Each burst of edits leads to one presync round, and rounds never overlap. Only one watcher
   runs per lane, held by a lock file in the lane's `.git` dir (`withFileLock`,
   we:scripts/lib/atomic-json-file.mjs). The first remote run in a lane starts it detached if none is running. It
   stops after 30 minutes with no edits. The very first run in a lane gets no speed-up; every later run in the
   edit, test, edit loop does. Starting it at lane acquire, and stopping it at lease end, are Follow-ups.
3. **Forge: a per-lane, sha256-named cache** (we:scripts/readiness/forge-exec-bases.mjs, next to the base store).
   - Path: `<bases root>/presync/<laneKey>/<sha256>`. `laneKey` is the sha256 of the client host name plus
     `realpath(lane)`, so lanes never share a cache.
   - Forge re-hashes every received file before it is kept. A wrong hash, a non-regular file, or a file over
     `LIMIT` (4 MiB, we:scripts/readiness/forge-exec-manifest.mjs:2) is deleted and not kept.
   - Each lane's cache is capped at 256 MiB and 4,096 files, and files older than 24h are pruned. All cache
     writes and pruning go through the existing `baseGuard` lock (we:scripts/readiness/forge-exec-bases.mjs:125).
   - New runner subcommands `presync-have`, `presync-put-done` and `presync-claim` go on the allowlist
     (we:scripts/readiness/forge-exec-run.mjs:997). Each request has the same 4 MiB body limit as today (:1007).
   - **Who owns what on Forge.** These subcommands run as `ops` through the same root-owned wrapper and `sudo -n`
     path as `bases` (we:scripts/readiness/remote-exec.mjs:598, we:scripts/readiness/forge-exec-run.mjs:1001-1002).
     The cache belongs to `ops`, like the base store. Presync rsyncs into an `ops`-owned `incoming/` dir under the
     lane's cache (`--rsync-path=sudo -u ops rsync`). `presync-put-done` lstats and opens each file with
     `O_NOFOLLOW`, re-hashes it, and renames it into place. `presync-claim` copies cache files into the run stage
     the same way, then hands ownership to the slot through the existing `handoff` (:572).
   - **Install:** the wrapper and sudoers entry are installed by the Forge setup script
     (we:scripts/readiness/forge-setup.sh). The build re-runs it, and a missing subcommand on an old wrapper
     means "no presync" (zero claimed), never a run failure.
4. **Run time: claim from the cache, rsync the rest** (we:scripts/readiness/remote-exec.mjs, around :771-811).
   - After `prepare`, the client sends `presync-claim {run, entries:[{path, sha256, executable}]}` for its
     `deltaPaths`. The runner copies each cached file into the run's stage at its path, re-hashes it, and replies
     with the paths it claimed. Only the claimed paths leave the rsync `--files-from` list.
   - The existing `verifyManifest` on the assembled tree (we:scripts/readiness/forge-exec-run.mjs:867, :875)
     stays the final check. A bad cache file fails it, and the run goes down the existing delta-to-full retry
     (we:scripts/readiness/remote-exec.mjs:815-818, :847-852). That path ends at local fallback if remote fails
     again.
   - `inputDigest` (:768) is computed on the client as today, so the receipt binding does not change.
5. **Every presync failure is silent for the run.** A presync error (ssh, rsync, lock, cache full) is written to
   the lane's presync state file (atomic write, we:scripts/lib/atomic-json-file.mjs) and the watcher stops. It
   never touches a run. At run time, a failed or missing `presync-claim` just means zero paths are claimed, and
   the run ships everything as it does today. A presync problem can never stop a run, cause `not-started`, or
   block the local fallback.

## MVP

- Steps 1-5: `presync` (one round) and `presync --watch`, the per-lane sha256 cache with its caps and pruning,
  the three runner subcommands (`presync-have`, `presync-put-done`, `presync-claim`), and claim-then-rsync at run
  time.
- Telemetry: the run's rsync record gains `presyncClaimed` (count and bytes), next to `deltaFileCount`.
- OUT (Follow-ups): starting the watcher at lane acquire or from an edit hook; sharing a cache across lanes;
  building the manifest in the background as well (only bytes are sent early); sending presynced files for the
  sibling frontierui tree.

## Test plan

Each case is RED today because the subcommand or claim step does not exist.

- **T1 claim skips shipped bytes** (we:scripts/readiness/__tests__/remote-exec.test.mjs, fake exec): presync one
  edited file, then run. The run's rsync `--files-from` input leaves out that path, and the telemetry shows
  `presyncClaimed:1`. The receipt verifies.
- **T2 a bad cache file is caught:** the fake runner claims a path but writes different bytes. `verifyManifest`
  refuses, the run retries with a full ship, and the exit code matches a clean run. It never reports a pass on
  the wrong bytes.
- **T3 a presync failure leaves the run unchanged:** with the presync ssh failing, and separately with
  `presync-claim` returning an error, the run ships the same paths as a no-presync run and reaches the same
  result. When remote also fails, it falls back to local. RED today: `presync-claim` is never sent, so the
  "claim failed, zero claimed" telemetry it asserts is absent. Positive control: make a claim error throw out of
  the run, and T3 turns red.
- **T4 same exclusions as the run:** a lane with a credential file (an `.env`-type file), an ignored file and an
  extra symlink. Presync sends none of them, and refuses the round on the symlink (7533 walk check (b)).
- **T5 no env sent:** a presync round runs (RED today: no round exists to observe). Its ssh and rsync argv and
  input, and the detached watcher's spawn env, hold no env keys from the caller. `GITHUB_TOKEN` and
  `ANTHROPIC_API_KEY` set in the test env never appear. Positive control: pass `process.env` to the watcher
  spawn, and T5 turns red.
- **T6 runner cache checks** (we:scripts/readiness/__tests__/forge-exec-run.test.mjs): a put whose bytes do not
  match their sha256 name, a non-regular file, a file over 4 MiB, and a cache over 256 MiB or 4,096 files. Each
  is refused or pruned, and nothing is kept.
- **T7 lanes stay apart:** lane A's cached file is not claimable by lane B (different `laneKey`), even with the
  same sha256.
- **T8 one watcher per lane:** two `presync --watch` starts. The second exits on the held lock, and a stale lock
  (dead pid) is taken over only through the lock helper's guard.
- **T9 fast edits:** an edit during a presync round starts one more round after the debounce, and the last round
  matches the final tree.

## Proof plan

- Install the new runner on Forge with we:scripts/readiness/forge-setup.sh, and confirm an old wrapper (before
  the reinstall) gives zero claimed and a normal run.
- Live, from a real lane with a warm base and 7533 + 7534 landed: run
  `npx vitest run` on we:scripts/readiness/__tests__/remote-exec.test.mjs through Forge twice. First without the
  watcher, then with `presync --watch` running and a few edits made 10s before the run. Compare the telemetry
  rsync records: `bytesSent` should drop to near zero, `presyncClaimed` should match the edited files, and the
  wall time should drop by about the 5.9s rsync stage. The receipt verifies both times.
- Live failure proof: point only the watcher at a wrong host, make edits, run. The run ships normally and passes;
  the presync state file names the error.

## Edge cases this change must handle

1. **Untrusted text** — file names stay Buffers end to end and reach rsync only through `--from0 --files-from=-` with `./` anchors (:755-757), never argv; the lane path never reaches argv after `--` (T4).
2. **Truncated reads** — `presync-have` and `presync-claim` replies are bounded with `protocolText` (:558) and must list exactly the asked sha256s; a short or extra reply means zero claimed (T3).
3. **Shared state files** — the watcher lock and presync state file use `withFileLock` + `writeJsonAtomic`; Forge cache writes and pruning run under `baseGuard`; a stale lock is taken only by a dead-pid check (T8).
4. **Fail closed** — any presync or claim error means "ship it normally"; a bad cache file is caught by `verifyManifest` and goes down the existing full-ship retry and then local fallback; never a pass on unverified bytes (T2, T3).
5. **Identity scoping** — cache keyed by `laneKey` = sha256(host + realpath(lane)) and by file sha256; claims are bound to the prepared `run` id (T7).
6. **State over time** — 24h TTL and size caps prune the cache; a watcher stops after 30 min idle or at lease end; a restart mid-round leaves only verified sha256-named files, which are safe to reuse (T6, T9).
7. **Who wrote it** — a cached file is trusted only by its re-hashed content, never by its name or its writer; Forge re-hashes on put and on claim (T2, T6).

Endpoint limits (the receive-endpoint hint): body cap is the runner's 4 MiB request limit (:1007) and 4 MiB per
file; rate is one presync round per debounce window per lane under the lock; there is no browser origin (ssh
only, so CSRF/origin does not apply); the only state-reset trigger is pruning, which can only cause a cache miss,
never a wrong pass.

## Follow-ups

- Start the watcher at `lane-pool acquire` (or from an edit hook) so the first run in a lane also benefits.
- Build the manifest in the background too, so the run reuses a fresh manifest when nothing changed since.
- Presync the sibling frontierui tree.
- Share cache files across lanes once a cross-lane trust rule is decided (an operator call).

## Proposed blockedBy changes

- (land-after, not an edge) PR #6059 has no backlog card; build only after it merges.
- add 7533 — presync must build its manifest under 7533's bound git and filesystem walk
  (we:backlog/7533-forge-remote-exec-bind-git-to-cwd-and-verify-manifest-agains.md:20-23).
- add 7534 — without 7534 the delta path refuses every real lane (we:scripts/readiness/remote-exec.mjs:499 on
  #6059), so presync would have nothing to send.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/readiness/__tests__/remote-exec.test.mjs -t "presync"` (T1-T5, T7-T9) fails before (no presync subcommand or claim step) and passes after.
- [A2] **Executable** — `npx vitest run we:scripts/readiness/__tests__/forge-exec-run.test.mjs -t "presync"` (T6) fails before (unknown subcommand) and passes after.
- [A3] **Executable** — the fail-closed paths: presync failure and claim failure leave the run's shipped paths and result unchanged, with local fallback still reached when remote fails (T3 in the A1 run).

## Non-goals

- [N1] No change to what is trusted: the run-time manifest, the walk check, `verifyManifest` and the receipt are untouched. No env, secrets or AI logins are ever sent.
