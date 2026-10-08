---
kind: story
size: 5
parent: "5399"
status: open
blockedBy: ["xdeqs8k", "x251p1l"]
scope: ["we:scripts/backlog/", "we:backlog/"]
scopeRationale: "the refresh rewrites many open backlog cards (about 50 per PR) and adds a new runner under scripts/backlog whose file name is not fixed yet"
dateOpened: "2026-10-08"
tags: []
---

# Task agreement S2: one-off refresh writes draft Acceptance and Non-goals into open stories, about 50 per PR

Slice S2 of #5399 (ruled 2026-10-08, Fork 1 = both): a refresh runner writes `## Acceptance` and `## Non-goals` with [A#]/[N#] ids into open stories, nearest-to-build first, about 50 cards per PR, every section marked draft until the preparer confirms it. Sonnet writes, Haiku 5.5 checks the shape. Skips active, PR-held and already-agreed cards; resolved cards never touched. Ruled by the operator on 2026-10-08 (see `## Ruling` on #5399).

## Acceptance

- [A1] **Executable** — a refresh-runner test shows: a card with `## Done when` gets it renamed to `## Acceptance` with `[A#]` ids and unchanged meaning; an `active`, PR-held or already-agreed card is skipped; a resolved card is never read for writing.
- [A2] **Executable** — the shape check refuses a section with a TODO line, a missing id, or a bare `none`, sends it back once, and leaves the card untouched and logged on a second failure.
- [A3] **Observable** — every open story the refresh processed has both sections with ids and a draft marker the S1 reader reports, landed in PRs of about 50 cards each through `open-pr`, nearest-to-build first.
- [A4] **Executable** — a refresh-runner test with an injected free-scope check shows the ownership check runs again immediately before each card is written, not only when the batch is planned: a card that was free at plan time but is claimed by an open PR, or falls under a registered scope, before its write is skipped, left byte-identical and logged with the reason; a card whose ownership did not change is still written; a check that errors or times out skips the card (fail closed), never writes it.

## Non-goals

- [N1] Treating a refreshed section as agreed: it stays draft until the preparer confirms it.
- [N2] Touching resolved cards.
- [N3] Running before S7 lands (a card switched to `## Acceptance` must keep the provenance escape and Must-cite check).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — skip any card held by an open PR or a registered scope (the free-scope check) at write time, not only at plan time (tested by [A4]: ownership changes between plan and write, a registered scope, and a failing check).
4. **Fail closed** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
7. **Who wrote it** — sections are marked draft so the S4 gate never mistakes model-written criteria for the preparer's agreement.
