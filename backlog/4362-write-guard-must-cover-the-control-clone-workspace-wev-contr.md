---
bornAs: xaqg28x
kind: story
size: 3
priority: high
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-clone-registry.mjs", "we:scripts/lib/__tests__/daemon-clone-registry-control-clone.test.mjs", "we:scripts/backlog/guarded-write.mjs", "we:scripts/backlog/__tests__/guarded-write-control-clone.test.mjs", "we:scripts/backlog/__tests__/primary-write-guard.test.mjs", "we:scripts/conveyor/health-watch.mjs", "we:scripts/conveyor/__tests__/health-watch.test.mjs", "we:scripts/conveyor/health-smells/control-clone-dirty.mjs", "we:scripts/conveyor/health-smells/__tests__/control-clone-dirty.test.mjs", "we:scripts/__tests__/guard-lane.test.mjs", "we:scripts/__tests__/guard-bash.test.mjs"]
scopeRationale: "we:scripts/backlog.mjs is named in the MVP only as the CALLER whose verbs (unqueue, release --force, resolve) route through the guarded writeBacklogMd sink and are exercised by the drain-clone regression test; it is not edited — the guard change lives in we:scripts/backlog/guarded-write.mjs."
dateOpened: "2026-09-28"
preparedDate: "2026-10-09"
preparedAgainstSha: "b55fa00aefdda82c88e76b436bcc4342593f8c8f"
tags: []
---

# Write guard must cover the control clone like other daemon clones

The control checkout must reject ordinary agent edits and guarded card mutations, and health-watch must report tracked dirt that can prevent its rebuild. Historical evidence (2026-09-28): cards 4314 (staged) and 4363 (untracked) were filed in the control checkout, and the builder reported “rebuild did not move the clone (dirty).” Preserve this goal while distinguishing staged dirt from untracked files.

## Progress

Rechecked on 2026-10-09 against checkout `b55fa00aefdda82c88e76b436bcc4342593f8c8f`; this is preparation evidence, not a new preparation stamp.

- **Old premise:** the registry omitted the control clone, the approval-prevention filer wrote in its cwd, and a dirty-clone smell was missing. **Corrected premise:** the registry omission and guarded-writer gap remain; the filer is already a wrapper over lane-based prevention landing at `we:scripts/review-set-label.mjs:720`. It needs no edit. `we:scripts/lib/daemon-clone-registry.mjs:60` seeds daemon clones but no control clone, and its union at `we:scripts/lib/daemon-clone-registry.mjs:156` contains only seeds and overlays. `we:scripts/backlog/guarded-write.mjs:57` still calls the decision without registry roots. The proposed control-clone smell and probe do not exist.
- **Old scope:** four production files, hook regression tests, a primary-writer test, and a health-watch test; no matching registry test or dedicated smell test. **Corrected scope:** retain those production files and existing tests, add planned matching registry, guarded-writer, and smell test files in frontmatter. The hook implementations already consume the registry (`we:scripts/guard-lane.mjs:155`, `we:scripts/guard-bash.mjs#daemonCloneWriteReason`); no implementation change there is required. The CLI is a caller, not an edit target. Size remains **3**: the implementation boundaries remain the same, with explicit regression coverage now included.
- **Drain evidence refreshed:** root discovery is now `we:scripts/lane-drain.mjs:340`; guarded CLI calls are at `we:scripts/lane-drain.mjs:1288` (unqueue), `we:scripts/lane-drain.mjs:1346` (release), and `we:scripts/lane-drain.mjs:1422` (resolve). They use the supplied checkout cwd. The known dedicated drain clone remains seeded at `we:scripts/lib/daemon-clone-registry.mjs:68`, so blindly passing all roots would break legitimate drain mutations.
- **Caller evidence:** operation sinks use the guarded writer at `we:scripts/operations/claim-io.mjs:131`, `we:scripts/operations/resolve-io.mjs:209`, `we:scripts/operations/review-prep-io.mjs:307`, and through the scaffold sink at `we:scripts/operations/scaffold-io.mjs:65`. These author into their supplied execution checkout and gain the same refusal. The CLI shim at `we:scripts/backlog.mjs:125` supplies its own root. The explicit unguarded CLI use remains resolve-parent at `we:scripts/backlog.mjs:1339`; the guarded writer itself also delegates to the unguarded writer at `we:scripts/backlog/guarded-write.mjs:68`, which the previous proposed allow-list omitted.
- **Probe drift corrected:** tracked/staged dirt is checked at `we:scripts/lib/daemon-rebuild/local-state.mjs:106` and `we:scripts/lib/daemon-rebuild/prepare.mjs:157` with untracked files excluded. The default self-sync wrapper ignores its old sync function (`we:scripts/lib/daemon-self-sync.mjs:536`), but the POC function remains callable at `we:scripts/lib/daemon-self-sync.mjs:622`; the previous claim that neither legacy function is called was too broad. This smell mirrors the rebuild check, not every POC behavior.
- **Error plumbing corrected:** `attempt()` at `we:scripts/conveyor/health-watch.mjs:974` captures thrown/rejected errors only. Returning an error record cannot populate probe errors automatically. The design below explicitly forwards per-root failures while retaining successful roots. The subprocess runner already has a 64 MiB buffer (`we:scripts/conveyor/health-watch.mjs:590`). Missing-subject preservation is implemented at `we:scripts/conveyor/health-watch-core.mjs:485`.

## Design

### Registry and target identity

In `we:scripts/lib/daemon-clone-registry.mjs`, add `controlCloneRoots(workspace, {env})` and union its deduplicated roots into `daemonCloneRoots`. Reuse `CONTROL_CLONE_DIRNAME` from `we:scripts/lib/automation-home.mjs:43`. Include both the default control checkout and a nonblank `WE_CONTROL_CLONE` override: an override adds protection rather than removing the default. Resolve existing symlinks and normalize absent paths. Ignore overrides equal to the workspace, above it, or inside its lane pool, using boundary-aware realpath comparisons. Keep this helper independent of overlay reading, with no throws for valid workspace strings and absent/malformed environment values.

Keep control roots distinct from `DAEMON_CLONE_SEED` in naming while sharing guard semantics. Overlay discovery remains additive and tolerant of missing/corrupt records. Tests inject environment and an isolated overlay directory; they never inspect the developer's overlay state.

Add `CARD_WRITE_EXEMPT_CLONES` containing the dedicated drain clone's workspace-relative name, and `cardWriteGuardRoots(workspace, {env})` returning the registry roots as a **set difference**: every registry root whose resolved real path is not exactly equal (`===` on the realpath-normalized string) to a resolved exempt clone. Dropping that one root from the set is the whole exemption. A card path inside the drain clone, such as `<drain clone>/backlog/<card>.md`, therefore no longer matches any guard root and is writable. That is intended: the drain's `unqueue`, `release --force` and `resolve` calls target exactly such paths. The exemption is not a path-prefix, `startsWith` or `includes` test. Any other root stays in the set, including a sibling whose name merely begins with the drain clone's name (`.../we-drain-daemon/lane-1-x`, `.../lane-10`), a root nested below the drain clone, and a root whose path merely contains the drain clone's name. Never exempt the control clone. The drain remains protected by both tool hooks; this exemption applies only to the card-write sink. No additional caller exemption is authorized by this item.

### Guarded card writes

In `we:scripts/backlog/guarded-write.mjs`, pass `cardWriteGuardRoots(workspaceRootOf(root), {env})` as the `daemonCloneRoots` option to `laneGuardDecision`. Keep target resolution through `resolveReal(abs)`, not cwd classification. Add injectable `env` and `cloneRoots` options, defaulting to the process environment and registry collector. If collection throws, use `controlCloneRoots` as the fallback; never substitute an empty set that removes control protection. This guarantees control-clone refusal on collection failure, not protection of every dynamically discovered daemon under that failure.

Preserve `cause: 'lane-guard'`, refusal before persistence, and the existing primary-checkout refusal text. Use a separate daemon/control refusal message for the new branch so primary golden fixtures stay valid and control users are directed to a lane, not told to apply a daemon overlay. Keep content scrubbing and locus checks on successful writes. Refusals must leave both existing file bytes and absent targets unchanged.

The explicitly unguarded writer remains the documented on-land exemption. Pin its production caller set to the guarded writer's delegation plus the CLI shim and resolve-parent use, rather than claiming every card writer is guarded. Other direct filesystem writers are follow-up scope.

### Control-clone dirt probe and smell

Add exported `probeControlCloneDirty({roots, exec, timeoutMs, exists})` in `we:scripts/conveyor/health-watch.mjs`, defaulting roots to `controlCloneRoots(workspaceOf(REPO_ROOT), {env: process.env})`, the existing subprocess runner, 15 seconds, and filesystem existence checking. For each existing root run git status with porcelain output and untracked files excluded. Return `{cloneRoot, ok: true, lines}` on success, including empty lines for a clean clone; return `{cloneRoot, ok: false, error}` on subprocess failure, timeout, or buffer overflow. The runner returns a string and throws on nonzero exit. Omit nonexistent roots; do not treat an existing non-repository directory as clean. Preserve porcelain status columns when splitting nonempty lines.

Wire the probe every tick beside the untracked-card probe (`we:scripts/conveyor/health-watch.mjs:1025`). Use `attempt()` for whole-probe exceptions. After collection, explicitly aggregate and scrub failed-root errors into `probeErrors.controlCloneDirty`, retaining successful records in `probes.controlCloneDirty`. Bound the diagnostic summary; do not log unsanitized subprocess errors. Returned error records must not disappear silently just because the collector itself returned normally.

Create `we:scripts/conveyor/health-smells/control-clone-dirty.mjs`. Auto-discovery in `we:scripts/conveyor/health-smells/index.mjs` requires no registration edit. Declare the new probe, severity high, action investigate, openAfter 1, closeAfter 1, and `missingSubjectsUnknown: true`. Emit one subject per successful root, keyed by its canonical root: breach iff lines are nonempty, measure with total count and at most five porcelain entries, recommendation to identify and fix the writer. Failed or absent roots emit no subject, preserving an existing episode as unknown. A successful clean read closes it. This is read-only diagnosis; no salvage, reset, or cleanup.

Untracked-only files do not breach this smell. Existing `we:scripts/conveyor/health-smells/untracked-backlog-card.mjs` gains the control root through the shared registry, but its probe still covers only aged hash-named cards (`we:scripts/conveyor/health-watch.mjs:504`). A numbered untracked card remains outside both signals; it does not block the rebuild check this item mirrors.

## MVP

1. Add default-plus-override control registration and the exact drain-only card-write exemption in `we:scripts/lib/daemon-clone-registry.mjs`.
2. Enforce those roots in `we:scripts/backlog/guarded-write.mjs`, retaining control protection on registry failure, primary refusal compatibility, and content checks.
3. Add the read-only tracked-dirt probe in `we:scripts/conveyor/health-watch.mjs` and the automatically discovered smell in `we:scripts/conveyor/health-smells/control-clone-dirty.mjs`, including error visibility and unknown-state preservation.
4. Deliver the scoped regression files below. No hook implementation edits, CLI edits, approval-filer edits, or automatic clone cleanup.

## Edge cases this change must handle

1. **Untrusted text** — n/a for shell, argv and regex: no LLM, PR or comment text reaches them, and targets are compared as resolved paths, never matched by substring. Porcelain status lines come from git output, are bounded to five in the measure, and are scrubbed before they reach `probeErrors.controlCloneDirty` (Design, probe section). Path spellings with `..` or a symlink resolve through realpath before comparison.
2. **Truncated reads** — the probe uses the existing runner with an explicit 15-second timeout and its 64 MiB buffer. A timeout, nonzero exit or buffer overflow returns `{ok: false}` for that root. It never reads as clean, and a partial read is never counted (Test plan, probe and wiring).
3. **Shared state files** — n/a: the registry, the guard decision and the probe are read-only. The only write is the card write the guard already controls, and a refusal happens before persistence and leaves existing and absent targets unchanged.
4. **Fail closed** — a corrupt or missing overlay degrades to the seeds plus the control root, so a control-clone write is still refused. A throwing registry collector falls back to `controlCloneRoots`, never `[]`. A failed probe emits no subject and, with `missingSubjectsUnknown: true`, leaves an open episode open instead of closing it as clean. A guard refusal throws; it never silently skips.
5. **Identity scoping** — match on the real path of the target, so symlink and `..` spellings resolve. `WE_CONTROL_CLONE` adds to the default `<workspace>/wev-control` and never replaces it; an override equal to the workspace, above it, or inside the lane pool is ignored. The drain exemption is an exact resolved-path set difference, never a prefix or substring match (Design, registry section). Subjects are keyed by canonical root.
5b. **Callers with a legitimate cwd in a guarded clone** — the drain runs `we:scripts/backlog.mjs` `unqueue`, `release --force` and `resolve` from its own clone, and writes cards beneath it. Dropping that root from the card-write set keeps those writes working, and the writer test pins a descendant card path of the drain clone as writable.
6. **State over time** — the smell uses `openAfter: 1` and `closeAfter: 1`, so it closes once the clone is clean and holds no cross-tick suppression state. A restart mid-dirty reopens from the next probe, not from memory. Dirty, then failed, then dirty keeps the same episode with no close or reopen.
7. **Who wrote it** — n/a: no comment, label or job name grants trust here. The only exemption is a fixed constant naming the drain clone.

## Risks

Each risk maps to the Test plan entry that would go red if the risk came true.

- **Registry gaps.** `DAEMON_CLONE_SEED` is a hand-maintained list of clone names, and a clone absent from it and from the overlay stays unguarded. This is a known residual, not in this MVP. The control clone is registered through its own helper, not inside that list. The approval-prevention filer needs no change after #4317. Test plan: Registry, Hooks.
- **Overlay failure must stay fail-open for readers and fail-closed for the control clone.** A missing or corrupt overlay file degrades to seeds, never throws, and the control root is always present. Test plan: Registry (malformed or missing overlay), Writer (corrupt overlay, throwing collector).
- **Drain exemption too loose or too tight.** Too loose: a prefix or substring filter drops sibling or nested roots from the guard. Too tight: a path-prefix guard left on the drain clone refuses the drain's own card writes and strands landed items queued or active. Test plan: Registry (near-miss fixtures), Writer (drain descendant writes, near-miss refusals).
- **Control clone is not a daemon.** It is human-operated, so it gets its own helper and name, `controlCloneRoots`, while sharing the guard's write semantics, and the refusal text sends users to a lane. Test plan: Writer (refusal cause and message), Existing writer contract (primary text unchanged).
- **Probe failure read as clean.** Converting an error into an empty read would close a real episode. Test plan: Probe and wiring, Episodes.
- **New unguarded writers.** The explicitly unguarded writer is a documented exemption, and a new caller must be named. Test plan: Existing writer contract.

## Test plan

- **Registry:** planned `we:scripts/lib/__tests__/daemon-clone-registry-control-clone.test.mjs`. Verify default registration without overlays, additive valid override, deduplication and symlink identity, rejection of workspace/ancestor/lane-pool overrides, malformed or missing overlay state, continued inclusion of existing daemon seeds, and exact drain exclusion only from card-write roots. Name the near-miss fixtures: an overlay-registered root at `<workspace>/.lanes/we-drain-daemon/lane-1-x` (name-prefix sibling), one at `<workspace>/.lanes/we-drain-daemon/lane-10`, one nested at `<drain clone>/nested`, and one whose path merely contains the drain clone's name (`<workspace>/other/.lanes/we-drain-daemon/lane-1`). `cardWriteGuardRoots` must still return every one of them, and must drop only the exact drain root. An implementation that filters with `startsWith` or `includes` must fail this test. Existing `we:scripts/lib/__tests__/daemon-clone-registry-fix-clone.test.mjs` remains a compatibility check.
- **Hooks:** extend existing `we:scripts/__tests__/guard-lane.test.mjs` and `we:scripts/__tests__/guard-bash.test.mjs` with actual registry output protecting control-clone targets and preserving ordinary lane access. Avoid a hand-built root list that would pass without registration.
- **Writer:** planned `we:scripts/backlog/__tests__/guarded-write-control-clone.test.mjs`. Invoke the real writer in temporary workspaces, covering new and existing targets in the default control root, override root, ordinary daemon root, and symlink into an existing backlog directory. Assert refusal cause and unchanged filesystem. Cover corrupt overlays and a throwing collector, both still refusing control writes; ordinary lane and dedicated drain targets must write successfully: the drain case writes a card at `<drain clone>/backlog/<card>.md`, a descendant of the exempt root, and must succeed (a path-prefix guard kept on the drain clone fails it). Add refusal cases for a card written inside each near-miss overlay root above (`lane-1-x`, `lane-10`, nested, contains-name), each leaving the filesystem unchanged. Use isolated env, not real host paths. Exercise an actual CLI unqueue or resolve in a temporary drain clone containing the CLI and dependencies; assert the card mutation, not only exit status. The CLI derives its root from script location, so launching the lane's CLI with only a changed cwd is insufficient.
- **Existing writer contract:** update `we:scripts/backlog/__tests__/primary-write-guard.test.mjs`, whose current source assertions require the old two-argument decision call. Preserve meaningful pre-write ordering and primary/content refusal assertions while accepting the new options. Pin production unguarded calls including the guarded delegation and CLI shim/resolve-parent. Exclude tests and comments from the caller enumeration.
- **Probe and wiring:** extend `we:scripts/conveyor/__tests__/health-watch.test.mjs`. Verify command arguments, timeout propagation, clean/modified/staged/untracked-only real temporary git fixtures, missing roots, non-repositories, throwing/nonzero/timeout/buffer failures, and a mixed successful/failed root set. Drive tick wiring with mocked probe execution and isolated state to assert scrubbed `probeErrors.controlCloneDirty` while successful roots remain available; do not invoke live daemons or change host checkouts.
- **Episodes:** planned `we:scripts/conveyor/health-smells/__tests__/control-clone-dirty.test.mjs`. Drive evaluate and `stepEpisodes` from `we:scripts/conveyor/health-watch-core.mjs`: staged new card like incident 4314 opens; untracked-only numbered card like incident 4363 does not; tracked modification opens; confirmed clean closes. Dirty → failed or missing → dirty retains the same episode without close/reopen. Mixed roots evolve independently. Removing `missingSubjectsUnknown` or converting failures into clean readings must fail the test.

The new protection cases fail against the current implementation; compatibility cases such as ordinary-lane writes and existing content gates already pass and must stay green. Do not claim all tests fail before the change.

## Proof plan

During implementation, run tests only via the host queue: invoke `node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run <test-file>` with repository prefixes removed from executable filesystem arguments. Run the scoped tests and existing registry compatibility test; run standards through the same queue with `npm run check:standards`. Record actual red/green outcomes for the new protection and episode cases; preparation does not claim those results in advance.

Before changing runtime code, collect a read-only registry/decision baseline against an isolated nonexistent workspace and empty overlay directory: show the default control root absent and its target decision allowed. After implementation, repeat to show registration and refusal. Perform real writes only in the temporary fixture workspaces, including the CLI drain regression. Never probe the real control clone by attempting a write.

For live proof after implementation, read the registry against the actual workspace and run a dry `laneGuardDecision` for a control-checkout backlog path; show the refusal without persisting anything. Run `probeControlCloneDirty` read-only against the real control root and report its observed clean, dirty, missing, or failed result honestly. A currently clean host is not evidence of the dirty episode: the temporary tracked/staged fixture supplies that proof. Record the current caller audit and exact tested revision with the delivery evidence. The runner owns preparation stamping and checks for this preparation-only change.

## Follow-ups

- Audit direct backlog filesystem writers outside `we:scripts/backlog/guarded-write.mjs`; route them through the shared guard or document independently authorized exemptions.
- Consider coverage of numbered untracked cards in `we:scripts/conveyor/health-watch.mjs#probeUntrackedBacklogCards`; this is separate from tracked dirt blocking rebuilds.
- Consider automated dirty-clone recovery only as a separate change with preservation and recovery policy; this item detects and refuses, never resets.
- Add preparation checks for shared-guard caller audits, environment override cases, explicit matching test scope, and citations to the live check a proposed probe mirrors.

## Done when

Both tool guards reject control-clone targets through registry membership; the guarded writer refuses control and non-exempt daemon targets while ordinary lanes and the dedicated drain retain required behavior; tracked dirt opens a visible health episode, probe failures preserve it, and a successful clean observation closes it. Scoped regressions and the queued standards check pass, with observed fixture and read-only live proof recorded.
