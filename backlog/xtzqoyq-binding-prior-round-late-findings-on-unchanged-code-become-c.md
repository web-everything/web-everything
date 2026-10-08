---
kind: story
size: 3
parent: "x8mmzuz"
status: open
blockedBy: ["xm1mi56"]
relatedTo: ["xdsdeeu", "5399"]
scope: ["we:scripts/lib/review-loop-policy.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-10-08"
tags: [review]
---

# Binding prior round: late findings on unchanged code become cards

Fixer/review proposal, operator 2026-10-08, P3. On code unchanged since round N, a finding that was tolerated or not raised in round N is filed as a card, not a blocker. The one exception is `broken` + `CONFIRMED`: a reviewer may still block a real defect (the #5399 floor rule). A re-raise of a finding marked "fixed" must say why the fix fails; without that it is advisory. Ruled: 3 days in shadow with a "would have blocked" journal first, then on. Needs the finding identity from xm1mi56. The rule is a pure function in the protocol card xdsdeeu's shape.

## Acceptance

- [A1] **Executable** — replay fixtures: (a) a tolerated finding re-raised on unchanged code becomes a card; (b) a `broken`+`CONFIRMED` one on unchanged code still blocks; (c) a finding on changed code blocks as today; (d) a re-raise of a "fixed" finding with no reason is advisory.
- [A2] The mode is a declared setting: off (today) / shadow / on. Shadow journals "would have blocked" per finding and changes no verdict.
- [A3] Shadow runs at least 3 days; the switch to on is a settings change citing the journal's counts.
- [A4] Each auto-carded finding is filed as a backlog card with its identity and the round that tolerated it, and counted ("auto-carded findings").
- [A5] **Proof** — on a live round-2+ PR, before/after: the shadow journal entry, then (after the flip) the card filed instead of the block.

## Non-goals

- [N1] No change to round 1, CI, or the drain's live gate.
- [N2] No round budget: that is xlsepow (P5).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the "why the fix fails" reason is read as text for the card, never as a verdict switch by itself.
2. **Truncated reads** — unknown "changed since round N" status counts as changed: the finding blocks as today.
3. **Shared state files** — the shadow journal is append-only; cards are filed through `file-item`.
4. **Fail closed** — missing identity or ledger read error leaves today's blocking behaviour.
5. **Identity scoping** — "unchanged" is per finding identity and per PR head pair.
6. **State over time** — the 3-day shadow window is a setting with a recorded start date.
7. **Who wrote it** — `CONFIRMED` comes only from the review role's ledger row.
