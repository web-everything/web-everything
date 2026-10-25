---
bornAs: xz13po8
kind: story
size: 5
parent: "3383"
relatedTo: ["3562"]
status: open
dateOpened: "2026-09-07"
tags: [conveyor, prepare, readiness]
scope: ["we:scripts/conveyor/scope-prep-docket-watch.mjs", "we:scripts/conveyor/__tests__/scope-prep-docket-watch.test.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/conveyor/__tests__/tick-core.test.mjs", "we:skills-src/conveyor/runner.mjs", "we:skills-src/conveyor/__tests__/runner-pass-coverage.test.mjs"]
---

# Generalize the leverage-ranked auto-prepare docket pass beyond decisions to unscoped, ready-to-prepare build items

Add a standing backlog-wide scope-preparation pass for open, unscoped build items whose prerequisites are resolved. Rank by the existing leverageScore, take the top N and feed the existing prepare admission/guard machinery; do not create a second dispatcher. Use leverageScore as the concrete ranking approach requested by this card, with stable item-ID tie breaking. Size 5 covers the selector/IO pass, shared prepare-state integration and the runner subprocess caller/tests; it does not depend on decision-board publication.

## Done when

Commands use the Bash helper `we() { command "${@#we:}"; }` to strip repository prefixes from arguments.

- [A1] **Executable** — `we node we:scripts/readiness/heavy-admission.mjs run -- npx vitest run we:scripts/conveyor/__tests__/scope-prep-docket-watch.test.mjs` — the new suite fails until the pass exists; fixtures include eligible items outside the current queue, resolved/active/decision/blocked/scoped items, hash IDs and tied scores. Assert the exact ranked top N of the eligible population and no mutation in dry-run.
- [A2] Reuse planPrepareSpawns and retirePrepareGuards with the same persisted guards, active lanes, held items and open PRs as normal preparation. Two ticks, concurrent pass attempts and a restart must not launch a duplicate prepare for the same item; capacity and pause gates still win.
- [A3] Export DEFAULT_SCOPE_PREP_DOCKET_TARGET_COUNT = 5; a valid nonnegative integer WE_SCOPE_PREP_DOCKET_TARGET_COUNT overrides it, zero dispatches none, invalid values refuse. Presence of WE_SCOPE_PREP_DOCKET_WATCH_DISABLED makes the entry point return before reads or dispatch.
- [A4] Wire the pass once into makeCliMechanicalPasses with bounded subprocess execution and a runner test asserting its argv. A failed backlog/PR/guard read is a named skipped pass, never an empty healthy queue. No new daemon or cron is needed.

## Non-goals

- [N1] No change to leverageScore, provider selection, decision preparation, decision-board rendering or existing readiness rules.
- [N2] No auto-resolution, status changes or new grant of build authority; preparing scope does not itself make an item ready to build.

## Edge cases this change must handle

1. **Untrusted text** — Use loader-validated IDs and repo-relative paths; titles are display data and never shell fragments or regexes.
2. **Truncated reads** — Load the complete backlog and PR/guard set; a partial read or saturated subprocess output invalidates the ranking rather than hiding competing work.
3. **Shared state files** — Reuse the conveyor’s durable prepare guards and atomic/locked updates; do not persist an independent duplicate-suppression ledger.
4. **Fail closed** — Unreadable dependency/readiness state cannot make an item eligible; an invalid override refuses rather than silently increasing work.
5. **Identity scoping** — Normalize hash and numbered IDs through existing preparation logic; guards include repo/item and owned lane/session.
6. **State over time** — Re-evaluate scope/status/blockers before dispatch; suppress live guards/open PRs across ticks and retire through existing TTL rules.
7. **Who wrote it** — Card prose cannot authorize dispatch or bypass a hold; use validated metadata and the existing dispatcher policy.

## Grounding

- we:src/_data/backlog.js:712 computes unblocksToReady separately; :718 defines the leverageScore reused here.
- we:scripts/conveyor/tick-core.mjs:647 exposes generic preparation planning; :669–675 enforce pause, hold, guard, PR and lane gates; :686 currently maps unshaped items to the prepare launch kind.
- we:scripts/conveyor/tick-core.mjs:598 owns guard retirement; do not implement a second lifecycle.
- we:skills-src/conveyor/runner.mjs:304 defines makeCliMechanicalPasses and :314 starts its subprocess wrapper.
- Shipped check: no scope-prep-docket-watch module is present in this checkout; history contains merge d70593bf0d with a scope-prep-docket branch name, which alone does not establish a current implementation.
