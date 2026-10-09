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
- [A2] **Executable** — the shape check refuses a section with a TODO line, a missing id, a bare `none`, or a missing or altered draft-marker line, sends it back once, and leaves the card untouched and logged on a second failure.
- [A5] **Executable** — a refresh-runner test shows the runner's code inserts the visible `Draft: model-written, not yet confirmed.` line as the first non-blank line under every section it writes, after the model output: model output that omits the marker, or that carries a different or hand-edited marker, still lands with the exact marker line, and a section whose marker is missing at the final shape check is refused, never written as agreed. The model is never trusted to write the marker.
- [A3] **Observable** — every open story the refresh processed has both sections with ids and the visible `Draft: model-written, not yet confirmed.` line (never an HTML comment) that the S1 reader reports even after comment stripping, landed in PRs of about 50 cards each through `open-pr`, nearest-to-build first.
- [A4] **Executable** — a refresh-runner test with an injected free-scope check shows the ownership check runs again immediately before each card is written, not only when the batch is planned: a card that was free at plan time but is claimed by an open PR, or falls under a registered scope, before its write is skipped, left byte-identical and logged with the reason; a card whose ownership did not change is still written; a check that errors or times out skips the card (fail closed), never writes it.
- [A6] **Executable** — a refresh-runner test shows card text reaches the model only as quoted data, never as instructions: the prompt wraps the card body in a fence the card text cannot close (a card that contains the fence string, a line starting `Ignore the above`, or a backtick run longer than the fence is still inside the data block), the instruction text sits outside that block, and no card text is ever put into argv or a file path.
- [A7] **Executable** — a refresh-runner test shows the model output is shape-checked before anything is written: the only accepted content is `## Acceptance` and `## Non-goals` sections whose items are `[A#]` / `[N#]` lines, with a cap on item count, item length and total output length. Output with any other heading, any text outside those sections, extra sections, front matter, code fences, links or HTML, or that exceeds a cap, is rejected whole: the card stays byte-identical and the rejection is logged with the card and the reason. A card whose model output injects a new heading or an instruction line is one such rejected case.

## Non-goals

- [N1] Treating a refreshed section as agreed: it stays draft until the preparer confirms it.
- [N2] Touching resolved cards.
- [N3] Running before S7 lands (a card switched to `## Acceptance` must keep the provenance escape and Must-cite check).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the runner feeds committed card text to a model and commits the model's output, so this is a live case. Card text goes to the model as quoted data, never as instructions ([A6]); the output is shape-checked to only `## Acceptance` / `## Non-goals` sections of `[A#]` / `[N#]` items under length caps, and anything else is rejected whole and logged ([A7]).
2. **Truncated reads** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
3. **Shared state files** — skip any card held by an open PR or a registered scope (the free-scope check) at write time, not only at plan time (tested by [A4]: ownership changes between plan and write, a registered scope, and a failing check).
4. **Fail closed** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
5. **Identity scoping** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
6. **State over time** — n/a: this slice opens no new case of this class; its inputs are committed card text and code.
7. **Who wrote it** — sections are marked draft so the S4 gate never mistakes model-written criteria for the preparer's agreement. The marker is inserted by the runner's code, not by the model, so a model that forgets it cannot produce a section that reads as agreed (tested by [A5]).
