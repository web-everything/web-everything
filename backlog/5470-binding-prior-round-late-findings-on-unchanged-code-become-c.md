---
bornAs: xtzqoyq
kind: story
size: 3
priority: high
parent: "5467"
status: resolved
blockedBy: ["5469"]
relatedTo: ["5468", "5399"]
scope: ["we:scripts/lib/review-loop-policy.mjs", "we:scripts/lib/review-settings.mjs", "we:scripts/operations/review-pr.mjs"]
dateOpened: "2026-10-08"
dateResolved: "2026-10-09"
tags: [review]
---

# Binding prior round: late findings on unchanged code become cards

Fixer/review proposal, operator 2026-10-08, P3. On code unchanged since round N, a finding that was tolerated or not raised in round N is filed as a card, not a blocker. The one exception is `broken` + `CONFIRMED`: a reviewer may still block a real defect (the #5399 floor rule). A re-raise of a finding marked "fixed" must say why the fix fails; without that it is advisory. Ruled: 3 days in shadow with a "would have blocked" journal first, then on. Needs the finding identity from 5469. The rule is a pure function in the protocol card 5468's shape.

## Acceptance

- [A1] **Executable** — replay fixtures: (a) a tolerated finding re-raised on unchanged code becomes a card; (b) a `broken`+`CONFIRMED` one on unchanged code still blocks; (c) a finding on changed code blocks as today; (d) a re-raise of a "fixed" finding with no reason is advisory.
- [A2] The mode is a declared setting: off (today) / shadow / on. Shadow journals "would have blocked" per finding and changes no verdict.
- [A3] Shadow runs at least 3 days; the switch to on is a settings change citing the journal's counts.
- [A4] Each auto-carded finding is filed as a backlog card with its identity and the round that tolerated it, and counted ("auto-carded findings").
- [A5] **Proof** — on a live round-2+ PR, before/after: the shadow journal entry, then (after the flip) the card filed instead of the block.

## Non-goals

- [N1] No change to round 1, CI, or the drain's live gate.
- [N2] No round budget: that is 5471 (P5).

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — the "why the fix fails" reason is read as text for the card, never as a verdict switch by itself.
2. **Truncated reads** — unknown "changed since round N" status counts as changed: the finding blocks as today.
3. **Shared state files** — the shadow journal is append-only; cards are filed through `file-item`.
4. **Fail closed** — missing identity or ledger read error leaves today's blocking behaviour.
5. **Identity scoping** — "unchanged" is per finding identity and per PR head pair.
6. **State over time** — the 3-day shadow window is a setting with a recorded start date.
7. **Who wrote it** — `CONFIRMED` comes only from the review role's ledger row.

## Done when

- `npm run test:unit -- we:scripts/lib/__tests__/review-loop-policy.test.mjs` passes the `5470 [A1] binding prior round replay fixtures (mode on)` block: (a) a round the shadow says would be avoided (late/tolerated finding on unchanged code) becomes cards; (b) broken + CONFIRMED on unchanged code still blocks; (c) a finding on changed code (shadow still blocks) blocks as today; (d) `shadow`/`off`, a missing summary, or a full-review scope change nothing. The per-finding rule R6 (incl. a re-raise of a fixed finding with no reason → card) stays covered by `we:scripts/lib/__tests__/review-round-rules.test.mjs`.
- `npm run test:unit -- we:scripts/lib/__tests__/review-settings.test.mjs` passes: `scopedRereview` accepts `off | shadow | on` (env `WE_REVIEW_SCOPED_REREVIEW`), and the declared file stays `shadow`.
- `npm run test:unit -- we:scripts/operations/__tests__/review-pr-io.test.mjs we:scripts/operations/__tests__/review-pr.test.mjs` passes: `on` carries through the read and still declares the shadow effect whose summary the `on` rule reads.

## Resolution (2026-10-09)

The `on` mode is built: `we:scripts/lib/review-loop-policy.mjs#bindingPriorRoundDecision` reads the advise step's shadow summary; when the round would have been avoided, `we:scripts/operations/review-loop-cli.mjs` files the held findings as one card and accepts. [A2]'s shadow and [A4]'s per-finding identity came with 5469. Per the P3 revision (operator 2026-10-08: the B1 replay showed ~0 of 48 later rounds avoided), the declared setting stays `shadow` and no flip is planned, so [A3] (3-day shadow, then flip) and [A5] (live before/after after the flip) are not owed: flipping is a one-line change to `we:scripts/review-settings.json` if the journal ever earns it.
