---
bornAs: xj5jzz5
kind: story
size: 5
parent: "2527"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: Phase 2; shared durable state store (DO/D1)."
dateParked: "2026-11-22"
blockedBy: ["2703", "2626", "2642"]
scope: ["we:scripts/conveyor/"]
dateOpened: "2026-07-27"
tags: []
---

# Un-gate: stand up the shared durable operational-state store (DO/D1) when the product's session-free runner needs cross-session state

The tracked un-gate trigger for decision #2626. FIRES when the first session-free product surface — the #2527 console build endpoint or the #2703 retirement of the main-session loop — must read/write conveyor operational state with NO main session present, so a machine-local sidecar written by one process can no longer be read by the UI or another actor.

On fire: stand up the shared durable store behind the existing store seam (the [`we:scripts/conveyor/queue-store.mjs`](../scripts/conveyor/queue-store.mjs) precedent — a DO swap touches only the io-shell, never the pure core) and migrate ONLY the shared-truth artifacts #2626 classifies as such (the cleared-for-build queue #2613, the jury ledger #2641, infra-blocked #2659) — Durable Objects for single-writer lease/lane-arbitration, D1 for the queryable queue/history.

**Runner-lease split (Fork 1(b) of #2626).** The runner lease [`we:skills-src/conveyor/runner-lock.mjs`](../skills-src/conveyor/runner-lock.mjs) (#2702) is NOT a blind stay-local: split it. Its machine-local process singleton ("two runners on my laptop") stays a local lock forever; its cross-actor single-writer arbitration ("who may write the shared operational state") becomes a DO lease **iff and when** the product runs runners on more than one host. Single-host product keeps it fully local.

The other machine-local artifacts (advisory `we:.conveyor/*.lock`, `we:.claude/lane-ports.json`, the learnings drop-box) STAY local by nature and are out of scope.

**Why the three blockers, not just #2703.** #2703 only rewrites the conveyor skill doc (`we:skills-src/conveyor/SKILL.md`) and stands up the *same-machine* headless runner — that runner still shares the operator's filesystem, so it can co-read the gitignored `we:.conveyor/` sidecar and the store trigger has NOT fired. This build must therefore also wait on (a) **#2626** — the decision that authorizes and classifies the migration; an un-gate story can't be actionable before its own decision is ratified — and (b) **#2642** (the juror console, the concrete out-of-process product surface #2626 names; #2527 the build endpoint is the parent). Only when a surface that does NOT share the operator's filesystem must read/write conveyor operational state has the trigger genuinely fired. Until all three clear, the deferral holds and sidecars keep running — nobody has to remember to look; the `blockedBy` edges are the tripwire.

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: Phase 2; shared durable state store (DO/D1).
