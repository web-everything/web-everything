---
bornAs: xaqg28x
kind: story
size: 3
priority: high
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-clone-registry.mjs", "we:scripts/backlog/guarded-write.mjs", "we:scripts/backlog/__tests__/primary-write-guard.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/health-smells/control-clone-dirty.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/__tests__/guard-lane.test.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
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

1. **Registry** — add a pure, non-throwing `controlCloneRoots(workspace, {env})` export in `we:scripts/lib/daemon-clone-registry.mjs` and union its result into `daemonCloneRoots` (so the guards in `we:scripts/guard-lane.mjs` / `we:scripts/guard-bash.mjs` pick it up). It returns BOTH the default `path.join(workspace, CONTROL_CLONE_DIRNAME)` (`CONTROL_CLONE_DIRNAME`, `we:scripts/lib/automation-home.mjs:43`, already exported) AND `env.WE_CONTROL_CLONE` when set — the override ADDS to the default and never replaces it, so the real `<workspace>/wev-control` stays guarded whatever a worker or daemon env says. (`controlClonePath`'s `root` param is a CLONE root — `workspaceOf` takes its dirname, `we:scripts/lib/automation-home.mjs:53` — so do not pass the workspace as `root`.) An override is ignored (default only) when its realpath is the workspace itself, an ancestor of it, or under `<workspace>/.lanes/`: such a value would block every legitimate write, and a pool lane is never a control clone (same rule as `classifyOverlayRecord`). Tests inject `env` so the developer's real env never leaks in. Kept as a parallel seed (not folded into `DAEMON_CLONE_SEED`) because the owner differs — control clone vs. daemon — while the guards' semantics are identical. The overlay scan stays additive and fail-open for the OTHER daemon clones; the control roots never depend on it.
2. **Write sink refusal** — `writeBacklogMd` in `we:scripts/backlog/guarded-write.mjs:57` is the GUARDED card-write path (`we:scripts/operations/file-item-io.mjs` via `we:scripts/operations/scaffold-io.mjs:65-74`, and the `we:scripts/backlog.mjs` verbs that mutate through `writeBacklogMdCore`). It is NOT the only writer: `writeBacklogMdUnguarded` is a deliberate, documented carve-out (see Design §2b). `writeBacklogMd` calls `laneGuardDecision(resolveReal(abs), root)` WITHOUT the `daemonCloneRoots` option, which `we:scripts/guard-lane.mjs:155` defaults to `[]`, so the daemon-clone arm at `we:scripts/guard-lane.mjs:167` never fires for card writes. Fix: pass `daemonCloneRoots: cardWriteGuardRoots(workspaceRootOf(root), {env})`, where `cardWriteGuardRoots` (new, in the registry module) is `daemonCloneRoots(...)` MINUS the drain's own clone (`.lanes/we-drain-daemon/lane-1`) — see the carve-out below. The refusal is keyed on the TARGET path's realpath, not cwd or script location. Adjust the thrown message to name a daemon/control clone (the existing text says "PRIMARY checkout" and the guard-lane text points at `we:scripts/daemon-overlay.mjs`, wrong advice for a control clone). No new refusal shape is needed — `writeBacklogMd` already throws. `writeBacklogMd` gains two test seams in its opts, `env` (default `process.env`) and `cloneRoots` (default `cardWriteGuardRoots`), so a test can force the registry to throw or set `WE_CONTROL_CLONE`.
   - **Drain-clone carve-out (the arm is checked BEFORE the lane test, so a naive pass-through would break the drain).** `lane-drain` runs from its own clone (`resolveWeRoot()` = git toplevel of cwd = `.lanes/we-drain-daemon/lane-1`, `we:scripts/lane-drain.mjs:336`) and shells `we:scripts/backlog.mjs unqueue` / `release --force` / `resolve` with `cwd` there (`we:scripts/lane-drain.mjs:1251,1309,1384`). Those verbs write cards through `writeBacklogMd` and are best-effort `try/catch`, so a blanket refusal would silently leave landed items `queued`/`active`. The drain clone is therefore EXCLUDED from the card-write guard set (it stays in `daemonCloneRoots` for the Edit/Write hooks, where no tool legitimately writes there). Caller audit the build must record in the PR: `git grep` every in-repo caller of `writeBacklogMd`/`we:scripts/backlog.mjs` verbs invoked by a daemon (`we:scripts/lane-drain.mjs`, review/fix/merge daemons, `we:scripts/conveyor/`), name each caller's expected cwd clone class, and add any other daemon clone with a legitimate card-writing caller to the same carve-out list (exported as `CARD_WRITE_EXEMPT_CLONES`, so the exemption is data, not an ad-hoc `if`). The control clone is never exempt.
   - **Fail closed on registry error.** The sink's catch does NOT yield `[]` (that would drop the seeded control clone too, i.e. fail OPEN despite the edge-case heading). On a throw from the registry it falls back to the pure `controlCloneRoots(workspace, {env})` (which cannot throw: `path.join` + `realpathOrResolve`), so `wev-control` stays refused. (This deliberately differs from the PreToolUse hook at `we:scripts/guard-lane.mjs:257`, whose catch-to-`[]` is the hook's explicit never-wedge-the-agent policy; the card sink is a source-side refusal and may fail closed.)
2b. **Unguarded writer is a named exemption, not a gap** — `writeBacklogMdUnguarded` (`we:scripts/backlog/guarded-write.mjs:85`, used by `resolve-parent` at `we:scripts/backlog.mjs:1337`) is the drain's on-land splice carve-out per its own header; it runs on primary/the drain clone by design and stays unguarded in this MVP. The claim "every card writer routes through the guarded writer" is NOT made. Instead a test pins the exemption (Test 5): it lists every non-test caller of `writeBacklogMdUnguarded` and asserts the set equals an allow-list, so a new unguarded caller turns the test red until someone names and justifies it. Any other direct `writeFileSync` to a backlog card path is out of scope — see Follow-ups.
3. **Smell** — new `we:scripts/conveyor/health-smells/control-clone-dirty.mjs` beside `we:scripts/conveyor/health-smells/clone-stale.mjs`: probe `controlCloneDirty` in `we:scripts/conveyor/health-watch.mjs` runs `git -C <controlClonePath> status --porcelain --untracked-files=no` (tracked + staged changes only — the exact view the rebuild's own dirty check uses, so harmless untracked sidecars never false-positive; untracked cards stay owned by `untracked-backlog-card`) with the same `attempt()`/timeout wrapper as `probeUntrackedBacklogCards` (`probeUntrackedBacklogCards`, `we:scripts/conveyor/health-watch.mjs:486`, wired at `:1024`). The probe is exported as `probeControlCloneDirty({roots, exec, timeoutMs})`, mirroring that signature, so tests inject `roots`/`exec`. `evaluate` returns one subject per control clone, `breach` when the porcelain is non-empty, `measure` carrying count + first paths; `openAfter: 1`, `closeAfter: 1`, `severity: 'high'`, `action: 'investigate'`. A missing clone or failed `git` yields no subject (fail-open, nothing to report).

## MVP (Musts only)

- Register `wev-control` (default path AND `WE_CONTROL_CLONE` override) in the registry (guards protected).
- `writeBacklogMd` refuses a target inside the control clone or a daemon clone (registry passed to `laneGuardDecision`), with the drain's own clone carved out so its `we:scripts/backlog.mjs` verbs keep working, and falls back to the control roots (never `[]`) if the registry throws.
- `control-clone-dirty` smell + its probe wiring.
- Reword the `writeBacklogMd` refusal message (it says "PRIMARY checkout") to name a daemon/control clone.
- Tests 1–5 below, plus 3b (symlink spelling), 3c (corrupt overlay dir still refuses), 3d (`WE_CONTROL_CLONE` override), 3e (registry throws → still refuses), 3f (drain clone still writes).

OUT of scope: see Follow-ups.

## Edge cases this change must handle

1. **Untrusted text** — n/a: no LLM/PR/comment text reaches a shell, path or regex; the only input is a target path, compared by realpath.
2. **Truncated reads** — the new probe shells `git status --porcelain`; it uses the same runner as `probeUntrackedBacklogCards` with an explicit `timeoutMs` (the build verifies the runner's buffer limit and raises it if porcelain output can exceed it), and a failed or timed-out git is a non-subject (see 4), never "clean".
3. **Shared state files** — n/a: read-only probe and registry; no state file is written.
4. **Fail closed** — a corrupt overlay dir degrades to seed-only (which holds wev-control), so the write is still refused (Test 3c). A thrown registry error falls back to `controlCloneRoots` (pure, cannot throw), NOT `[]`, so the control clone is still refused (Test 3e). A guard refusal throws, never silently skips. The smell reports a probe error as a probe failure, not as "clean".
5. **Identity scoping** — match on realpath of the target (symlink and `..` spellings resolve). `WE_CONTROL_CLONE` ADDS to the default `<workspace>/wev-control` rather than replacing it; an override that is the workspace, an ancestor of it, or under `.lanes/` is ignored (Test 3d, Test 1b). Test 3b: a symlink into wev-control is refused.
5b. **Callers with a legitimate cwd in a guarded clone** — the drain runs `we:scripts/backlog.mjs unqueue|release --force|resolve` from its own clone; that clone is a named card-write exemption (`CARD_WRITE_EXEMPT_CLONES`), pinned by Test 3f, so the guard cannot silently stall landings. The caller audit in Design §2 is part of the build's PR evidence.
6. **State over time** — smell uses `openAfter:1`, `closeAfter:1`, so it closes once clean; no cross-tick repeat state to suppress. A restart mid-dirty reopens from the probe, not from memory.
7. **Who wrote it** — n/a: no comment, label or job name grants trust here.

## Follow-ups

- Sweep for card writers that bypass `writeBacklogMd` (direct `writeFileSync` to a backlog card path outside `we:scripts/backlog/guarded-write.mjs`) and decide whether they need the same refusal; a script check that every such caller routes through a guarded writer or carries a sanctioned-exempt annotation. (The known `writeBacklogMdUnguarded` carve-out is already pinned by Test 5 in this item.)
- A card-prepare checklist item, enforced by a prepare-stamp lint: when a design widens a shared guard's input set, list every in-repo caller of the guarded function and name each caller's expected cwd/clone class (this item's drain-clone miss is the motivating case); and a standards lint for `catch → []` on guard-root collection, plus "every env-overridable guard path has a test with the override set".
- Auto-remediation for a dirty control clone (salvage + reset) — the smell only reports; the operator's rule is that failures become daemon improvements, so a self-heal pass is the natural next item.
- Extending the existing `untracked-backlog-card` probe to staged (`A`) cards instead of a second smell, if the two smells prove redundant in practice.

## Risks

- `we:scripts/lib/daemon-clone-registry.mjs`'s `DAEMON_CLONE_SEED` is a hand-maintained list of sibling
  directory NAMES (`wev-review-daemon`, `wev-merge-daemon`, `wev-health-watch`, `wev-host-sampler`,
  `plateau-drain-daemon`, the drain's `.lanes/we-drain-daemon/lane-1`); `wev-control` is registered beside
  it as a parallel control-clone entry (Design §1), not inside that list. (The approval-prevention filer needs no change after #4317; the write-sink refusal lives in
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
   1b. Same file, with injected `env.WE_CONTROL_CLONE` set to a non-default path outside the default workspace location: BOTH the override and the default `<workspace>/wev-control` are registered; an override equal to the workspace, an ancestor, or under `.lanes/` is ignored (default only). Removing override handling must turn this red.
2. `we:scripts/__tests__/guard-lane.test.mjs` and `we:scripts/__tests__/guard-bash.test.mjs` already cover daemon clones, so add a
   `wev-control` case there that passes `daemonCloneRoots(<fixture workspace>)` (real registry, not a hand-built
   roots list) to `laneGuardDecision`/`daemonCloneWriteReason` — RED today only because the registry omits it.
3. A regression on `writeBacklogMd` (`we:scripts/backlog/guarded-write.mjs`, the REAL writer, not an injected
   `write`) targeting a file inside a fixture `<workspace>/wev-control` (tmp workspace): asserts it throws and
   writes no file; RED today because `laneGuardDecision` is called without the registry. Pass
   `{root: <tmp workspace>/<repo>}` so `workspaceRootOf(root)` resolves to the tmp workspace, not the real one.
   Companion: a target in an ordinary lane clone still writes. 3b: a symlink into the fixture wev-control is
   refused. 3c: with a corrupt file in the (injected) overlay dir the write is still refused.
   3d: **`writeBacklogMd refuses a target under WE_CONTROL_CLONE`** — inject `env.WE_CONTROL_CLONE` pointing outside the default workspace location; asserts a throw and no file created, and the default `<workspace>/wev-control` is still refused. 3e: force the registry (`cloneRoots` seam) to throw; a write into the fixture wev-control is still refused and no file is created. 3f: **drain-clone regression** — `root` and target inside the seeded fixture `<workspace>/.lanes/we-drain-daemon/lane-1`; asserts the write SUCCEEDS (the carve-out), so a mutation that drops `CARD_WRITE_EXEMPT_CLONES` turns it red; add one end-to-end case running the `we:scripts/backlog.mjs` `resolve`/`unqueue` verb with cwd in that fixture clone, since those are what `lane-drain` actually shells.
4. A unit test for the new smell (alongside `we:scripts/conveyor/health-smells/clone-stale.mjs`; discovered
   automatically from disk) asserting it opens an episode for a fixture control clone with a modified/staged
   tracked file, does NOT open for an untracked-only clone, and reports `breach:false` once clean (`evaluate` is
   pure; the close itself is `stepEpisodes` in `health-watch-core`, driven in the test for the open→close path).
5. Exemption pin (in `we:scripts/backlog/__tests__/primary-write-guard.test.mjs`): lists every non-test caller of `writeBacklogMdUnguarded` under `scripts/` and asserts the set equals an explicit allow-list (the `we:scripts/backlog.mjs` shim and its `resolve-parent` use); a new unguarded caller turns it red until named and justified.

## Tasks

1. Add `controlCloneRoots` (default path + `WE_CONTROL_CLONE`, pure, non-throwing) to `we:scripts/lib/daemon-clone-registry.mjs`, union it into `daemonCloneRoots` (Design §1) distinct from `DAEMON_CLONE_SEED`, and add `cardWriteGuardRoots` + `CARD_WRITE_EXEMPT_CLONES` (drain clone).
2. Make `writeBacklogMd` in `we:scripts/backlog/guarded-write.mjs` pass `cardWriteGuardRoots` to
   `laneGuardDecision` so every card write into the control clone or a non-exempt daemon clone is refused at the source — reusing the
   existing guard rather than re-deriving it; fall back to `controlCloneRoots` if the registry throws; record the caller audit in the PR (see Design §2; `we:scripts/review-set-label.mjs` needs no change after #4317).
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

1. **Executable** — the Test plan #1–#5 regressions (incl. 1b, 3d, 3e, 3f) all fail before this item lands and pass after, runnable
   via `npm run check:standards`/`vitest` with no manual daemon-clone surgery.
