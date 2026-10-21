---
bornAs: xv18rog
kind: story
size: 8
parent: "3383"
status: open
scope: ["we:scripts/lib/delivery-signals.mjs", "we:scripts/lib/delivery-signals-io.mjs", "we:scripts/lib/__tests__/delivery-signals.test.mjs", "we:scripts/lib/__tests__/delivery-signals-io.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Delivery signals snapshot: one read-only module computing the live signals a strategy decider reads

The strategy decider needs one consistent read-only snapshot instead of unrelated samples. Add a pure calculation module plus a thin JSON CLI/IO adapter with an injected clock. Measure the landing-ready PR queue from forge readiness labels and their timestamps, not the conveyor build-intent queue. Keep every unavailable or incomplete metric explicitly unknown with source, sample size and age; the snapshot makes no policy choice and performs no state repair.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/delivery-signals.test.mjs`: fixtures assert ready depth/oldest age; current main-red state, elapsed red minutes and completed-run red fraction over 24 hours; main-run coverage against enumerated main commits; PR CI p50/p90 and per-PR failure fraction; Actions queue wait; file-overlap fraction/hottest files; heavy holders/waiters; land-serialization estimate; and merges since a requested PR CI base plus intersecting merges. This fails before the module exists.
- [A2] Each metric returns value (null when unknown), unit, sample size, observedAt, age and unknown reason where applicable. Pin denominators and nearest-rank quantiles in tests: red fraction excludes cancelled runs; per-PR failure uses the latest completed attempt per PR/head in the window; overlap is the fraction of open PRs sharing at least one actual changed file. Separate unavailable flake attribution from total failures; do not classify failures as flakes without evidence.
- [A3] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/lib/__tests__/delivery-signals-io.test.mjs`: recording subprocess and filesystem seams prove paginated reads, no mutating forge/git calls, no sidecar writes or stale-lock reaping, and independent unknown results for failed, capped or malformed sources. Include a valid empty sample distinct from a failed read.
- [A4] `we node we:scripts/lib/delivery-signals-io.mjs --json` prints the entire versioned snapshot for the current repo, with diagnostics off stdout. Capture one live read during implementation and check every declared signal is present; unavailable coverage/flake history remains unknown rather than blocking the other signals.

## Non-goals

- [N1] No policy decisions, new daemon, queue repair, lock cleanup, CI reruns or labels.
- [N2] Do not fabricate the missing main-coverage CLI or require a future flake scorer; calculate from available raw evidence and expose unknowns.

## Edge cases this change must handle

1. **Untrusted text** — Repo/PR selectors are validated and argv-separated; filenames are opaque values, never shell fragments or regex patterns.
2. **Truncated reads** — Paginate Actions/PR/file/history reads and detect caps; an incomplete source invalidates its dependent metrics.
3. **Shared state files** — Read snapshots only; tolerate atomic replacement and report corrupt/racing reads as unknown. Avoid helpers that reap locks or append samples.
4. **Fail closed** — Unknown is null plus reason, never zero; a failed source does not erase independent valid measurements.
5. **Identity scoping** — Scope PRs/runs by repo and head, and the optional base comparison by exact CI base SHA; do not join by PR number alone.
6. **State over time** — Use one injected observation time and explicit windows; reject future timestamps/skew and distinguish stale samples from fresh emptiness.
7. **Who wrote it** — Trust authenticated run metadata and canonical local measurement sources, not PR prose claiming green status or readiness.

## Grounding

- we:scripts/conveyor/queue-store.mjs:4 identifies a session-local build-intent queue; line 72 tolerantly parses bad input as empty, unsuitable as evidence of a healthy landing queue.
- we:scripts/conveyor/ci-queue-watch.mjs:34 documents queue-wait samples; line 39 describes mutating hung-job recovery that the snapshot must not invoke.
- we:scripts/readiness/overlap-chain.mjs:60 normalizes file sets for stacking; it is not an open-PR overlap measurement service.
- we:scripts/readiness/conveyor-instrument.mjs:136 computes landSerialization from ready/merge times and poll cadence, so expose it as an estimate.
- we:scripts/readiness/heavy-admission.mjs:1514 exposes admissionStatus; line 1520 computes stale waiters with apply:false. Keep that read-only behavior when collecting host-slot signals.

Size 8: one snapshot core and IO/CLI with two test files, but multiple independent data adapters and completeness contracts.
