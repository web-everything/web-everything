---
bornAs: xaqg28x
kind: story
size: 3
priority: high
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-clone-registry.mjs", "we:scripts/backlog/guarded-write.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells/control-clone-dirty.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/__tests__/guard-lane.test.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-07"
preparedAgainstSha: "45d426ce98ca541f7a2ed18ef1b9bdfac26fa506"
tags: []
---

# Write guard must cover the control clone ~/workspace/wev-control like other daemon clones

Evidence (2026-09-28): (a) a worker's file-item wrote a card into wev-control and no guard stopped it; (b) the orchestrator ran we:scripts/review-set-label.mjs with --to=clear-human for PR #2831 and #2854 with cwd in wev-control, and the approval-prevention filer (we:scripts/review-set-label.mjs#fileApprovalPreventionCard) wrote 4314 (staged A) and 4363 (untracked) there; (c) the dirty clone made the build daemon's self-sync refuse to rebuild ("rebuild did not move the clone (dirty)"), so the builder ran stale code (without the #2857 unfreeze fix) until a labelled emergency cleanup at ~4:05 PM ET on 2026-09-28. we:scripts/lib/daemon-clone-registry.mjs's DAEMON_CLONE_SEED omits wev-control entirely, so we:scripts/guard-lane.mjs and we:scripts/guard-bash.mjs never recognize it as a daemon/control clone and never block writes into it. Fix: register wev-control with the daemon-clone write guard, make approval/prevention filers (we:scripts/review-set-label.mjs#fileApprovalPreventionCard) refuse to write into any daemon or control clone, and add a health smell (alongside we:scripts/conveyor/health-smells/clone-stale.mjs) for a dirty control clone.

## Premise check (2026-09-30, against main 45d426ce9, re-verified 2026-10-07)

Still valid, but two of the card's three halves are narrower than written:

- **Registry gap is real.** `DAEMON_CLONE_SEED` (`we:scripts/lib/daemon-clone-registry.mjs:60`) omits `wev-control`.
- **Guards need no edit.** `we:scripts/guard-lane.mjs:167` (`isDaemonCloneRealpath`) and `we:scripts/guard-bash.mjs` (`daemonCloneWriteReason`, imports the same registry) already consume the registry, so seeding it protects both. The original scope listing both files is corrected above.
- **`fileApprovalPreventionCard` no longer writes into the cwd checkout.** #4317 already made it a thin wrapper over `spawnPreventionLandingJob` (`we:scripts/lib/prevention-landing-job.mjs`), which lands the card from an acquired lane. `we:scripts/review-set-label.mjs` is therefore out of scope; the remaining hole is any OTHER direct `file-item` write sink run with cwd in a control/daemon clone (the 4314/4363 cards were written by the pre-#4317 path).
- **`untracked-backlog-card` (`we:scripts/conveyor/health-smells/untracked-backlog-card.mjs`) already iterates `daemonCloneRoots`**, so seeding `wev-control` makes it cover untracked hash-id cards there for free. It does NOT cover a STAGED card (4314 was staged `A`) or modified tracked files — the dirty-rebuild failure mode — hence a dedicated smell. Smells are auto-discovered from disk, so `we:scripts/conveyor/health-smells/index.mjs` needs no edit.

## Design

1. **Registry** — add `CONTROL_CLONE_DIRNAME` (`we:scripts/lib/automation-home.mjs:43`, already exported) to the clone list in `daemonCloneRoots` (`we:scripts/lib/daemon-clone-registry.mjs`) as its own control-clone entry. `daemonCloneRoots(workspace, {env})` already holds the workspace dir, and `controlClonePath`'s `root` param is a CLONE root (`workspaceOf` takes its dirname, `we:scripts/lib/automation-home.mjs:53`), so do not pass the workspace as `root`: use `env.WE_CONTROL_CLONE` when set, else `path.join(workspace, CONTROL_CLONE_DIRNAME)`. Tests inject `env` (no `WE_CONTROL_CLONE`) so the developer's real env never leaks in. Kept as a parallel seed (not folded into `DAEMON_CLONE_SEED`) because the owner differs — control clone vs. daemon — while the guards' semantics are identical; `daemonCloneRoots` returns the union. Fail-open shape unchanged (seed stands alone; overlay scan stays additive).
2. **Write sink refusal** — the single card-write chokepoint is `writeBacklogMd` in `we:scripts/backlog/guarded-write.mjs:57` (every card writer — `we:scripts/operations/file-item-io.mjs` via `we:scripts/operations/scaffold-io.mjs:65-74`, `we:scripts/backlog.mjs` verbs — routes through it). It already calls `laneGuardDecision(resolveReal(abs), root)` (line 57) WITHOUT the `daemonCloneRoots` option, which `we:scripts/guard-lane.mjs:155` defaults to `[]`, so the daemon-clone arm at `we:scripts/guard-lane.mjs:167` never fires for card writes. Fix: pass `daemonCloneRoots: daemonCloneRoots(workspaceRootOf(root))` (try/catch → `[]`, matching `we:scripts/guard-lane.mjs:257`; a corrupt overlay dir needs no catch because `daemonCloneRoots` already degrades to seed-only, which now includes wev-control). The refusal is keyed on the TARGET path's realpath, not cwd or script location, so it covers `wev-control` and every daemon clone uniformly. Adjust the thrown message to name a daemon/control clone (the existing text says "PRIMARY checkout" and the guard-lane text points at `we:scripts/daemon-overlay.mjs`, wrong advice for a control clone). No new refusal shape is needed — `writeBacklogMd` already throws.
3. **Smell** — new `we:scripts/conveyor/health-smells/control-clone-dirty.mjs` beside `we:scripts/conveyor/health-smells/clone-stale.mjs`: probe `controlCloneDirty` in `we:scripts/conveyor/health-watch.mjs` runs `git -C <controlClonePath> status --porcelain --untracked-files=no` (tracked + staged changes only — the exact view the rebuild's own dirty check uses, so harmless untracked sidecars never false-positive; untracked cards stay owned by `untracked-backlog-card`) with the same `attempt()`/timeout wrapper as `probeUntrackedBacklogCards` (`probeUntrackedBacklogCards`, `we:scripts/conveyor/health-watch.mjs:486`, wired at `:1024`). The probe is exported as `probeControlCloneDirty({roots, exec, timeoutMs})`, mirroring that signature, so tests inject `roots`/`exec`. `evaluate` returns one subject per control clone, `breach` when the porcelain is non-empty, `measure` carrying count + first paths; `openAfter: 1`, `closeAfter: 1`, `severity: 'high'`, `action: 'investigate'`. A missing clone or failed `git` yields no subject (fail-open, nothing to report).

## MVP (Musts only)

- Seed `wev-control` into the registry (guards protected).
- `writeBacklogMd` refuses a target inside a daemon/control clone (registry passed to `laneGuardDecision`).
- `control-clone-dirty` smell + its probe wiring.
- Reword the `writeBacklogMd` refusal message (it says "PRIMARY checkout") to name a daemon/control clone.
- Tests 1–4 below, plus 3b (symlink spelling) and 3c (corrupt overlay dir still refuses).

OUT of scope: see Follow-ups.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no LLM/PR/comment text reaches a shell, path or regex; the only input is a target path, compared by realpath.
2. **Truncated reads** — the new probe shells `git status --porcelain`; it uses the same runner as `probeUntrackedBacklogCards` with an explicit `timeoutMs` (the build verifies the runner's buffer limit and raises it if porcelain output can exceed it), and a failed or timed-out git is a non-subject (see 4), never "clean".
3. **Shared state files** — n/a: read-only probe and registry; no state file is written.
4. **Fail closed** — a corrupt overlay dir degrades to seed-only (which holds wev-control), so the write is still refused (Test 3c); only a thrown registry error yields `[]` (same as `we:scripts/guard-lane.mjs:257`). A guard refusal throws, never silently skips. The smell reports a probe error as a probe failure, not as "clean".
5. **Identity scoping** — match on realpath of the target (symlink and `..` spellings resolve), and honor a `WE_CONTROL_CLONE` override. Test 3b: a symlink into wev-control is refused.
6. **State over time** — smell uses `openAfter:1`, `closeAfter:1`, so it closes once clean; no cross-tick repeat state to suppress. A restart mid-dirty reopens from the probe, not from memory.
7. **Who wrote it** — n/a: no comment, label or job name grants trust here.

## Follow-ups

- Sweep for card writers that bypass `writeBacklogMd` (e.g. the unguarded writer in `we:scripts/backlog/guarded-write.mjs`, used by the drain's on-land splice) and decide whether they need the same refusal.
- Auto-remediation for a dirty control clone (salvage + reset) — the smell only reports; the operator's rule is that failures become daemon improvements, so a self-heal pass is the natural next item.
- Extending the existing `untracked-backlog-card` probe to staged (`A`) cards instead of a second smell, if the two smells prove redundant in practice.

## Risks

- `we:scripts/lib/daemon-clone-registry.mjs`'s `DAEMON_CLONE_SEED` is a hand-maintained list of sibling
  directory NAMES (`wev-review-daemon`, `wev-merge-daemon`, `wev-health-watch`, `wev-host-sampler`,
  `plateau-drain-daemon`, the drain's `.lanes/we-drain-daemon/lane-1`); adding `wev-control` there is
  mechanical. (The approval-prevention filer needs no change after #4317; the write-sink refusal lives in
  `writeBacklogMd`, see Design §2. A clone absent from the registry stays unguarded until it is seeded or takes
  an overlay: a known residual, not in this MVP.)
- Must not regress the seed+derived shape's fail-open behavior (a missing/corrupt overlay-state file degrades
  to seed-only, never throws) — the new health smell must follow the same fail-open convention as
  `we:scripts/conveyor/health-smells/clone-stale.mjs`.
- `wev-control` is a human-operated control clone, not a daemon's dedicated checkout — the fix should register
  it as its own recognized kind (or reuse the existing daemon-clone kind if the guard's semantics are
  identical) rather than conflating "control clone" with "daemon clone" in naming, since the two have
  different owners even though both need the same write protection.

## Test plan (each fails before the change, passes after)

1. A unit test on `we:scripts/lib/daemon-clone-registry.mjs#daemonCloneRoots`/`#isDaemonCloneRealpath`
   asserting a path under `<workspace>/wev-control` resolves as a registered clone.
2. `we:scripts/__tests__/guard-lane.test.mjs` and `we:scripts/__tests__/guard-bash.test.mjs` already cover daemon clones, so add a
   `wev-control` case there that passes `daemonCloneRoots(<fixture workspace>)` (real registry, not a hand-built
   roots list) to `laneGuardDecision`/`daemonCloneWriteReason` — RED today only because the registry omits it.
3. A regression on `writeBacklogMd` (`we:scripts/backlog/guarded-write.mjs`, the REAL writer, not an injected
   `write`) targeting a file inside a fixture `<workspace>/wev-control` (tmp workspace): asserts it throws and
   writes no file; RED today because `laneGuardDecision` is called without the registry. Pass
   `{root: <tmp workspace>/<repo>}` so `workspaceRootOf(root)` resolves to the tmp workspace, not the real one.
   Companion: a target in an ordinary lane clone still writes. 3b: a symlink into the fixture wev-control is
   refused. 3c: with a corrupt file in the (injected) overlay dir the write is still refused.
4. A unit test for the new smell (alongside `we:scripts/conveyor/health-smells/clone-stale.mjs`; discovered
   automatically from disk) asserting it opens an episode for a fixture control clone with a modified/staged
   tracked file, does NOT open for an untracked-only clone, and reports `breach:false` once clean (`evaluate` is
   pure; the close itself is `stepEpisodes` in `health-watch-core`, driven in the test for the open→close path).

## Tasks

1. Add `wev-control` to `we:scripts/lib/daemon-clone-registry.mjs` as a parallel control-clone entry unioned
   into `daemonCloneRoots` (Design §1), distinct from `DAEMON_CLONE_SEED`.
2. Make `writeBacklogMd` in `we:scripts/backlog/guarded-write.mjs` pass the daemon-clone registry to
   `laneGuardDecision` so every card write into a daemon or control clone is refused at the source — reusing the
   existing guard rather than re-deriving it (see Design §2; `we:scripts/review-set-label.mjs` needs no change after #4317).
3. Add a health smell, alongside `we:scripts/conveyor/health-smells/clone-stale.mjs`, that fires on a dirty
   `wev-control` (modified or staged tracked files; untracked stays with `untracked-backlog-card`) so the build daemon's stale-rebuild failure mode
   (`we:backlog/4317-approval-time-prevention-cards-are-written-into-the-daemon-c.md`'s "rebuild did not move
   the clone (dirty)") is caught before it silently runs stale code. Smells are auto-discovered from disk, so no
   `we:scripts/conveyor/health-smells/index.mjs` edit; wire the `controlCloneDirty` probe in `we:scripts/conveyor/health-watch.mjs`.

## Proof plan (live, before/after)

- BEFORE: Test plan #1–#3 fail (a write into `wev-control` succeeds unguarded, exactly as it did on
  2026-09-28 for both `4314`/#4314 and `4363`); Test plan #4's smell fixture reports no episode for a
  dirty control clone.
- AFTER (live, no clone surgery): from the lane, run `node -e` against the real `daemonCloneRoots(~/workspace)`
  showing `wev-control` now listed (before: absent), and show `laneGuardDecision(<backlog card path inside the real wev-control clone>, root, {daemonCloneRoots})` returns a refusal. This is a dry decision only: never call the real `writeBacklogMd` against the real control clone (a regression would write there, the very bug). The write-and-throw check runs in the tmp-workspace fixture (Test 3). Then run `probeControlCloneDirty` against the real `wev-control` and report its current
  clean/dirty result, plus the fixture smell red→green via `vitest`.

## Done when

1. **Executable** — the Test plan #1–#4 regressions all fail before this item lands and pass after, runnable
   via `npm run check:standards`/`vitest` with no manual daemon-clone surgery.
