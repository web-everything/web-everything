---
bornAs: xt8j3yk
kind: story
size: 5
parent: "3383"
status: open
dateOpened: "2026-09-23"
tags: []
scope: ["we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/__tests__/daemon-self-sync.test.mjs", "we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs", "we:docs/agent/platform-decisions.md"]
---

# Every daemon restarts when its clone's input heads moved since boot, with a 5-minute floor

Sibling-moved clone detection and restart deferral already exist, but the code intentionally compares imported-file changes from boot HEAD and defaults to two minutes, while the standing lifecycle rule requires per-repository input heads and five minutes. Complete this card only after reconciling that contract conflict. The proposed implementation retains import-aware suppression of irrelevant changes while tracking adopted input identity and a five-minute normal restart floor; this is a proposal for the open question, not a silent override of the standing rule. Size 5 covers identity tracking, restart integration, tests and codification after the choice.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/daemon-self-sync.test.mjs`: add a default-policy regression asserting no ordinary imported-code restart at uptime 299999 ms and a restart at 300000 ms without an interval override. This fails against the current two-minute default; it is conditional on retaining the standing five-minute floor.
- [A2] Capture the adopted input identity at process boot for every repository supplying loaded code: main input SHA and ordered active overlay heads, distinct from a transient candidate or synthetic merge HEAD. A sibling adoption changing a loaded dependency is detected without this daemon being the mover. Read failures produce a named unsafe/unknown outcome, never an equal-input verdict.
- [A3] A rebuild with identical input heads and different synthetic merge HEAD does not loop; a real imported dependency change remains pending through the floor and causes one clean exit between ticks. Tests cover overlay addition/removal/reordering, cross-repository imports and a source update during the defer window.
- [A4] Keep last-good smoke/quarantine and tick locks intact: never restart onto an unadopted candidate, never terminate a running tick, and never treat a new checkout HEAD as proof that its inputs were accepted. Test the existing urgent stale-main and unknown-diff paths explicitly against the policy selected below.
- [A5] Update the lifecycle clause and implementation comments together only after the human choice. Preserve the existing sibling-move and irrelevant-backlog-change regressions unless the chosen policy explicitly replaces the latter.

## Non-goals

- [N1] No new self-updater, clone reset, smoke-gate bypass, overlay selection policy or heartbeat telemetry (#4051).
- [N2] No production daemon restart during preparation or test execution.

## Edge cases this change must handle

1. **Untrusted text** — Validate repository identities, overlay refs and SHA values; pass Git arguments structurally and never execute input-state text.
2. **Truncated reads** — Incomplete Git diffs/input metadata yield unknown evidence; do not suppress a restart by treating a failed read as an empty diff.
3. **Shared state files** — Read adopted input metadata under the existing clone/version synchronization; compare a coherent snapshot and do not create a competing overlay state store.
4. **Fail closed** — Unknown adoption/quarantine state never authorizes running new code. Explicitly test emergency restart policy rather than accidentally bypassing the floor.
5. **Identity scoping** — Bind boot identity to process incarnation and each loaded-code repository, not just cwd or whichever daemon last rebuilt the clone.
6. **State over time** — Use elapsed process uptime for the floor, retain pending changes across ticks, and distinguish identical-input rebuilds from genuine adoption changes.
7. **Who wrote it** — Only the rebuild/adoption path establishes accepted inputs; arbitrary HEAD changes or overlay-list prose are not smoke approval.

## Grounding

- we:docs/agent/platform-decisions.md:5716 requires per-repository input comparison and :5720 specifies the five-minute restart floor.
- we:scripts/lib/daemon-self-sync.mjs:438 documents the two-minute default; :471 implements import-aware restart decisions, with unknown diffs bypassing deferral at :472.
- we:scripts/lib/daemon-self-sync.mjs:727 captures bootSha, :752 creates the restart gate and :1057 detects a HEAD moved since this process booted.
- we:scripts/lib/__tests__/daemon-self-sync.test.mjs:1000 deliberately suppresses restarts for backlog-only changes; :1026 tests deferred adoption of a sibling-moved clone.
- we:scripts/lib/daemon-rebuild.mjs:95 documents persisted adopted/rejected input identities, the existing substrate to reuse rather than inventing a second input ledger.

## Open questions

Which restart policy should govern: (a) literal restart on every adopted input change after five minutes, including docs-only updates, or (b) import-aware restart on adopted input changes with a five-minute normal floor and explicitly documented urgent/unknown exceptions? **Pick (b)** because the current code and tests deliberately prevent irrelevant changes from starving ticks; (a) matches the existing statute literally but reverses that behavior. The human must settle the clause and emergency exceptions before implementation. No ruling is made here.
