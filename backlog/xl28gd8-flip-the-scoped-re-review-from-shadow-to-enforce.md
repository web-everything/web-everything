---
kind: decision
parent: "5467"
status: resolved
scaffoldedBy: "prepare-round-stories"
dateScaffolded: "2026-11-01"
scope: ["we:scripts/review-settings.json"]
relatedTo: ["5469", "5470", "5471", "5472"]
dateOpened: "2026-11-01"
dateResolved: "2026-11-01"
codifiedIn: one-off
preparedDate: "2026-11-01"
preparedAgainstSha: "174220fad20252329d315759de9702bbcc698979"
tags: [review, conveyor]
---

# Flip the scoped re-review from shadow to enforce

## Digest

Operator ruling R357 (2026-11-01): prepare the B1 flip. `scopedRereview` has been `"shadow"` since
2026-10-09 (`we:scripts/review-settings.json:3`). Shadow runs the full review as before and journals what the
binding prior round (#5470) WOULD have decided. `on` accepts a later round whose findings only touch code the
prior round already saw, and files them as cards (`we:scripts/lib/review-loop-policy.mjs#bindingPriorRoundDecision`,
line 642). **Bold default: Fork 1 (c), stay shadow for now, with a concrete re-decide trigger.** The flip would have cut
13 rounds in 24 days (2026-10-08 to 11-01) once the round budget K=3 is counted, and all 6 findings it would have carded as
"broken/unrecoverable" were security or correctness findings on real code (4 security lens, 2 correctness).

**Shadow evidence (measured 2026-11-01 from the append-only journal, one JSON line per reviewed round):**

- Where: `<ops>/ledger-shadow/scoped-rereview.jsonl` (`scopedRereviewJournalPath`, `we:scripts/operations/review-pr-io.mjs:445`;
  `<ops>` is the daemon operations dir, `~/workspace/.operations`). Written by `recordScopedRereviewShadow`
  (`we:scripts/operations/review-pr-io.mjs:470`). Each line has the round, scope kind, `liveBlocked`, `shadowBlocked`,
  `roundAvoided` and per-finding `decision` / `reason`. No ledger-write failures (0 of 3950 rows have `ledger != ok`).
- Volume: 3950 reviewed rounds on 1304 PRs, 2026-10-08 to 2026-11-01. 2521 are later rounds (round 2 or more).
- Live blocked: 1054 later rounds. Shadow would NOT have blocked: **32 (3.0%)**, on 28 PRs. Shadow never blocked a round the
  live review accepted (0 of 2521).
- By round: avoided 6 at round 2 and 7 at round 3 (13 total), then 19 at round 4 or later. The round budget
  (`roundBudget: 3`, #5471) already ends rounds past K in cards, so the incremental cut from `on` is the 13 at rounds 2-3, about 0.6 per day.
- Misses: of the 32 avoided rounds, the cards `on` would have filed hold 55 findings: 42 `degraded`, 7 `cosmetic`, 5 `broken`, 1
  `unrecoverable`. The avoidable rounds at rounds 2-3 are front-loaded: 8 of the 13 fell 10-09 to 10-12, only 1 since 10-27; the
  avoidable share at rounds 2-3 is 13 of 361 live-blocked rounds (3.6%), under the 10% trigger. None of the broken ones is CONFIRMED; all 6 are PLAUSIBLE. They are: lane-hold-io `liveRemoteHasRevision`
  (security, PR 4508 r2), `runReviewLabelCli` and `runCli` TOCTOU head binding (PR 4631 r6), `readRoundResumeInputs`
  (PR 4797 r4), `runFixCli` (security, PR 4984 r5, re-raise of a fixed finding), `findingEnvelope` (PR 5463 r4). So there is no
  proven case where scoped review missed a CONFIRMED real defect, but 6 plausible serious findings would have left the
  merge gate as cards.
- Data gap: the journal has no `care` field, so a low-care-only cut (Fork 1 (b)) cannot be evidenced from it today.

## Axis framing

One axis: how much of the later-round bounce the daemon is allowed to turn into cards. The three rungs are ordered by
risk: none (shadow), low-care only, all.

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| Fork 1 - the setting | (c) stay `shadow`, re-decide on a trigger | (a) flip to `on` | Medium |

## Fork 1 - set `scopedRereview` to `on`, `on` for low care only, or stay `shadow`?

*Fork-existence:* a real either/or. The setting holds one value at a time, and `on` converts blocking findings into
cards, which cannot coexist with the shadow value in the same round; the cost of being wrong in each direction is
different (a missed defect vs. an extra round).

- **(a) Flip to `on`.** Gain: 13 fewer rounds in 24 days at rounds 2-3 (the budget handles the rest). Risk: 6 plausible
  serious findings would be carded, not blocked.
- **(b) `on` for low care only.** Same machinery gated by the care level. Not buildable from today's data: the journal has
  no care field, and the setting is a single value (`we:scripts/lib/review-settings.mjs:21`, `SCOPED_REREVIEW_MODES`).
  It needs a new setting shape plus a journal field first.
- **(c) Stay `shadow`.** No change. Costs the 13 rounds. Keeps every later-round bounce. **Bold default**, with this
  trigger so it is not a soft park: re-decide when the journal shows the avoidable share at rounds 2-3 at or above 10% of
  live-blocked later rounds, or when a `care` field is journalled in the shadow rows (not filed yet), whichever first.

- **(d) `on` plus a carve-out: never card `broken`/`unrecoverable`.** Excluded for this ruling: it needs a rule change in
  `bindingPriorRoundDecision` (N1 forbids it) and would cut the saving to the 26 non-serious avoided findings only. It is the
  natural follow-up card if the trigger in (c) fires.

```json
// we:scripts/review-settings.json:3
{ "scopedRereview": "shadow" }   // (c) today
{ "scopedRereview": "on" }       // (a)
```

**Pre-mortem.** If we flip (a) and it goes wrong: an accepted PR lands a TOCTOU or security finding that was carded
instead of fixed, and the card sits in the backlog. Likely path: round-3 finding on a security file, classified
`late-on-unchanged-code`, carded. Cause: the rule keys on "unchanged since the prior round", not on severity, so a late
`broken` finding on old code is treated like a nit. A cheap guard exists to add before any flip: never card a finding whose
impact is `broken` or `unrecoverable` (6 of 55 here); that is a rule change, so it is a new card, not part of this ruling.
If we stay shadow (c) and it goes wrong: rounds keep costing about 0.6 per day. That cost is small and visible.

**Rollback.** Set `"scopedRereview": "shadow"` in `we:scripts/review-settings.json:3` through a normal lane PR (or
`WE_REVIEW_SCOPED_REREVIEW=shadow` for a quick env override, see `we:scripts/lib/review-settings.mjs` env map). The
shadow journal is append-only and keeps writing in `shadow` and `on`, so a rollback loses no evidence. Findings already
carded stay as cards.

Skeptic: HOLDS (c). Re-ran the journal: 3950/1304/2521/1054/32 on 28 PRs, 13 at rounds 2-3, 55 findings split, 0 ledger failures and all file:line cites verified. Fixed: "5 of 6" to all 6 serious, 23 to 24 days, cite 46-63 to 54-63; added excluded option (d) carve-out and the front-loading and 3.6% share evidence.

Screen: clear

## Supported by default

- Journalling stays on in every mode; it is the evidence for the next decision.

## Acceptance

- [A1] **Executable** - after a ruling, `grep -n scopedRereview we:scripts/review-settings.json` shows the ruled value (the `we:` prefix names the repo root).
- [A2] **Proof** - a live before/after: the journal count of `roundAvoided:true` rows and the later-round count the week before and after.

## Non-goals

- [N1] No rule change (a severity carve-out is a separate card). No change to `roundBudget`.

## Edge cases this change must handle

1. **Untrusted text** - n/a: a one-value settings change.
2. **Truncated reads** - an unreadable settings file keeps the built-in `off`, never a looser value (`we:scripts/lib/review-settings.mjs:54-63`, `ALLOWED` line 54, `PARSERS` line 60).
3. **Shared state files** - the journal is append-only and shared by all review runs; unchanged.
4. **Fail closed** - any shadow summary missing or a full-review scope keeps today's bounce (`bindingPriorRoundDecision`).
5. **Identity scoping** - n/a: repo-wide setting.
6. **State over time** - the evidence is a 23-day window and moves; the trigger in (c) re-reads it.
7. **Who wrote it** - n/a: the setting is operator-owned.

## Test plan

Existing replay fixtures cover both modes (`we:scripts/lib/__tests__/review-loop-policy.test.mjs`, `we:scripts/lib/__tests__/review-settings.test.mjs`); a ruling adds none.

## Proof plan

Count `we.scoped-rereview-shadow` rows with `roundAvoided` and later rounds per week from the journal path above, before and after the ruling.

## Ratified — 2026-11-01 (R360)

Operator chalbert, 2026-11-01 18:05 ET, verbatim: "Ratify all three".

Decision: `scopedRereview` STAYS shadow. Re-decide when the avoidable share at rounds 2-3 reaches 10% of blocked later rounds (currently 3.6%), or once a care field is journalled.
