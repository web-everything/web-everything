---
kind: decision
size: 3
status: resolved
dateOpened: "2026-11-01"
dateResolved: "2026-11-01"
graduatedTo: xfwf4zc
codifiedIn: one-off
preparedDate: "2026-11-01"
preparedAgainstSha: "ba3415c4eadc847701ed1f287e38dded49646ec8"
tags: []
---

# Rebuild smoke dry-runs: run only where relevant, share one verdict per commit, run on Forge

## Digest

Rebuild smokes spend 768 of 1,365 rebuild-minutes a day (`dispatch-dry-run` 510, `reconcile-dry-run` 258), and the 12 h smoke reuse hit only 2 of 107 (operator perf pack 2026-11-01, plan item 9 / section A4, ruling R337). Smoke runs take 187-2160 s. Four forks decide the shape; each default keeps the smoke's job (stop a broken candidate from being adopted) intact. Out of scope: the `reconcile-dry-run` "no gh slot" refusal under load, which a separate fix already covers.

| Fork | Recommended default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 - relevance | (a) per-daemon import closure picks which code checks run | (b) hand-kept path-glob table | High |
| 2 - sharing | (a) one verdict per (tree, lockfile, node, harness) in a shared host store, valid 12 h | (b) per-clone only (today) | Medium-high |
| 3 - where it runs | (a) code checks on Forge, Mac fallback with the same checks | (b) Mac only | Medium |
| 4 - always-run floor | (a) env checks, boot smoke and tree-stays-clean every time | (b) skip all when unrelated | High |

## Grounding (current code)

- Checks live in `SMOKE_CHECKS` (we:scripts/lib/daemon-live-smoke.mjs:827). Code checks carry `codeEntries`; today they are skipped only when no changed file touches the check's own import closure since the last live-verified build (we:scripts/lib/daemon-live-smoke.mjs:805-820). `dispatch-dry-run` and `reconcile-dry-run` pull in the dispatch/reconcile machinery, which changes on most merges, so they rarely skip (the xa4qo7n note at we:scripts/lib/daemon-live-smoke.mjs:815).
- The whole-rebuild skip `skipUnrelated` already exists (we:scripts/lib/daemon-rebuild/skip-unrelated.mjs:1) but unions everything the shared candidate smoke exercises across all daemons, so one daemon's smoke surface keeps every daemon's rebuild awake.
- Reuse key = `smokePassKey({tree, lockHash, nodeVersion, harnessHash, cloneKind})` (we:scripts/lib/daemon-rebuild/smoke.mjs:71), stored in each clone's own rebuild state and read at we:scripts/lib/daemon-rebuild/smoke.mjs:448 with a 12 h window. Five clones never see each other's pass, and `cloneKind` splits the key further. That is why reuse is 2/107 while 20 of 84 targets were rebuilt 2-3 times.
- Forge is 96-100 % idle with 32 cores, and only about 6 % of heavy minutes run there (perf pack C, section 1). Remote routing and admission: we:scripts/lib/verify-remote-routing.mjs, we:scripts/lib/remote-manifest.mjs.

## Fork 1 - Which changed files trigger which smoke checks?

**Fork-existence:** a dispatch check run for a daemon that never dispatches proves nothing about that daemon, while a path-glob table that drifts from real imports lets a changed dependency skip its check; the two relevance sources cannot both be the authority.

- **(a) Per-daemon import closure. Recommended default.** Each daemon's entry list (`DAEMON_ENTRY_MODULES`, we:scripts/lib/daemon-boot-smoke.mjs) is crossed with each check's `codeEntries`: `dispatch-dry-run` and `reconcile-dry-run` run only when the changed files touch the closure of an entry that actually imports dispatch/reconcile machinery (review, fix, build, verify, conveyor runner). Health-watch and drain rebuilds skip them. It is computed, so it cannot drift.
- (b) A hand-kept glob table (`scripts/conveyor/** -> dispatch-dry-run`). Simple to read. **Rejected:** it drifts silently from real imports, and a missed edge skips a check on changed code, the failure the closure rule (#4044) was built to avoid.
- (c) Always run everything (today). **Rejected as default:** it is the 768 min/day.

Unknown diff, incomplete closure, or a non-code change (manifest, lockfile, config, runtime-read file) means the check runs, as today.

Skeptic: SURVIVES-WITH-AMENDMENT. Amendment folded in: a relevance-skipped row is recorded as `skipped:relevance` with its closure hash, and `completeSmokePass` (we:scripts/lib/daemon-rebuild/smoke.mjs) accepts it only when paired with a recorded prior live pass of that same check on a closure-identical tree; otherwise the check runs.
Screen: clear

## Fork 2 - How is a verdict shared per commit across daemons, and how long is it valid?

**Fork-existence:** a verdict keyed too loosely lets one clone's pass vouch for code or tooling it never ran, and keyed per clone it is never reused; both extremes break the smoke's purpose or its saving, so the key must be exact.

- **(a) One verdict per exact identity (tree + lockHash + nodeVersion + harnessHash, plus `cloneKind` where a check depends on it), shared by all clones, valid 12 h. Recommended default.** Never the sha alone; a changed harness or lockfile changes the key; the window stays today's `reuseHours` (we:scripts/lib/daemon-rebuild/smoke.mjs:45). Build-time details (store file layout, atomic write, bounded wait for a concurrent rebuild of the same key, the `cloneIndependent` per-check flag) belong to the build child, not this ruling.
- (b) Per-clone reuse only (today). **Rejected:** reuse is 2/107.
- (c) Key by commit sha instead of tree. **Rejected:** a merge commit with an identical tree would miss, and a moved sha with different content must not hit; the tree is the real identity.

Env checks (`gh-api-repo`, `gh-pr-list`, lane checks) are never taken from the shared verdict (Fork 4).

Skeptic: SURVIVES-WITH-AMENDMENT. Amendments folded in: `cloneKind` stays in the key by default and is dropped only through a per-check `cloneIndependent: true` flag that a test asserts; the harness hash must cover every module the smoke imports (today it hashes only we:scripts/lib/daemon-live-smoke.mjs; see we:scripts/lib/daemon-rebuild/smoke.mjs:82); the shared store is written only after a full `completeSmokePass`, never from partial rows.
Screen: flagged(impl) -> fix applied: ruling narrowed to the key and validity principle; store layout, wait and `cloneIndependent` flag moved to the build child.

## Fork 3 - Run on Forge or on the Mac, and what falls back?

**Fork-existence:** the env checks must observe the real host's lane pool and gh quota, which only the Mac has, while the code checks (dry-runs, boot smoke) are pure functions of the tree and run anywhere; one location cannot serve both.

- **(a) Code checks on Forge when its health says ready; env checks stay on the Mac. Recommended default.** Forge unreadable, busy or a transport error falls back to the Mac with the same check set and the same verdict rules (never a silent pass). A Forge result is accepted only under the Fork 2 key.
- (b) Whole smoke on the Mac (today). **Rejected as default:** the Mac is the scarce host and Forge sits idle.
- (c) Whole smoke on Forge. **Rejected:** env checks would test Forge's lane pool and gh slot, not the Mac daemon's.

Skeptic: SURVIVES-WITH-AMENDMENT. Amendments folded in: the Forge run must report the tree sha it smoked and the Mac rejects a result whose tree differs from the candidate (plus overlays, per resident-daemon-reload-lifecycle in we:docs/agent/platform-decisions.md); Forge-routed smokes are admitted through the heavy-command queue (heavy-command-admission-queue anchor); the existing remote routing (we:scripts/lib/verify-remote-routing.mjs) is the only transport.
Screen: clear

## Fork 4 - What must still run every time?

**Fork-existence:** skipping the cheap, environment-bound checks on an unchanged tree would let a broken host (full lane pool, bad gh auth, dirty tree) look healthy through a cached verdict, so a floor exists by necessity.

- **(a) Always run: gh-api-repo, gh-pr-list (external, about 1 s), the daemon boot smoke (#4468) for every daemon whose closure changed, and tree-stays-clean; lane-pool checks keep today's closure skip. Recommended default.** Only the two dry-runs are relevance-skipped or shared. A failed verdict is never cached as a pass, and failed rows are not shared.
- (b) Skip everything when nothing relevant changed. **Rejected:** env faults would pass unobserved.

Skeptic: SURVIVES-WITH-AMENDMENT. Amendment folded in: `lane-pool-list` and `lane-acquire-release` carry `codeEntries` (we:scripts/lib/daemon-live-smoke.mjs:830) and are closure-skippable today; the default keeps that skip, so the floor is the `env`-kind gh checks, the boot smoke and `tree-stays-clean` (which has no `codeEntries`). Only the two dry-runs gain a new skip.
Screen: clear

## Trust boundary and threat model

The shared verdict store is read by every daemon clone and decides whether new code is adopted. Threats and handling: a forged or stale verdict file (key must match exactly and `passedAt` must be inside the window; a malformed or truncated file counts as absent and the check re-runs); a clone writing a pass for a tree it did not smoke (only the process that ran the checks writes, and the record names the checks that ran); two writers racing (atomic rename, reader re-verifies the key); Forge output is untrusted text (parsed through the existing smoke classifier, never executed); fail closed: any doubt means run the check.

## Pre-mortem

It is three weeks later and this went badly. Likely causes: (1) a daemon import edge missed by the closure scan, so a changed dispatcher skipped its dry-run and a broken build was adopted; mitigated by the unknown-means-run rule and a test that diffs the closure against real imports. (2) The shared store let one clone's pass cover a tree where `cloneKind` mattered; mitigated by keeping `cloneKind` for checks that depend on it. (3) A Forge outage turned every rebuild into a wait; mitigated by a bounded wait and Mac fallback. (4) The gh-slot refusal fix landed differently and the two collided; mitigated by leaving that check's behaviour alone here. (5) The saving was real but unmeasured, so nobody noticed a regression; mitigated by the live proof below.

## Test and proof plan

- Unit: relevance test (each daemon x changed-file set -> expected check set; unknown diff runs all); shared-store test (hit, miss on any key part, expired, truncated, concurrent writers); fallback test (Forge unreadable / busy / error -> Mac runs the same checks, never a silent pass); floor test (gh checks, boot smoke and tree-stays-clean always present); harness-hash test (changing any imported smoke module changes the key); tree-sha mismatch test for Forge results.
- Mutation proof: weaken the closure scan to skip when unsure and confirm the unknown-diff test fails.
- Live proof, before/after: baseline from the perf pack (768 of 1,365 rebuild-min/day, reuse 2/107, smokes of 187-2160 s) against the same counters over 24 h after loading on the prototype overlay. Targets: dry-run minutes down at least 250/day, reuse hit rate over 40 %, zero adopted-then-reverted builds. The daemon's rebuild smoke is the gate.
- Audit: a read-only Codex audit must say NOT WEAKENED before landing.

## Acceptance

- [A1] **Executable** - `node --test` on the relevance, shared-store, fallback and floor tests named above fails before the build and passes after.

## Non-goals

- [N1] The `reconcile-dry-run` gh-slot refusal fix, the env-check timeout classification, and the 12 h window length stay as they are.

## Edge cases this change must handle

1. **Untrusted text** - Forge output goes through the existing smoke classifier and is never executed.
2. **Truncated reads** - a truncated or malformed verdict file counts as absent; the check re-runs.
3. **Shared state files** - one host-level store, atomic rename write, reader re-verifies the key.
4. **Fail closed** - unknown diff, incomplete closure or unreadable Forge means the check runs on the Mac.
5. **Identity scoping** - key is tree + lockHash + node + harness (+ `cloneKind` where it matters), never the sha alone.
6. **State over time** - the verdict expires after 12 h; a harness or lockfile change changes the key.
7. **Who wrote it** - a record names the checks that ran and the writer; a record not written by a completed smoke is ignored.

## Supported by default (not decisions)

- Keep the 12 h window and the `reuseEnabled` knob; keep transient-retry and env-timeout classification untouched.
- Leave the `reconcile-dry-run` gh-slot refusal to its own fix.

## Ratified - 2026-11-01

Operator chalbert, 2026-11-01 15:44 ET: "Ratify x1bppc5" (ruling R344). All four forks ratified with their bold defaults, including the skeptic amendments recorded under each fork.

- **Fork 1 - (a)** Relevance by per-daemon import closure, with the live-pass-on-identical-closure rule for `skipped:relevance` rows.
- **Fork 2 - (a)** One shared verdict per (tree, lockHash, node, harness, plus `cloneKind` where it matters), valid 12 h.
- **Fork 3 - (a)** Code checks on Forge, Mac fallback with the same checks, and a Mac reject on tree mismatch.
- **Fork 4 - (a)** gh checks, boot smoke and tree-stays-clean always run.

Build is sequenced after R333. Build child carved from this ruling (see `graduatedTo`).

## Done when

The operator rules forks 1-4; build children are carved from the ruling (relevance, shared store, Forge routing), each scoped to its own files.
