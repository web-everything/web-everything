---
bornAs: xudbj78
kind: story
size: 8
status: open
scope: ["we:scripts/lib/process-registry.mjs", "we:scripts/conveyor/orphan-process-reaper.mjs", "we:scripts/conveyor/__tests__/orphan-process-reaper.test.mjs", "we:scripts/settings/orphan-reaper.json"]
dateOpened: "2026-10-20"
tags: []
---

# Orphan-process reaper: registry-based redesign (reap by recorded pid + start time only)

Live-caught 2026-10-20: 154 orphaned test keep-alives (up to 19 days, ~864 MB) plus orphaned vitest runners/fixtures; nothing reaps lost job processes. A first reaper (prior work, branch lane/orphan-reaper-b, we:scripts/conveyor/orphan-process-reaper.mjs) matched ps command lines against an allowlist and was parked after audit: command-line pattern matching cannot prove a process is ours. Redesign per draft architecture rule 3 (card xglhy4b, PR #5763: orphans reaped by recorded PID only): every spawner registers child pid + start time + owner (session/lease/job id) in a registry at spawn; the reaper signals only registry pids whose owner is provably gone, re-verifying pid + start time right before each signal; no command-line matching at all; unknown or unreadable registry/owner state never reaps. Keep dry-run default, cascade settings with logged sources, and log every reap.

## Acceptance

- [A1] **Executable** — `npx vitest run we:scripts/conveyor/__tests__/orphan-process-reaper.test.mjs` (through `we:scripts/readiness/heavy-admission.mjs run`): a real fake orphan whose pid + start time + owner were registered at spawn, and whose owner is then made provably gone, is SIGTERMed (then SIGKILLed if it ignores TERM) in apply mode and only listed in dry-run; an identical idle process that was never registered is never signalled. Fails before this item (no registry exists), passes after.
- [A2] Must: a registered pid whose recorded start time no longer matches the live process (pid reuse) is never signalled — proved by a test that recycles the identity between plan and signal.
- [A3] Must: an unreadable, torn or missing registry entry, or an owner whose liveness cannot be read, is never reaped (fail closed) — one test per case.
- [A4] Must: the reaper contains no command-line matching at all (no `ps` command text in any reap decision) — enforced by a test or check that fails if the decision path reads the command field.
- [A5] Must: dry-run stays the shipped default; settings resolve through we:scripts/lib/policy-cascade.mjs with logged sources; every signal sent is logged at the moment it is sent (pid, owner, age, reason).
- [A6] Live proof: a dry run on the operator's host lists only registry-owned orphans; before/after counts recorded.

## Non-goals

- [N1] Reaping processes that were never registered (the pre-existing 2026-10-20 orphans): cleared once by hand with operator OK; this item prevents and cleans up new ones only.
- [N2] Wiring into the health-watch daemon (we:scripts/conveyor/health-watch.mjs) until its open change (PR #5759) lands; ship the pass standalone first.

## Prior work

- Branch `lane/orphan-reaper-b` (we:scripts/conveyor/orphan-process-reaper.mjs, parked): the ps-allowlist design and its two audit verdicts. Reuse its cascade settings, cadence state, JSONL reap log and real-fake-orphan test harness; drop its signature matching.
- Branch `lane/keepalive-leak-a`: the anchored keep-alive helper (we:scripts/lib/test-keepalive.mjs), the natural first spawner to register its children.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — registry entries are data: parsed with a strict schema (integer pid > 1, non-empty start time, typed owner); anything else is a torn entry and never reaped.
2. **Truncated reads** — a registry file that does not parse fully is unknown, never "no entries"; the pass reaps nothing from it and logs it.
3. **Shared state files** — many spawners write concurrently: one file per entry (atomic write + rename), never a shared appended list; removal on clean child exit is best-effort and the reaper tolerates stale entries.
4. **Fail closed** — unknown owner liveness, unreadable registry, or a pid+start-time mismatch all mean never signal.
5. **Identity scoping** — identity is pid + start time (re-read immediately before each signal), owner is session/lease/job id; another user's process or the reaper's own pid is never signalled.
6. **State over time** — entries for exited children are pruned once the pid is gone or its start time differs; a host reboot invalidates every entry (start times differ).
7. **Who wrote it** — only our own spawner helpers write entries; the registry directory lives under the user's ~/.claude state with user-only permissions, and an entry not owned by this uid is ignored.
