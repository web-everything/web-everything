---
bornAs: xk7by6p
kind: story
size: 8
parent: "3383"
status: open
dateOpened: "2026-09-23"
tags: []
scope: ["we:scripts/lane-pool.mjs", "we:scripts/lib/lane-lease.mjs", "we:scripts/__tests__/lane-pool-plan-step.test.mjs", "we:scripts/lib/__tests__/lane-lease.test.mjs", "we:scripts/lane-resume.mjs", "we:scripts/__tests__/lane-resume.test.mjs", "we:skills-src/finish/SKILL.md", "we:scripts/conveyor/lease-reaper.mjs", "we:scripts/conveyor/__tests__/lease-reaper.test.mjs", "we:scripts/readiness/conveyor-state.mjs", "we:scripts/readiness/__tests__/conveyor-state.test.mjs", "we:scripts/readiness/scope-lease-collect.mjs", "we:scripts/readiness/__tests__/scope-lease-collect.test.mjs", "we:scripts/readiness/dispatch-plan.mjs", "we:scripts/readiness/__tests__/dispatch-plan.test.mjs"]
---

# Planner build: step lanes from the shared pool (plan-step lease, local base, ceiling)

The shared pool leases ordinary lanes and accepts a base ref, but has no plan-step lease contract. Add a typed step lease linked to its parent build and fetch the parent lane’s pinned committed tip directly from its local repository. Carry that identity through collectors and admission, exclude step leases from item-delivery recovery, and count one running step against the parent build’s existing slot while additional simultaneous steps consume additional capacity. Size 8 reflects lease/acquire changes plus the finish, reaper, health and capacity consumers and their tests; no separate step-lane pool is needed.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/__tests__/lane-pool-plan-step.test.mjs`: add this new subprocess test using temporary parent/step repositories and a recording remote shim. Acquire a step lane from an unpushed parent commit; assert exact destination SHA, parent/step/holder metadata, unchanged parent worktree and zero push calls. The current acquire/lease contract does not produce the required marker.
- [A2] Require parent repository, item identifier, build session, step identifier and committed source SHA together for a step acquisition. Resolve the local source to the intended parent lease, reject source=destination, foreign parent ownership, missing commits or invalid combinations, and clean up only the newly acquired lease after fetch failure. Ordinary acquisition remains compatible.
- [A3] The finish discovery/open path, lease reaper and stalled-item scan recognize step leases before interpreting their parent item/session as an independent deliverable. They neither open step PRs nor resolve/reap a live step because its parent item changed state. The parent build owns step release; abandoned steps retain ordinary owner/TTL evidence checks and dirty/unpushed-work protection.
- [A4] Preserve step metadata through scope-lease collection. Admission at cap C counts a parent plus one active step as one build slot, and each additional simultaneous step as one more; two concurrent admissions cannot both consume the same inherited slot. Tests cover cap=1 progress, a second step waiting, unrelated builds, parent termination, missing parent evidence and release/retry.
- [A5] Run the affected lease, finish, reaper, collector, conveyor-state and dispatch-plan tests through the heavy queue. Include a non-step lane in each fixture to show that only typed step leases gain the exclusion; no session-name heuristic grants it.

## Non-goals

- [N1] No plan schema/router, planner/checker prompts, step execution or verdict-before-commit implementation; those remain separate planner slices.
- [N2] No push of the parent tip, separate pool, exemption from file-scope conflicts, or general concurrency-cap increase.

## Edge cases this change must handle

1. **Untrusted text** — Validate IDs and source paths, use argv arrays with option boundaries and disable unsafe local Git hooks/config; a path or step name cannot become a flag.
2. **Truncated reads** — Failed/truncated source SHA, lease or pool reads refuse acquisition/admission; never substitute origin/main or an empty pool.
3. **Shared state files** — Use existing atomic lease acquisition and holder checks; reserve inherited capacity under the same admission serialization as other slots.
4. **Fail closed** — Unknown parent ownership, failed local fetch or missing step metadata refuses without resetting the source or freeing a foreign lease.
5. **Identity scoping** — Bind repo, parent item (numeric or hash), build session, step and minted holder; identical step names in different builds cannot share capacity or cleanup rights.
6. **State over time** — Pin the committed source before fetch; cover parent movement, restart after lease creation, parent death, stale step leases and retried admission without double counting.
7. **Who wrote it** — Only validated lease metadata from the owning build grants step treatment; branch names, PR text and arbitrary purpose strings do not.

## Grounding

- we:scripts/lib/lane-lease.mjs:178 defines leaseBody without a plan-step identity; :194 carries workerSession and :197 predicted scope.
- we:scripts/lane-pool.mjs:1932 chooses a base ref before checkout; its documented acquire flags at :32 expose base but not a local-source/step contract.
- we:scripts/readiness/dispatch-plan.mjs:462 reduces active leases to lane/scope and :469 counts all active leases; parent/step slot accounting is not present.
- we:scripts/conveyor/lease-reaper.mjs:628 resolves item identity from a lease session; :714 begins general lease classification, so typed exclusions must precede item assumptions.
- we:scripts/readiness/conveyor-state.mjs:448 begins assessHealth; we:scripts/lane-resume.mjs:918 collects prMissing entries and we:skills-src/finish/SKILL.md:107 tells finish to open completed deliveries.
- we:backlog/3922-decision-the-planner-build-g2-a-planner-splits-a-build-into.md:5 is resolved; the pool contract can be implemented/tested independently of the unbuilt planner runner. The plan-step test file is new.
