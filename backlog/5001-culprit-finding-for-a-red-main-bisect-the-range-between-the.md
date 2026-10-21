---
bornAs: xmje9g6
kind: story
size: 8
parent: "3383"
status: open
scope: ["we:scripts/conveyor/main-red-culprit.mjs", "we:scripts/conveyor/main-red-culprit-io.mjs", "we:scripts/conveyor/__tests__/main-red-culprit.test.mjs", "we:scripts/conveyor/__tests__/main-red-culprit-io.test.mjs", "we:scripts/conveyor/__tests__/fixtures/main-red-culprit-2026-10-03.json", "we:.github/workflows/ci.yml"]
dateOpened: "2026-10-03"
tags: []
---

# Culprit finding for a red main: bisect the range between the last green and first red completed main run

Main-red recovery classifies red windows but does not identify the first bad merge. Add a pure bisection planner and a bounded Actions shell: pin the last completed green and first completed red main SHAs, rerun the failing job at the red SHA once, then test first-parent midpoints on owned temporary refs. Report an evidence-backed culprit or an inconclusive/flake-suspected result; hand that report to the drain-owned recovery path without reverting. The predecessor #5000 is resolved, but its coverage CLI is absent in this checkout: read completed run history directly rather than depend on that missing CLI.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/main-red-culprit.test.mjs`: add fixtures for one/many merges, a passing first-red rerun, a reproducible first bad merge, cancelled probes, missing green and a non-ancestor range. Assert exact next probe SHA and terminal evidence; this fails before the new planner exists.
- [A2] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/main-red-culprit-io.test.mjs`: exercise the real shell with recording git/forge shims. Dispatch only the selected failing job and necessary prerequisites through an allowlisted workflow input; ordinary CI events retain their full gates. Never push main, merge, revert, or run arbitrary supplied commands. Bound each wait and total probes; exhausted budgets return inconclusive.
- [A3] Persist repo, workflow/job identity, range SHAs, probe run IDs/attempts and outcomes under an incident key. Resume without duplicate dispatch; clean up only refs owned by that incident. A culprit report names the merge SHA, associated PR when verified (otherwise null), evidence and confidence basis; one passing rerun means flake-suspected, never proof of harmlessness.
- [A4] Replay the 2026-10-03 range `8ea816283..915c69d3b` with recorded run/job evidence in the fixture. During implementation obtain a real bounded dispatch trace naming those SHAs; if historical objects/runs are unavailable, report that limitation and demonstrate the same path on an available controlled range. Do not invent a historical culprit.

## Non-goals

- [N1] No automatic revert, new main writer, or replacement of PR recovery.
- [N2] No general flake classifier or arbitrary workflow execution.

## Edge cases this change must handle

1. **Untrusted text** — Validate repo, full resolved SHAs and allowlisted job/input names; pass argv arrays, never interpolate PR titles or logs into a shell.
2. **Truncated reads** — Paginate run and PR association reads; capped, truncated or failed git/forge output is incomplete evidence, never an empty range.
3. **Shared state files** — Lock incident read-modify-write and atomically replace its journal; re-read before dispatch and bind temporary refs to incident ownership.
4. **Fail closed** — Unknown, cancelled, timed-out or mismatched runs stop bisection with an explicit inconclusive reason; no revert authorization follows.
5. **Identity scoping** — Key by repo, workflow/job, green/red SHAs and incident; verify returned run SHA and attempt before accepting it.
6. **State over time** — Freeze the range across moving main; resume outstanding probes after restart and refuse stale or contradictory evidence.
7. **Who wrote it** — Use authenticated forge run metadata and owned temporary refs; PR text or a similarly named job cannot attest a result.

## Grounding

- we:scripts/conveyor/main-red-recovery.mjs:24 describes the existing pure red-window core; line 157 exposes current-red classification, not bisection.
- we:.github/workflows/ci.yml:53 permits workflow dispatch without a job-selection input; line 59 preserves main runs while cancelling superseded non-main runs.
- we:docs/agent/platform-decisions.md:6094 lists the sole-main-writer invariant; the new shell produces diagnosis only.

Size 8: new planner, bounded Actions IO, workflow selection and replay fixtures form one substantial incident-diagnosis path.
