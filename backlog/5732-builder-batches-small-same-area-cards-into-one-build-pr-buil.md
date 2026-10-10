---
bornAs: xfyhz2z
kind: story
size: 8
priority: high
parent: "4376"
status: open
scope: ["we:skills-src/conveyor/build-dispatch-daemon.mjs", "we:scripts/conveyor/tick-core.mjs", "we:scripts/lib/delivery-platform-preferences.json"]
dateOpened: "2026-10-10"
tags: []
---

# Builder batches small same-area cards into one build PR (builder.batchBuild)

Step 2 of the operator's PR-count reduction (2026-10-10; step 1 = card-only filings into one rolling PR, epic #4703). The build daemon dispatches one lane and one PR per card, so several tiny cards that touch the same files or subsystem each pay a lane, a verify, a PR CI run, review rounds and a drain landing. Add a builder.batchBuild setting (policy cascade: standard default, platform preference in we:scripts/lib/delivery-platform-preferences.json, repo override, env; log the source layer). When on, the dispatcher groups ready cards of at most 5 points that share files or a subsystem (scope overlap or the same parent) into ONE build lane and ONE PR, and every card in the group is resolved in that PR with its own commit. A group never mixes repos, never exceeds a size cap, and a card whose build fails is split out to its own retry instead of failing the group. Operator-initiated builds and cards marked to build alone keep one PR each.

## Acceptance

- [A1] **Executable** — `npm run test:unit -- <test>` over we:skills-src/conveyor/__tests__/build-dispatch-daemon.test.mjs (strip the `we:` prefix to execute) passes with new cases: three ready 2-point cards sharing a scope file are dispatched as ONE lane and ONE PR with three commits, each card resolved; with `builder.batchBuild` off they are three lanes.
- [A2] **Must (refuse on error)** — a group never mixes repos, never holds a card over 5 points or a group over the size cap, and a card whose build or review fails is split out to its own retry while the rest of the group still lands.
- [A3] **Must** — the effective setting and the layer that set it are logged once per dispatch pass; an invalid value falls through to the layer below.
- [A4] **Live proof** — the next dispatch window lands at least one real multi-card build PR; record the PR and its member cards here.

## Non-goals

- [N1] Card-only filings and prepares: those batch through the card batch (epic #4703), not the builder.
- [N2] Cross-repo groups.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — card titles and scope lists go into branch names and PR bodies only through the existing machine title and body renderers.
2. **Truncated reads** — an unreadable card or scope list excludes that card from grouping; it builds alone.
3. **Shared state files** — group membership is recorded in the existing dispatch state under its lock; two ticks never claim the same card into two groups.
4. **Fail closed** — any doubt about overlap or size means the card builds alone (today's path).
5. **Identity scoping** — groups are keyed by repo; a card's claim names the group lane so ownership checks still pass.
6. **State over time** — a card that becomes blocked or resolved after grouping is dropped from the group before the lane starts.
7. **Who wrote it** — only conveyor-dispatched cards are grouped; operator-initiated builds always build alone.
