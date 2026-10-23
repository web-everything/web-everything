---
bornAs: xmcukjn
kind: story
size: 5
parent: "6753"
status: open
scope: ["we:scripts/lib/red-team-gate.mjs", "we:scripts/operations/extend-rounds.mjs", "we:scripts/conveyor/advisory-label-sweep.mjs"]
dateOpened: "2026-10-21"
tags: ["review", "red-team", "round-cap", "judge"]
---

# Round judge prototype (shadow): log grant/send-back/card/split/escalate calls next to the actual decisions

Shadow-mode prototype of the AI round judge from decision 6753. It only logs its call beside each real round decision. It takes no action. Reuses we:scripts/lib/red-team-gate.mjs sorting and we:scripts/operations/extend-rounds.mjs inputs.


## What to build

A shadow-mode judge, per decision card 6753. For each real round decision it computes what the judge would have said and writes that call to a log file next to the actual decision. It changes no labels, grants no rounds, files no cards and posts no comments.

Inputs reuse what exists: findings per round, `we:scripts/lib/red-team-gate.mjs` card-vs-sendBack sorting, and the `we:scripts/operations/extend-rounds.mjs` grant records. The `we:scripts/conveyor/advisory-label-sweep.mjs` path is read only, to see when a regate happened.

## Acceptance

- [A1] **Executable** — a unit test feeds two rounds of fixture findings (shrinking, repeating, drifting) and asserts the logged verdict is one of grant, send-back, card, split or escalate, with reasons. It fails before the item lands.
- [A2] **Executable** — a test with a throwing or malformed judge asserts a `no-grant` log entry and no change to any PR state (fail closed).
- [A3] **Must** — after one day of shadow running, its logs are compared with the operator grants and rulings from the 2026-10-20 night and the 2026-10-21 morning, listed in the webeverything handoff note (the operator's workspace operations handoff folder). The comparison is written down in this card's resolve note.
- [A4] **Must** — the agreement rate is reported overall and per verdict, with each disagreement listed with the judge's reasons. Cases such as #5701 (7 rounds), #5769 and #5530 (overnight cap) and #5784 (3 repeated findings) are shown individually.
- [A5] **Must** — the log proves no action was taken: zero writes to labels, grants, cards or comments from the judge path (checked by a test over the judge module's write surface).

## Non-goals

- [N1] No action of any kind: no grant, send-back, card, split or escalation is performed.
- [N2] No choice of the final model, ceiling value or card-ruling rights. Those belong to the parent decision.
- [N3] No change to the existing caps or to `extend-rounds` behavior.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — PR text and findings are passed to the judge as quoted data; output is parsed against a closed schema and anything else is logged as `invalid`.
2. **Truncated reads** — truncated findings or diff input is logged as `no-grant` with reason `truncated`, never as progress.
3. **Shared state files** — the shadow log is append-only with one writer path; concurrent runners must not interleave partial lines.
4. **Fail closed** — judge error, timeout or missing prior round yields a `no-grant` log line and no side effect.
5. **Identity scoping** — each log line carries repository, PR, head SHA and round so it can be matched to the actual decision.
6. **State over time** — log lines for a superseded head stay but are marked stale; the comparison ignores them.
7. **Who wrote it** — the log records whether the real decision was made by a human, the standing ruling or a runner, so agreement is measured against the right party.
