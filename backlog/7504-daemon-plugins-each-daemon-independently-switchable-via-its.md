---
bornAs: xuac7be
kind: story
size: 5
parent: "3383"
status: open
scope: ["we:scripts/lib/daemon-plugins.mjs", "we:scripts/settings/daemon-plugins.json", "we:skills-src/conveyor/verify-daemon.mjs", "we:scripts/verify-lane.mjs", "we:scripts/lib/daemon-clone-registry.mjs", "we:scripts/lib/__tests__/daemon-plugins.test.mjs", "we:skills-src/conveyor/__tests__/verify-daemon.test.mjs", "we:scripts/lib/__tests__/daemon-clone-registry-fix-clone.test.mjs", "we:scripts/__tests__/verify-lane.test.mjs"]
dateOpened: "2026-10-29"
preparedDate: "2026-11-01"
preparedAgainstSha: "174220fad20252329d315759de9702bbcc698979"
tags: []
---

# Daemon plugins: each daemon independently switchable via its own policy-cascade setting, one daemon at a time (verify first)

Operator ruling R238 (2026-10-29 21:06 ET): split the web-everything daemons (review, fix, drain, health-watch,
control, build) into independently switchable plugins, one daemon at a time, starting with the daemon that
carries zero live prototype overlays, each behind its own policy-cascade on/off setting
(we:scripts/lib/policy-cascade.mjs), prototype-loadable before merge (R228). Reuses the ratified conveyor runner
split (#3860/#3874: supervisor + one process per piece;
we:docs/agent/platform-decisions.md#conveyor-orchestration-mechanics-not-per-lane-agent, #2701/#2702) rather than
re-deriving it. This slice: the plugin descriptor + setting resolver, and the verify daemon
(we:skills-src/conveyor/verify-daemon.mjs, clone `wev-control`, 0 overlays) as plugin one.

## Progress

Prepared 2026-10-29 (ET) against `origin/main` ff1fa58cc7; refreshed 2026-11-01 (below, R357). Premise check (original):

- **The process split already exists; the switch does not.** #3860's umbrella and its slices #3870–#3878 are all
  resolved: fix, review, verify and the 8 watcher passes each run as their own process
  (we:skills-src/conveyor/pass-daemon.mjs over the closed allowlist in we:skills-src/conveyor/daemon-manifest.mjs;
  #3874's we:skills-src/conveyor/supervisor-launcher.mjs). So "plugin" here does NOT mean a new process topology.
  It means: one declared descriptor per daemon (name, entry, launchd label, clone, setting key), and one
  policy-cascade on/off switch the daemon reads itself. Today the only off levers are per-daemon ad-hoc kill
  switches (e.g. `WE_BUILD_DAEMON_KILL` / `build-dispatch-daemon.kill`, #3984) or `launchctl bootout`, and
  `--max-concurrent=0` on the build plist.
- **The coupling that hurts is the shared clone, not shared code.** `wev-review-daemon` hosts 12 launchd jobs
  (review-daemon, 9 pass-daemons, lease-reaper, resource-sampler) and 9 overlays. Every overlay loaded for the
  review daemon is live in every other job on that clone, and every shared-file move rebases all of them (the
  2026-10-29 review-daemon freeze on an overlay conflict).

### Refresh 2026-11-01 (ET evening), re-prepared against `origin/main` 174220fad2 (R357)

R357 asked for this refresh because facts moved today. Re-checked against current main, `node we:scripts/daemon-overlay.mjs list --clone=<clone>`:

| Daemon (launchd label) | Clone | Live overlays now (was 10-29) | Overlays touching the plugin's own files | Clone vs `origin/main` |
|---|---|---|---|---|
| verify (`com.we.verify-daemon`) | `wev-control` | **3** (was 0): `loader-fast-return-m3`, `-m11` (PR 6182), `slot-marker-reap-m1` | **none** (they edit prototype-load, overlay-adoption and Forge slot-marker files) | 18 ahead, 8 behind |
| build (`com.we.build-dispatch-daemon`) | `wev-control` (same clone as verify) | the same 3 | none | same |
| drain (`com.plateau.drain-daemon`) | `.lanes/we-drain-daemon/code` | 2 (`loader-fast-return-m5`, `-m13`); `plateau-drain-daemon`: 0 | none seen | not re-measured |
| health-watch (`com.we.health-watch`) | `wev-health-watch` | 4 (was 3): new top `unfreeze-health-watch-top-1101c`, `smoke-gh-throttle-env-m1`, two `loader-fast-return` | not re-diffed (PR 6062 / 6033 status not re-checked) | 311 ahead |
| merge passes (`merge-orphan-sweep`) | `wev-merge-daemon` | 1 (`proto-daemon-resources`, 10-18, unchanged, stale) | edits `we:skills-src/conveyor/daemon-manifest.mjs` | 31 ahead; **not a key in we:scripts/settings/prototype-load.json**, so the loader cannot target it |
| fix (`com.we.fix-dispatch-daemon`) | `wev-fix-daemon` | 3 (was 6) | not re-diffed | 16 ahead |
| review + 9 passes + lease-reaper + sampler | `wev-review-daemon` | 8 (was 9); review top `unfreeze-review-top-1101b-m1` was moved by hand (R351) after the 5h deadlock | not re-diffed | 189 ahead |

What this changes:

- **"0 overlays" is gone as the premise; the real test still holds.** `wev-control` now carries 3 overlays, but none touches
  we:skills-src/conveyor/verify-daemon.mjs, we:scripts/verify-lane.mjs, we:scripts/lib/daemon-clone-registry.mjs,
  we:scripts/lib/policy-cascade.mjs or we:skills-src/conveyor/runner-lock.mjs, and no open PR touches them (the R332 branch adds
  we:scripts/lib/verify-remote-routing.mjs beside, not inside, we:scripts/verify-lane.mjs). The rule is now "no overlay on the
  plugin's own files", not "no overlays". Verify is still the right first plugin: build is held by active #3984, merge passes
  are not loadable, and every other clone has 2 to 8 overlays.
- **New risk, the day's lesson: a shared clone couples adoption.** On 2026-11-01 the review clone's squash-landed overlays blocked
  the daemon rebuild for 5 hours (fix: #6184, hand move R351). Every launchd job on a clone adopts every loaded overlay and a
  rebuild conflict on that clone stops all of them. `wev-control` hosts two jobs (verify, build); `wev-review-daemon` hosts 12. A
  plugin switch makes a job independently *switchable*, not independently *adoptable*. See "Risk and sequencing ruling" below.
- **Prototype loading now has a new moving part.** PR 6182 added the `overlay-adopted` event and changes the loader files
  (we:scripts/operations/prototype-load-io.mjs, we:scripts/lib/overlay-adoption.mjs) that Proof plan step 1 uses; it is itself an
  overlay on `wev-control`. The proof must record the adoption through whichever loader is live.
- **Cites re-verified, moved:** `cascadePolicy` :176 to :189, `withFileLock` :154 to :157, the `request` lease check :569-580 to
  :572-581, the plist `WorkingDirectory` read :247 to :312 of we:scripts/operations/prototype-load-io.mjs. Unchanged and still
  true: `resolveCascade` :111-117, `writeJsonAtomic` :64, `RUNNER_LOCK_ROOT` we:skills-src/conveyor/runner-lock.mjs:63, `VERIFY_DAEMON_DRAIN_FILE` :85,
  `defaultIsDraining` :88, drain probe :383, `main()` :589 / lease :592, `DAEMON_CLONE_SEED` :63 (still lacks `wev-control`).
  `we:skills-src/conveyor/verify-daemon.mjs` has 0 commits on main since the first prepare; `we:scripts/verify-lane.mjs` has 11 (Forge routing), none near the
  request refusal.

### Overlay inventory (2026-10-29 ~21:30 ET, kept for history)

| Daemon | Clone | Live overlays then |
|---|---|---|
| verify / build / control | `wev-control` | 0 |
| drain | `.lanes/we-drain-daemon/code` | 2 |
| health-watch | `wev-health-watch` | 3 (one = PR 6033) |
| merge passes | `wev-merge-daemon` | 1 (`lane/proto-daemon-resources`, 171 files) |
| fix | `wev-fix-daemon` | 6 |
| review + passes | `wev-review-daemon` | 9 |

### Existing async/split-daemon cards (inventory, per the operator's 21:08 ET addition)

| Card | Status | preparedDate | Still accurate vs today (overlays, self-sync, prototype-load, R228, quick-mode #6084)? | This card |
|---|---|---|---|---|
| #3860 daemonize the runner (umbrella; its own slice = gh-throttle default swap) | resolved | — | Delivered. Its "many small independent daemons" shape is what this card builds on. | reuses |
| #3870 fix-dispatch daemon | resolved | — | Delivered (`we:skills-src/conveyor/reconcile-fix-dispatch-daemon.mjs`). | plugin later |
| #3871 pass-daemon + manifest | resolved | — | Delivered; the manifest is the allowlist this card's descriptor sits beside, never replaces. | reuses |
| #3872 credential scoping | resolved | — | Ruled. | n/a |
| #3873 8 watchers onto pass-daemon | resolved | — | Delivered. | plugin later |
| #3874 supervisor manifest launcher | resolved | — | Delivered; launchd plists, not the launcher, run the fleet today. | reuses |
| #3875 assertMainNotStale extraction | resolved | — | Delivered. | n/a |
| #3876 review daemon | resolved | — | Delivered. | plugin last |
| #3877 keyed runner-lock lease | resolved | — | Delivered; the verify lease key is what "off" releases. | reuses |
| #3878 verify daemon | resolved | — | Delivered; the subject of slice 1. | slice 1 |
| #3866 fleet GitHub credential | open | 2026-09-21 | Ratified 2026-09-22 (App, app-to-server); its "carve a build story" Done-when is met by #3881. Not a stale prepare; it is resolvable. | n/a |
| #3984 build-dispatch resident daemon | active | — | Slice 1 landed; plist runs `--max-concurrent=0`. No R228 prototype step in its later slices. | plugin two, after it settles |
| #4086 multi-host / multi-instance daemons | open (decision) | 2026-09-24 | **Partly stale**: Fork 3 ("which changes serve probation before the incumbent adopts them") predates the overlay registry, `prototype-load` and R228, which now answer it (prototype first, merge as soon as it passes). Re-prepare at ratification. | composes |
| #4088 route overlay-overlapping reviews to a main-only checkout | open | 2026-10-03 | Code refs still hold (we:scripts/operations/review-job.mjs, `DAEMON_CLONE_SEED` in we:scripts/lib/daemon-clone-registry.mjs, `readOverlayState`); its Proof plan lacks an R228 prototype-load step. Minor. | independent |
| #5452 event-driven daemons epic (E1–E7) | open | — | Accurate; E2 ("separate executor processes per role") is the same direction as plugins. Slices #5501/#4283/#5454 all open. | composes |
| #5785 one event stream + state manager | open (decision) | 2026-10-10 | Accurate; orthogonal (state, not switching). | composes |
| #5036 blue-green daemons | open | — | Unprepared; overlaps quick-mode #6084 (R228) — re-scope when prepared. | n/a |

## Design

**One descriptor + one switch per daemon; no file moves while a daemon has overlays.**

1. **Descriptor + resolver, new we:scripts/lib/daemon-plugins.mjs.** A frozen `DAEMON_PLUGINS` map, one entry
   per daemon: `{ name, entry, label, clone, settingKey }`. Slice 1 registers `verify` only (`entry:
   'we:skills-src/conveyor/verify-daemon.mjs'`, `label: 'com.we.verify-daemon'`, `clone: 'wev-control'`). It sits
   beside we:skills-src/conveyor/daemon-manifest.mjs (which stays the closed allowlist for pass-daemon) and does
   not touch it — that file carries an overlay on `wev-merge-daemon`. Export
   `resolvePluginEnabled(name, { env, readFile, overridePath, last })` → `{ enabled, source, invalid, errors }`.
   It calls `cascadePolicy('daemonPlugins.<name>', toolBlock, { standard: { enabled: true }, envValues, valid })`
   (we:scripts/lib/policy-cascade.mjs:189) **once per plugin**, so each plugin's leaf is its own policy and an env
   value for one plugin can never replace the whole `daemonPlugins` block (`resolveCascade` replaces a top-level
   key wholesale, :112-117). `valid` is `{ enabled: (v) => typeof v === 'boolean' }`. Layers: standard `true` →
   platform preference → tool file we:scripts/settings/daemon-plugins.json → env. The **env layer** has two
   sources, highest first: the process env `WE_DAEMON_PLUGIN_<NAME>` (`0|1|off|on`, parsed to a boolean), then a
   runtime **operator override file** `<RUNNER_LOCK_ROOT>/daemon-plugins.override`
   (`~/.claude/conveyor-runner-locks/`, we:skills-src/conveyor/runner-lock.mjs:63), written only by
   `node we:scripts/lib/daemon-plugins.mjs set <name> on|off --reason=<text>` (atomic write, records actor + ET time +
   reason, optional `--ttl=<hours>` after which the entry is ignored and the daemon logs that it expired). `set`
   holds `withFileLock(<override path>.lock, …, { staleMs: 30000 })` (we:scripts/lib/atomic-json-file.mjs:157),
   whose stale-lock takeover checks the holder pid, so a crashed `set` cannot wedge the lever; readers (daemon,
   requester) never lock — `writeJsonAtomic` (:64) makes a lock-free read safe. The override file follows the precedent of the existing drain marker (`VERIFY_DAEMON_DRAIN_FILE`,
   we:skills-src/conveyor/verify-daemon.mjs:85) and the build daemon's `.kill` file: it lives outside every clone, so self-sync, overlay
   re-applies and rebuilds never reset it, and it is the fast emergency lever (no PR, no plist edit, no restart).
   The tool file is the durable, reviewed default. Under test (`isUnderTest()`) the resolver reads no disk unless
   paths are injected, like `defaultIsDraining` (:88).
2. **Settings file, new we:scripts/settings/daemon-plugins.json:**
   `{ "daemonPlugins": { "recheckMs": 60000, "verify": { "enabled": true } } }`. Setting names:
   `daemonPlugins.<name>.enabled` (boolean) and `daemonPlugins.recheckMs` (number, ≥ 10000; tool layer only).
3. **The verify daemon reads its own switch; "off" reuses the drain path.** In
   we:skills-src/conveyor/verify-daemon.mjs, `main()` (line 589) acquires its lease at line 592 unconditionally.
   Add an exported pure `pluginStep({ enabled, holdsLease, inFlight })` → `'idle' | 'acquire' | 'run' | 'drain' |
   'release'`, and wire `main()` through it:
   - **Seams:** `main()` becomes a thin wrapper over an exported `runLoop(deps)`; `deps` injects the tick, clock,
     resolver, lease acquire/release, dispatch, state-record writer, heartbeat and logger. Each tick the loop calls
     the resolver with `last` set to the previous resolved `enabled` (none on the first call), then `pluginStep`.
     An injectable startup boundary lets tests invoke production `main()` with these dependencies and observe
     its delegation. Cap each sleep at the next resolver deadline, including when the normal tick interval is
     longer than `recheckMs`, so both idle and running loops honor the one-interval reaction guarantee.
   - **Boot while off:** log `plugin verify disabled (<source>)`, hold NO lease, dispatch nothing, re-resolve every
     `recheckMs`. The process stays up, so launchd `KeepAlive` does not crash-loop it.
   - **Off → on:** acquire the lease on the next recheck and enter the normal loop, no process restart.
   - **On → off:** the loop's existing `isDraining` probe (:88, consumed at :383) is OR-ed with "plugin off", so
     dispatch of new gates stops exactly as the drain marker stops it today, while the daemon keeps ticking and
     heartbeating. When the in-flight registry is empty (`in flight 0 (draining)`), release through
     `releaseRunnerLeaseIfOwned` and drop to the idle loop. Detached job-mode gates are never killed; a gate still
     running when the lease is released is re-adopted by the next lease holder through the existing job-store
     registry rebuild (~:380), the same path a restart uses today. "Off" never kills a running gate; the existing
     kill/stop paths keep precedence.
   - **Long-off reminder:** while disabled, the daemon logs `plugin verify disabled for <N>h (<source>)` once per
     hour, so a forgotten `set verify off` stays visible.
   - **State record:** on every transition the daemon writes `<RUNNER_LOCK_ROOT>/verify-daemon.plugin`
     (`{ enabled, source, phase, at, pid }`, atomic write via we:scripts/lib/atomic-json-file.mjs). This is what
     requesters read, so they never re-resolve settings from their own lane clone.
4. **Requesters get a named refusal.** we:scripts/verify-lane.mjs `request` already refuses with exit 3 when no
   verify daemon lease is alive (:572-581). Add, **before** that lease check: when the daemon's state record says
   `enabled: false` (any phase, including `drain` while the lease is still held), refuse at once with exit 3 and
   name it (`verify daemon disabled: daemonPlugins.verify.enabled=false (override, <reason>, <ET time>)`). The
   requester reads the daemon's record, not its own checkout's settings file, because the lane clone and
   `wev-control` hold different copies and environments.
5. **Prototype-loadable (R228).** `wev-control` has never been prototype-loaded (no record in
   `~/workspace/.operations/coordination/prototype-loads.jsonl`) and is missing from `DAEMON_CLONE_SEED`
   (we:scripts/lib/daemon-clone-registry.mjs:63). Add `'wev-control'` to the seed so the overlay CLI treats it as a
   daemon clone (its prune deleted overlays on an unseeded clone once, #4717). `prototype-load` already resolves
   the `verify` clone from the plist `WorkingDirectory` (we:scripts/operations/prototype-load-io.mjs:312).
6. **One daemon at a time.** Each later daemon is its own card: register its descriptor, wire its gate. A daemon's
   code moves into a plugin directory only once its clone has zero live overlays (graduate them first, or in the
   same change). Order (fewest overlays and fewest shared-file overlays first): verify (this card) → build clone split (x71628r) → build (xx6qupe, after #3984 settles) → drain (xthh394) → merge passes (xqr1g9u: add
   `wev-merge-daemon` to the loader settings, graduate or drop the stale 171-file `proto-daemon-resources` overlay first) →
   health-watch (xa4ggq9; after its shared-file overlays land) → fix (xisvn49) → review (x88kfkb; first split its 12 jobs onto their own
   clones). Each later plugin needs its own clone first (Risk and sequencing ruling).

**Rollback.** To intentionally re-enable verify while retaining plugin support, use
`node we:scripts/lib/daemon-plugins.mjs set verify on`; absent a higher-priority process-env OFF, it takes
effect at the next recheck, no restart.
Deleting the override only falls back to the remaining cascade layers; it does not guarantee ON. A durable
tool-layer change sets `daemonPlugins.verify.enabled` back to `true` by PR (higher layers still take precedence).
Code rollback removes switch support, so the restored implementation would acquire its lease even if the
effective setting is OFF. Before removing the prototype overlay or reverting the PR, record the effective
setting and provenance. If disabled (including mid-drain), keep the plugin implementation running until its
real in-flight registry reaches zero, the persisted job store confirms no running gates, and its lease is
released; an empty idle-loop counter after a restart is insufficient. Never terminate detached gates to hurry this.
Then persistently disable `com.we.verify-daemon` in its installed launchd domain (`launchctl disable <domain>/com.we.verify-daemon`),
boot out only that job, and confirm the disabled flag, stopped process and absent lease before restoring code.
Suppress any enable/bootstrap/restart hook in the overlay-removal or revert procedure; code restoration must
leave this job disabled and unloaded, including across login or reboot. If draining, disabling or stopping
cannot be confirmed, abort the code rollback. Preserve the override after rollback. Explicit operator
re-enable must restore the launchd enabled flag before bootstrapping the old daemon. If the plugin was
enabled, an ordinary daemon restart may resume dispatch. Code before merge:
`node we:scripts/daemon-overlay.mjs remove --clone=$HOME/workspace/wev-control --ref=<ref>` restores main;
after merge: revert the PR. Both paths require the disabled-state procedure above.

## Risk and sequencing ruling: shared clones couple adoption (added 2026-11-01, R357; not a fork)

Standing test result: this is **not a fork**. The three orderings differ only in when the clone-split story lands, which is
prioritization, and clone assignment is per-daemon configuration that the statute already shapes
(we:docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle clauses 3 and 5). It is written down as an explicit risk with
a default order, and the one lever the operator may pull is named.

**Risk.** A plugin switch stops *dispatch*; it does not stop *adoption*. Every overlay loaded onto a clone goes live in every job on
it. A rebuild conflict does not stop the jobs (clause 5(c): an unresolved conflict drops that overlay for the pass with an alert,
and 5(d) removes an overlay on a crash loop), but 2026-11-01 showed the failure that does: squash-landed overlays never matched
`main`, so the review clone's rebuild stayed blocked for 5 hours (fixed in #6184, hand move R351; the 10-29 review-daemon freeze was
the same family). So one plugin per clone may be the real win; a switch alone is not independence.

Ground truth today: verify and build share `wev-control` (3 overlays, none on the plugin files, a snapshot: the overlay set churns,
`lane/r332-route-kinds-3-m1` was merged then dropped); the review daemon's 12 jobs share one clone (8 overlays); drain, health-watch,
fix and merge each have one daemon per clone.

**Default order (kept, with the clone rule added).**
1. Verify first on `wev-control`, as designed. Its sibling job is the build daemon on `--max-concurrent=0`, so the exposure is one
   extra idle job for one merge window; verify is the only slice whose files no overlay touches.
2. Each later plugin needs its own clone first: story x71628r (build off `wev-control`) blocks the build plugin xx6qupe; the review
   plugin x88kfkb starts by splitting its 12 jobs onto their own clones.
3. The default order stands and does not gate 7504; moving x71628r ahead of 7504 is an optional reorder that changes no card text.

**Statute drift found while checking.** Clause 5(e) says the drain daemon and `merge-orphan-sweep` "stay `main`-only and never share a
clone that runs overlays". Today `we-drain-daemon/code` carries 2 overlays and `wev-merge-daemon` carries 1. Their plugin stories
(xthh394, xqr1g9u) must either clear those overlays or take the 5(e) amendment to the operator first. It is not slice 1's problem.

Skeptic: classification REFUTED (it is sequencing, not a fork: dissolved to this ruling); merit SURVIVES (verify first; the card overstated "rebuild conflict stops both jobs": clause 5(c)/(d) drop the overlay, the real failure was #6184: corrected); statute-overlap found clause 5(e) drift (assigned to xthh394, xqr1g9u); citations SURVIVE.
Screen: clear (fresh-context reviewer; one optional wording fix applied).

Real-life occurrences: the 2026-11-01 review-clone deadlock (#6184, R351); the 2026-10-29 review-daemon overlay-conflict freeze.

## MVP

Musts:
- `we:scripts/lib/daemon-plugins.mjs`: the `verify` descriptor, `resolvePluginEnabled` (per-plugin
  `cascadePolicy`), the override file reader, and the `set` CLI.
- `we:scripts/settings/daemon-plugins.json` with `daemonPlugins.verify.enabled` and `daemonPlugins.recheckMs`.
- An exported `runLoop(deps)` in `we:skills-src/conveyor/verify-daemon.mjs` that `main()` delegates to, with the tick, clock, resolver,
  lease, dispatch, state-record writer, heartbeat and logger injected (so the lifecycle wiring is testable), passing
  `last` (the prior resolved `enabled`) on every resolver call after boot.
- `pluginStep` + its wiring in `we:skills-src/conveyor/verify-daemon.mjs` `main()`: idle-when-off boot, off→on acquire, on→off via the
  drain path then release, and the state record.
- The named refusal in `we:scripts/verify-lane.mjs request`, read from the state record.
- `'wev-control'` in `DAEMON_CLONE_SEED`.
- Prototype-load onto `wev-control` and the live proof below before merge.

Out (Follow-ups): other daemons, file moves into plugin dirs, a per-plugin clone for the review jobs,
health-watch display of "off by setting", the `com.we.control` label drift.

## Test plan

we:scripts/lib/__tests__/daemon-plugins.test.mjs (RED for all: module does not exist):
- **`plugin resolve: default on`** — no files, no env → `enabled: true, source: 'standard'`. Capability — Red today.
- **`plugin resolve: tool off`** — fixture tool `verify.enabled=false` → `false, source: 'tool'`. Capability — Red today.
- **`plugin resolve: env beats tool`** — `WE_DAEMON_PLUGIN_VERIFY=1` over tool `false` → `true, 'env'`; tool
  `recheckMs` still resolves from the tool layer. Capability — Red today.
- **`plugin resolve: sibling settings survive an env override`** — register a fixture sibling alongside verify,
  with explicit tool values `verify.enabled=false` and `sibling.enabled=true`. Set only
  `WE_DAEMON_PLUGIN_VERIFY=1` and assert verify becomes `true, 'env'` while sibling stays `true, 'tool'`.
  Reverse the explicit sibling values and use `WE_DAEMON_PLUGIN_VERIFY=0`: verify becomes `false, 'env'`
  while sibling stays `false, 'tool'`. Both rows must retain the sibling's explicit value and provenance;
  replacing the whole `daemonPlugins` block with the env layer must fail. Capability — Red today.
- **`plugin resolve: platform preference overrides standard and loses to tool`** — injected platform
  `verify.enabled=false` beats standard `true`, with source `platform`; adding tool `verify.enabled=true`
  beats the platform, with source `tool`. Capability — Red today.
- **`plugin resolve: test mode reads only injected paths`** — under `isUnderTest()`, spy on filesystem reads:
  no injected paths means zero reads of real tool, platform-preference or override files. With fixture paths
  injected, only those paths may be read and their values must resolve; assert zero uninjected reads in both
  cases, including when an injected read fails. Capability — Red today.
- **`plugin settings: recheckMs enforces the minimum`** — table rows for zero, negative, below-minimum positive,
  nonnumeric, non-finite and missing values, plus the exact minimum and a larger valid value. Assert invalid
  inputs fall back to the 60,000 ms standard and report invalid values, never scheduling a recheck below the
  documented 10,000 ms minimum. Missing values use that default without an invalid diagnostic;
  valid boundary values are retained. Capability — Red today.
- **`plugin resolve: override beats tool, process env beats override`.** Capability — Red today.
- **`plugin resolve: invalid never wins`** — tool `"enabled": "nope"` → stays `true`, `invalid` names the leaf. Capability — Red today.
- **`plugin resolve: invalid keeps a previously disabled state`** (the `"false"` string row below is the tool layer;
  env values `0|1|on|off` are parsed to a boolean before the `valid` check, a settings leaf must already be a boolean) — the fail-closed half of the case above: with
  `last: false` (the daemon is running disabled), each invalid input leaves `enabled: false`, never flips it on, and
  `invalid` names the leaf. One row per layer, so no layer can reset a disabled plugin: tool `"enabled": "nope"`,
  tool `"enabled": null`, env `WE_DAEMON_PLUGIN_VERIFY=maybe`, and an override entry `{ enabled: "yes" }`. A row
  with `last: true` and an invalid `false`-looking value (`"false"` string) stays `true`. At boot (no `last`) the
  same invalid inputs resolve to the standard `true`, named in `errors`. Capability — Red today.
- **`plugin resolve: read error keeps last known`** — `readFile` throws with `last: false` → stays `false`, error
  named; with no `last` (boot) → `true`. Capability — Red today.
- **`plugin resolve: unknown name throws`.** Capability — Red today.
- **`plugin set: atomic write records actor, time, reason`** and refuses a `--reason` value starting with `--`. Capability — Red today.
- **`plugin set: stale lock from a dead pid is taken over`** — a fixture lock older than `staleMs` with a dead pid
  does not block `set`. Capability — Red today.
- **`plugin resolve: expired override is ignored`** — `--ttl` in the past → falls back to the tool layer. Capability — Red today.

we:skills-src/conveyor/__tests__/verify-daemon.test.mjs (RED: `pluginStep` is not exported; today `main()` has no
off path at all):
- **`plugin step: off at boot is idle, no lease`.** Capability — Red today.
- **`plugin step: off to on acquires`.** Capability — Red today.
- **`plugin step: on to off drains while in flight, releases at zero`.** Capability — Red today.
- **`plugin drain: plugin-off stops new dispatch like the drain marker`** — the dispatch fake is never called while
  `inFlight > 0` and the plugin is off. Capability — Red today.
- **`plugin drain: running gates are never terminated`** — required integration test: start a controlled detached
  job-mode gate against a temporary job store, then disable verify through the production loop. Use the real
  in-flight registry and job lifecycle (do not supply `inFlight` counts). Assert the gate remains alive with the
  same job ID and PID, no gate kill/stop/signal path is called, new dispatch stops, and heartbeats continue while
  draining. Hold the gate open across multiple ticks: the lease must stay owned until the gate completes normally
  and the registry reaches zero; only then may the loop release it and become idle. Re-enable verify and assert
  the completed job is not dispatched again. Capability — Red today: no plugin-off drain integration exists.
- **`plugin restart: adopts persisted gates before drain decisions`** — required integration test: persist a
  controlled detached gate as running, disable verify mid-flight, then restart only the daemon loop while the
  gate remains alive and the setting remains off. The successor boots idle with no lease and no dispatch;
  assert no gate kill/stop/signal path is called and the same gate survives both the disable and restart.
  Re-enable while it is still running: the next lease holder must use the production job-store registry rebuild,
  not a fake `inFlight` count, and retain the original job ID and PID before any dispatch or drain-empty decision.
  Disable again with the gate held open and assert the rebuilt registry keeps the daemon draining and its lease
  owned until normal gate completion. Assert no duplicate dispatch across the restart or lease handoff, and
  exactly one completion before release to idle. The test must fail if registry adoption is skipped or moved
  after dispatch/drain decisions. Capability — Red today: no plugin-aware restart/adoption integration exists.
- **`plugin lifecycle: main() wiring`** — invoke production `main()` through an injectable startup boundary,
  with process/plist IO replaced by fixtures; do not call `runLoop` directly as the test entry point. Spy on
  delegation to the exported `runLoop(deps)` using a wrapper around the actual loop at the startup boundary,
  and assert it occurs exactly once with the injected dependencies; the spy must execute the actual loop.
  Removing that delegation or restoring main's unconditional lease path must fail the test. Drive the real
  loop through the injected seams (`deps` carries
  the tick, clock, `resolvePluginEnabled`, lease acquire/release, dispatch, state-record writer, heartbeat and logger,
  all fakes in the test) through one scripted sequence and assert the calls in order:
  1. resolver returns off at boot → the first resolver call carries **no `last`**; logs `plugin verify disabled (override)`,
     lease acquire fake **never called**, dispatch fake never called, state record `{ enabled: false, phase: 'idle' }`,
     loop still running (does not exit, so launchd `KeepAlive` has nothing to restart);
  2. resolver flips on → lease acquired exactly once, dispatch is called, state record `{ enabled: true, phase: 'run' }`;
  3. resolver flips off with `inFlight = 2` → dispatch not called again, lease **not** released, state record
     `phase: 'drain'` (`enabled: false`), heartbeat still written;
  4. `inFlight` reaches 0 → `releaseRunnerLeaseIfOwned` called once with this daemon's owner, state record
     `phase: 'idle'`, loop keeps ticking;
  5. a clock advance past one hour while off → the `plugin verify disabled for <N>h` reminder is logged once, not per tick;
  6. resolver flips on again → lease acquired a second time (after the release in step 4), dispatch resumes, state
     record `phase: 'run'`;
  7. resolver returns a read error (`{ enabled: <last>, errors: ['read failed …'] }`, which is what
     `resolvePluginEnabled` does on a read error — it does not throw) while running on → state record and lease
     unchanged, no dispatch pause, error logged; the same read error while off → stays idle and keeps the lease released;
  8. across steps 2–7 every resolver call carries `last` equal to the previous resolved `enabled`, so the fail-closed
     rule (invalid or unreadable keeps the last known value) holds end to end in the loop, not only in the resolver.
  Capability — Red today: no off path, no `runLoop`, and nothing consults `pluginStep`.
- **`plugin lifecycle: toggles apply within one recheck interval`** — invoke production `main()` with a fake
  clock, initially off, and record resolver-call timestamps. For both off→on and on→off, toggle immediately
  after a resolve, advance to just before the next deadline and then to the deadline: the next resolver call
  and state transition must occur no later than `lastResolvedAt + recheckMs`. Assert no earlier busy polling,
  no dispatch while off, acquisition when enabled, and immediate dispatch suppression on disable even when
  real in-flight work delays lease release. Exercise default and minimum intervals with ticks longer than
  `recheckMs`, so an ordinary loop sleep cannot defer the recheck. Capability — Red today.
- **`plugin rollback: disabled daemon does not resume unexpectedly`** — required rollback integration test,
  parameterized over prototype-overlay removal and post-merge code revert, starting from an explicitly OFF
  effective setting (idle, mid-drain, and restarted idle with a persisted running gate). Exercise the documented procedure through injectable service
  and code-restoration boundaries. A controlled detached gate must finish normally before service bootout;
  assert persistent launchd disable, bootout, disabled-flag/stopped-process/absent-lease checks precede code
  restoration, the override is preserved, and the old implementation is never started automatically
  (including by code-restoration hooks). Simulate KeepAlive, restart and a fresh login/bootstrap with the
  persisted launchd disabled flag; assert no lease acquisition or dispatch until explicit operator re-enable.
  Failed drain/disable/stop confirmation must prevent code restoration. Capability — Red today.

we:scripts/__tests__/verify-lane.test.mjs:
- **`request refusal names a disabled plugin`** — a fixture state record with `enabled: false` → exit 3 and the
  text names `daemonPlugins.verify.enabled`. RED: today the text says only that no daemon is alive. Capability — Red today.
- **`request refusal names a disabled plugin while draining`** — record `{ enabled: false, phase: 'drain' }` with a
  live lease → still refused at once. RED: today a live lease always accepts (:572-581). Capability — Red today.
- **`request refusal names a disabled plugin while idle`** — record `{ phase: 'idle', pid: <live pid> }` and no
  lease → named refusal, not the generic text. Capability — Red today.
- **`request ignores a stale or unreadable plugin record`** — the fallbacks Edge 4 and 6 promise, so a stale
  `enabled: false` record can never block a live, re-enabled daemon. Rows: (a) record `{ enabled: false, phase: 'idle',
  pid: <dead pid> }` and a live lease → treated as stale, request accepted via the lease check; (b) record
  `{ enabled: false, phase: 'drain', pid: <pid not matching the live lease owner> }` → stale, accepted via the lease
  check; (c) unparseable record file and no lease → exit 3 with the generic "no daemon alive" text, not a named
  refusal and not a fake green; (d) unreadable record with a live lease → accepted. Capability — Red today.

we:scripts/lib/__tests__/daemon-clone-registry-fix-clone.test.mjs:
- **seed includes `wev-control`.** Capability — Red today: absent at :63.
- **`plugin override: survives a clone reset`** — like `VERIFY_DAEMON_DRAIN_FILE` (we:skills-src/conveyor/verify-daemon.mjs:85) and the build daemon's `.kill` file, the override path resolves under `RUNNER_LOCK_ROOT`, outside the injected clone root; a fixture `git reset --hard` of the clone leaves the override read unchanged. Capability — Red today (no override exists).

## Proof plan

On the prototype, before merge (R228). Preconditions for steps 3–4: `verify-daemon.drain` absent, the daemon log
shows `in flight 0`, and the orchestrator is told the window (≤ 2 × `recheckMs`, about 2 min) before it starts.
1. `prototype-load` the build branch onto `verify` (clone `wev-control`); capture the adoption record.
2. Before: `verify-lane request` on a throwaway lane goes green through the daemon (daemon log line).
3. `node we:scripts/lib/daemon-plugins.mjs set verify off --reason="R238 proof"`. Within `recheckMs` the daemon log
   shows `plugin verify disabled (override)`, the `<conveyor:verify-daemon-lease>` lease file under
   `~/.claude/conveyor-runner-locks/` is gone, and `verify-lane request` exits 3 naming the setting.
4. `node we:scripts/lib/daemon-plugins.mjs set verify on` (this is also the rollback). The lease reappears and the
   same request goes green, with the same PID in `launchctl list com.we.verify-daemon` before and after.
5. Record the before/after lines on the PR; merge as soon as it passes, then drop the overlay.

## Edge cases this change must handle

1. **Untrusted text** — the env value and the settings leaf are parsed against a closed set (`true/false`,
   `0|1|on|off`). The `--reason` text is folded (`foldUntrusted`, we:scripts/lib/jury-core.mjs), capped at 200
   chars, and a value starting with `--` is refused; it is only ever written as JSON, never into argv, a path or a
   regex.
2. **Truncated reads** — n/a: no `gh`/`git` reads are added; settings, override and state files are small JSON
   read whole with `readFileSync`.
3. **Shared state files** — the override file and the state record are written with `writeJsonAtomic`
   (we:scripts/lib/atomic-json-file.mjs); the override `set` takes `withFileLock` with a 30 s pid-checked stale takeover; readers never lock. The lease is released only through
   `releaseRunnerLeaseIfOwned` (owner check), never a raw delete.
4. **Fail closed** — for a gate daemon the safe side is "do not change state on a bad read": an unreadable or
   invalid setting keeps the last known value while running, and the standard default ON only at boot. It is
   named in the log. The requester still fails closed: no live lease → `request` refuses (exit 3), never a fake
   green; an unreadable state record falls back to today's "no daemon alive" text.
5. **Identity scoping** — the plugin name is a fixed key in the frozen descriptor map; an unknown name throws. The
   lease key stays `<conveyor:verify-daemon-lease>`; the state record is per plugin name.
6. **State over time** — re-resolved every `recheckMs`; flips take effect within one interval. A restart while off
   boots straight into idle. A restart mid-drain re-adopts in-flight gates through the existing job-store rebuild
   (~:380) before deciding. The state record carries `at` + `pid`. In `phase: 'idle'` (no lease), a requester checks
   that pid is alive directly; in other phases it must match the live lease owner. A record failing its check is
   stale, and the requester falls back to the lease check.
7. **Who wrote it** — the tool file is a tracked repo file, changed only by a PR; the process env is the plist the
   operator installs; the override file is written only by the `set` CLI, which stamps actor and time, and lives
   under the operator's home, outside every clone. No label, comment or remote text can toggle a plugin.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/lib/__tests__/daemon-plugins.test.mjs` fails before (module
  missing) and passes after.
- [A2] **Executable** — `npx vitest run we:skills-src/conveyor/__tests__/verify-daemon.test.mjs -t "plugin (step|drain|restart|lifecycle|rollback)"`
  runs every named `plugin step:`, `plugin drain:`, `plugin restart:`, `plugin lifecycle:` and `plugin rollback:`
  test above and all pass after. The lifecycle test must fail when production `main()` delegation is removed;
  the restart test must fail when persisted-gate adoption is skipped or deferred until after drain/dispatch
  decisions. The rollback test covers explicitly disabled idle and mid-drain states on both code rollback paths.
- [A1b] **Executable** — `npx vitest run we:scripts/lib/__tests__/daemon-plugins.test.mjs -t "invalid keeps a previously disabled state"`
  fails before (module missing) and passes after.
- [A3] **Executable** — `npx vitest run we:scripts/__tests__/verify-lane.test.mjs -t "plugin"` runs the three
  `request refusal names a disabled plugin` tests and `request ignores a stale or unreadable plugin record`; fails before and passes after.
- [A4] **Executable** — the extended seed test in we:scripts/lib/__tests__/daemon-clone-registry-fix-clone.test.mjs
  fails before (`wev-control` absent) and passes after.
- [A5] **Observable** — the Proof plan's steps 3–4 recorded on the PR: disabled log line, lease gone, named
  refusal, then lease back with the same PID.

## Non-goals

- [N1] No change to process topology, launchd plists or the supervisor launcher (#3874 stands).
- [N2] No change to `we:skills-src/conveyor/daemon-manifest.mjs` or `we:skills-src/conveyor/pass-daemon.mjs` (both carry live overlays elsewhere).
- [N3] No other daemon in this slice.

## Follow-ups

- Plugin two: build-dispatch daemon descriptor + switch (replaces `--max-concurrent=0` as the off lever), once
  #3984 is no longer active.
- Plugins for drain, merge passes, health-watch, fix, then review — one card each, in the Design §6 order, each
  graduating (or dropping) its clone's overlays in the same change.
- Give each job now sharing `wev-review-daemon` its own clone, so one plugin's overlay stops loading into 11 others.
- Move each daemon's code into a plugin directory once its clone has zero overlays.
- health-watch shows "off by setting" for a disabled plugin instead of a liveness question.
- Fix the `com.we.control` label in we:scripts/settings/prototype-load.json (no such plist is installed).
- Re-prepare #4086 Fork 3 against R228; resolve #3866 (its follow-on is #3881).
