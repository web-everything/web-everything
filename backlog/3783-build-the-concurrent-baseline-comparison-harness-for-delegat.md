---
bornAs: xoiscdi
kind: story
size: 8
parent: "3718"
status: open
dateOpened: "2026-09-20"
tags: []
scope: ["we:scripts/conveyor/concurrent-baseline-comparison.mjs", "we:scripts/conveyor/__tests__/concurrent-baseline-comparison.test.mjs", "we:scripts/conveyor/log-delegation-trial.mjs", "we:scripts/conveyor/__tests__/log-delegation-trial.test.mjs", "we:scripts/conveyor/run-scorecard-store.mjs", "we:scripts/conveyor/__tests__/run-scorecard-store.test.mjs", "we:scripts/operations/minimal-context-provider.mjs", "we:scripts/lib/judge-spawn.mjs"]
---

# Build the concurrent-baseline comparison harness for delegation trials — run the same task through Claude and the delegated provider and judge the difference

The comparison recorder and delegated-provider selector already exist, but the module requires an already-produced Claude result and already-judged outcomes. Finish the actual paired-run harness: pin one task/base, run both providers in isolated lanes, capture both artifacts, invoke independent judgment and publish a complete linked comparison through the existing scorecard store. Reuse existing launch and judge adapters. Size 8 covers orchestration, pair persistence and tests; recording paired outcomes alone does not satisfy the original same-task concurrent execution requirement.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/concurrent-baseline-comparison.test.mjs` — add an injected-provider test that starts both sides before either finishes, gives both the identical pinned base and task, captures separate diffs, judges each and records one linked pair. It fails against the current recorder-only API. A temporary-repository subprocess fixture must verify isolated writes and unchanged source checkout.
- [A2] Validate the whole pair before publishing either success row. Store repo/base/task identity, provider/model/session identities, artifact hashes and judge provenance; exactly two complete compatible rows share a comparison ID. A timeout, malformed diff, invalid second side or failed judge records an incomplete/failed attempt, never two clean trials.
- [A3] Persist pair completion atomically or with an explicit durable completion record under the existing store lock; retry after interruption cannot duplicate a side. Readers can distinguish complete evidence from orphaned rows. Use resolveScorecardStorePath rather than resurrecting the legacy in-tree JSON file.
- [A4] Retain existing comparison outcomes and legacy unpaired records. Demonstrate one sandbox paired run through real provider launch and judge boundaries with recorded commands/artifacts before calling the harness operational; mocked tests alone establish only orchestration behavior.

## Non-goals

- [N1] No new promotion threshold, automatic graduation, supervision reduction or claim of statistical significance from a single pair.
- [N2] No automatic commit, push, merge or production-task double execution; run trial work in disposable isolated lanes.

## Edge cases this change must handle

1. **Untrusted text** — Task text, provider output and findings are untrusted data; use argv-safe adapters, bounded artifacts and the existing secret scrub before persistence.
2. **Truncated reads** — Truncated diffs or provider/judge output invalidate the trial; never score a partial read as clean or fabricate absent evidence.
3. **Shared state files** — Use the shared scorecard lock and atomic write for complete-pair publication; concurrent trials cannot overwrite or interleave a falsely complete pair.
4. **Fail closed** — Invalid second-side input, timeout or judge failure cannot leave a successful comparison; preserve a visible incomplete attempt for diagnosis.
5. **Identity scoping** — Bind comparison ID to repo, pinned base, task/item (hash or numeric), both sessions and exact provider/model/taskType triples.
6. **State over time** — Retries reuse durable attempt identity; restart recovers incomplete pairs, rejects mismatched bases and never duplicates completed rows.
7. **Who wrote it** — Judge provenance comes from the independent judge invocation, not provider-supplied verifiedBy text; trial output grants no authority.

## Grounding

- we:scripts/conveyor/concurrent-baseline-comparison.mjs:15–30 explicitly excludes Claude dispatch and judgment from the current module; :175 dispatches only the delegated side.
- we:scripts/conveyor/concurrent-baseline-comparison.mjs:124 records a supplied pair; :161–162 append its two rows separately.
- we:scripts/conveyor/__tests__/concurrent-baseline-comparison.test.mjs:62 checks linked rows from supplied outcomes, not a concurrent launch.
- we:scripts/conveyor/run-scorecard-store.mjs:74 resolves the out-of-tree state store; :337 exposes appendScorecard.
- we:scripts/operations/deliver-item-wrapper.mjs:159 reuses launch helpers from minimal-context-provider, so the old claim that Claude cannot be launched from scripts must not constrain this implementation.
- we:docs/agent/platform-decisions.md#delegation-trial-record-graduation governs evidence and authority; no bar is re-ratified here. History e75658a230 migrated this existing comparison recorder to the shared store.
