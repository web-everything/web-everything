---
bornAs: x9xkupj
kind: story
size: 5
priority: high
parent: "5712"
status: open
scope: ["we:scripts/conveyor/load-flake-reverify.mjs", "we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs", "we:scripts/lib/daemon-live-smoke.mjs", "we:scripts/lib/__tests__/daemon-live-smoke.test.mjs", "we:scripts/lib/daemon-rebuild/smoke.mjs", "we:scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs", "we:skills-src/conveyor/daemon-manifest.mjs", "we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs", "we:scripts/conveyor/resource-sampler-daemon.mjs", "we:scripts/conveyor/__tests__/resource-sampler-daemon.test.mjs"]
dateOpened: "2026-10-09"
tags: []
---

# Resource service slice 2: cut load-flake re-arm and daemon rebuild smoke over to admit()

The load-flake and smoke admission cutover is already present, including high-load tests and rollback behavior. Finish the remaining managed-sampler registration and end-to-end proof, preserving the distinction between resource admission and smoke failure attribution: an unavailable sampler cannot itself excuse a failed smoke. Keep old load calculations as comparisons/explicit fallback, and retain the same-run differential before blaming an overlay. #5713 is resolved; no dependency edge is needed.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:skills-src/conveyor/__tests__/daemon-manifest.test.mjs we:scripts/conveyor/__tests__/resource-sampler-daemon.test.mjs`: add a managed resource-sampler supervisor entry and a launch-contract test through the manifest. It fails while that entry is absent. Verify singleton/job recovery and that restarting the launcher does not create two active samplers; register the supervisor, not its resident job as a periodic independent pass.
- [A2] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs we:scripts/lib/__tests__/daemon-live-smoke.test.mjs`: retain the already-present high-load/admit and quiet-load/hold regressions, log the actual verdict and kind, cover shadow disabled and explicit rollback. Missing/stale admission holds re-arm without writes; smoke unknown/error retains its established conservative fallback rather than treating unknown as proof of environmental failure.
- [A3] `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/daemon-rebuild.test.mjs`: pin that resource admission permits running a smoke, never adopting a failed tree. A load-shaped failure still uses the candidate/plain-main differential and backoff; source, docs, config and data failures cannot be waived just because load is high.
- [A4] Capture a real reverify pass and rebuild smoke with load above 9, CPU idle above their configured floors and fresh snapshots; each proceeds and logs its admit verdict. Include sampler identity, snapshot age, relevant thresholds and actual outcomes. If those host conditions are unavailable, record the missing live proof rather than manufacturing load or claiming fixture output as live evidence.

## Non-goals

- [N1] No slice-4 removal of legacy comparison/fallback, threshold retuning, or changes to unrelated dispatch gates.
- [N2] No bypass of smoke success, overlay differential or PR review authority.

## Edge cases this change must handle

1. **Untrusted text** — Keep PR/log text as data; verdict reasons cannot become commands or override flags.
2. **Truncated reads** — Incomplete sampler JSON is unknown; failed/truncated smoke or forge reads remain failures, not permission to re-arm.
3. **Shared state files** — Reuse sampler snapshot and job ownership/lease mechanisms; prevent duplicate supervisors from racing updates.
4. **Fail closed** — Missing/stale data cannot release re-arm. Unknown host state cannot by itself excuse smoke failures or adopt an unproven tree.
5. **Identity scoping** — Scope sampler to host/coordination root, re-arm to repo/PR/head, and smoke proof to candidate tree and harness.
6. **State over time** — Re-read freshness at action time; restart reuses/reconciles sampler jobs and respects backoff and explicit rollback.
7. **Who wrote it** — Only the managed sampler provides resource evidence; preserve existing provenance checks on PR holds and smoke outputs. No new HTTP receive endpoint is introduced.

## Grounding

- we:scripts/conveyor/load-flake-reverify.mjs:307 already resolves load-flake-rearm admission and respects cutover mode at line 311.
- we:scripts/conveyor/__tests__/load-flake-reverify.test.mjs:442 covers high-load admission; line 458 covers wait/unknown without writes.
- we:scripts/lib/daemon-live-smoke.mjs:179 reads admission with fallback; line 318 preserves legacy busy classification for unknown snapshots.
- we:scripts/lib/__tests__/daemon-live-smoke.test.mjs:94 explicitly protects unknown-data fallback from laundering a hung probe into a skip.
- we:scripts/lib/daemon-rebuild/smoke-classify/load-shaped.mjs:47 classifies failed rows; we:scripts/lib/daemon-rebuild/smoke.mjs:54 requires a full successful table for durable proof.
- we:scripts/conveyor/resource-sampler-daemon.mjs:15 registers the resource-sample job; we:skills-src/conveyor/daemon-manifest.mjs:16 documents resident-singleton defaultLaunch handling. No resource-sampler entry is present in that manifest.
- Commit `0cfeb71887` implements the resource slice-2 cutover; remaining work must preserve its existing behavior.

Size 5: retain the existing cutover and finish managed-supervisor wiring plus focused integration and live evidence.
