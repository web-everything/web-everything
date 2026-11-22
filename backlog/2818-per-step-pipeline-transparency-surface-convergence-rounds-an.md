---
bornAs: xhixrrg
kind: story
size: 5
parent: "2527"
status: open
dateOpened: "2026-08-01"
tags: [plateau-loop, conveyor, console, review, transparency, convergence, slice-uifg-adjacent]
scope:
  - we:scripts/review-detail.mjs
  - we:scripts/__tests__/review-detail.test.mjs
  - we:scripts/lib/pipeline-trace.mjs
  - we:scripts/lib/__tests__/pipeline-trace.test.mjs
relatedTo: ["2486", "2642", "2641", "2567", "3113"]
---

# Per-step pipeline transparency — surface convergence rounds and each stage trace

Captured 2026-08-01 (operator direction): *"as much transparency for every step — we could even expose
convergence rounds, and potentially other steps too."* The delivery pipeline already **produces** rich
step-level detail; almost none of it is **surfaced**.

## Prepared 2026-08-15 — grounded against the live code; scope narrowed to avoid duplicating two already-ready siblings

Verified against `main` (`c1a4d770`), not from the card's own claims:

- **[#2486]** (open, unblocked — `blockedBy: ["2500"]` and #2500 is `resolved`) already targets *exactly*
  bullet 1 below: "surface the automated review pipeline: per-lens verdicts, disposition, rendered comment,"
  reachable from the review console. **[#2642]** (open, unblocked — `blockedBy: ["2641"]` and #2641 is
  `resolved`) already targets the juror-roster-with-rounds view (lens, method, charter, status, findings,
  verdict, round) plus jury-config management. Confirmed live: `plateau:tools/dev-panel/drain-daemon.html`'s
  review expand (`renderReviewDetail`, line 534) renders only `escalationReason` + `disposition.mode` today —
  no per-lens verdicts, no rounds, no juror roster — and nothing in `plateau-app` references
  `we:scripts/lib/jury-ledger.mjs` (`grep -rl jury-ledger plateau-app/tools` → zero hits). So the gap #2486 and
  #2642 describe is real and **unbuilt**, but it is *their* gap to close, not a new one for this card. Building
  the "Convergence rounds view" bullet under #2818 as originally scoped would duplicate two already-filed,
  ready, unblocked items rendering the *same* `we:scripts/lib/jury-ledger.mjs` `foldJuryLedger` data to the
  *same* review surface. **This card's own scope is narrowed to drop that bullet** — #2818 does not build a
  rounds view; #2486/#2642 do. #2818's job is the genuinely new part: generalizing the trace to stages *beyond*
  review.
- **"Build self-review" has NO existing data source — the card's own premise ("surface it, don't rebuild") is
  false for this one stage.** Layer-1 build-time self-review (`we:skills-src/conveyor/delivery-agent-brief.md`,
  step 7, lines 166–192) runs entirely in-session — render, screenshot, Read, iterate — and writes **nothing to
  disk**. There is no ledger, no log, no PR field to fold. Fabricating a step for it would violate the "sourced
  from existing ledgers, not a parallel store" acceptance line this card itself states. Filed as its own
  prerequisite: **[#3113]** "Persist a structured build-lane self-review record (Layer 1) so it can be
  traced" — an open decision (where it persists), not yet designed here. Until it lands, the per-item timeline
  this card builds renders a `status: 'not-yet-traced'` placeholder row for that stage rather than inventing
  data.
- **Drain escalation reasons + care-level ARE groundable now, with one gap closed here.**
  `we:scripts/review-detail.mjs`'s `assembleReviewDetail` (line 84) already returns `escalationReason` (the
  decorated reason strings) and `disposition` (mode/autoLand) — confirmed live in
  `plateau:tools/dev-panel/drain-daemon.html:542-546`. It does **not** return `careLevel`, even though the
  bridge to compute it from those exact decorated strings already exists:
  `careLevelFromReasons(reasons)` (`we:scripts/lib/review-core.mjs:618`) → `'none'|'low'|'elevated'|'high'`,
  built for precisely this "a parked PR carries only decorated reasons, not raw signals" case (#2567). Also
  missing: **when** the escalation/disposition happened. `assembleReviewDetail`'s `lastMatching` helper (line
  105) reads only `comment.body`, discarding `comment.createdAt` — verified live (`gh pr view 1263 --repo
  chalbert/web-everything --json comments` returns `createdAt` on every comment today), so the timestamp is
  already in the data `gh` hands back; it is dropped, not absent.
- **Land IS groundable, plateau-app-side, with precedent.** `plateau:tools/drain-daemon/lib.mjs` already
  extracts per-PR history rows keyed by PR number (`consecutiveParkedPasses(history, num)` line 497,
  `consecutiveConsideredNeverMerged(history, num)` line 519) from the append-only `plateau:.drain-daemon/
  history.jsonl` (each row: `{at, mergedPrs:[...], parked:[{num, humanRequired, reasons}], consideredPrs:[...]}`
  — verified against a live row). `we:` never reads that file directly (it is plateau-app-owned operational
  state, MEMORY #6) — this card's WE-side module takes already-parsed rows as a parameter, mirroring how
  #2470/#2500 kept the fs boundary in the product repo.

## Decided design

**Two additive WE changes; no rebuild of #2486/#2642's surface; the visual timeline itself is plateau-app's
build, tracked here not implemented here (MEMORY #6).**

1. **Widen `assembleReviewDetail`** (`we:scripts/review-detail.mjs:84`) with two backward-compatible fields:
   - `careLevel: careLevelFromReasons(escalationReason)` — reuses the existing bridge, computed, never
     re-derived.
   - `advisoryCommentAt` / `humanCommentAt` — the matched comment's `createdAt` (ISO string), `null` when no
     matching comment exists (mirrors today's `advisoryComment`/`humanComment` null case exactly).
2. **New `we:scripts/lib/pipeline-trace.mjs`** — the ONE shared trace-grammar normalizer, mirroring
   `we:scripts/lib/jury-ledger.mjs`'s pure-fold / tolerant-read discipline (never throw on malformed input; a
   step that cannot be built degrades to `status: 'unknown'`, never a crash):
   - `normalizeStep({ name, status, verdict, reasons, actor, rounds, startedAt, endedAt, detail })` — the one
     shape every stage below normalizes into. This is a **data** grammar, distinct from the ratified **visual**
     card grammar (`#2789`/`#2554` — the console-board's single box + tokens); when plateau-app later renders
     these rows it should reuse that box, but the two grammars are not the same thing and this card corrects
     the original text's conflation of them.
   - `reviewStepFromLedger(events)` — calls `we:scripts/lib/jury-ledger.mjs`'s `foldJuryLedger(events)`
     **unchanged** (the #2641 guardrail: a second fold copy is a bug) and additionally derives
     `startedAt`/`endedAt` as the min/max `at` across the raw stream (the fold itself discards timestamps; this
     is a new, separate derivation, not a fold edit). `rounds: ledger.round + 1`, `verdict: ledger.panelVerdict`,
     `actor: 'jury'`.
   - `escalationStepFromReviewDetail(detail)` — maps the widened `assembleReviewDetail` output:
     `verdict: detail.disposition?.mode ?? null`, `reasons: detail.escalationReason`, carries `careLevel`,
     `endedAt: detail.humanCommentAt ?? detail.advisoryCommentAt ?? null`, `actor: 'drain'`.
   - `landStepFromHistoryEntries(entries, { pr })` — pure; filters plateau-app's already-parsed history rows to
     ones referencing `pr` (via `mergedPrs`/`consideredPrs`/`parked[].num`), returns `status: 'landed'|'parked'|
     'unknown'`, `reasons` from the latest matching `parked` entry, `startedAt`/`endedAt` from the row `at`
     span, `actor: 'drain-daemon'`.
   - An `assemble` CLI (`node we:scripts/lib/pipeline-trace.mjs assemble --review-log=<file|-> --review-detail=
     <file|-> --history=<file|-> --pr=<n>`), mirroring `we:scripts/lib/jury-ledger.mjs`'s `--file`/stdin CLI
     shape, so plateau-app's dev-panel proxy (which already shells `we:scripts/review-detail.mjs` and
     `we:scripts/lib/jury-ledger.mjs show`, per #2500's precedent) can gather the three raw inputs and get back
     one combined `{ steps: [...] }`.

## Interfaces and protocol

```js
// we:scripts/review-detail.mjs — assembleReviewDetail return shape, widened (additive)
{
  // ...unchanged fields...
  careLevel: 'none' | 'low' | 'elevated' | 'high',   // careLevelFromReasons(escalationReason)
  advisoryCommentAt: string | null,                  // ISO 8601, the matched comment's createdAt
  humanCommentAt: string | null,
}
```

```js
// we:scripts/lib/pipeline-trace.mjs
/** @typedef {{
 *   name: string, status: 'pending'|'running'|'done'|'landed'|'parked'|'unknown'|'not-yet-traced',
 *   verdict: string|null, reasons: string[], careLevel?: string, rounds?: number,
 *   actor: string, startedAt: string|null, endedAt: string|null, detail?: object,
 * }} Step */
export function normalizeStep(raw): Step
export function reviewStepFromLedger(events: object[]): Step
export function escalationStepFromReviewDetail(detail: ReturnType<typeof assembleReviewDetail>): Step
export function landStepFromHistoryEntries(entries: object[], { pr: number }): Step
```

```
# CLI (mirrors we:scripts/lib/jury-ledger.mjs's append/record/show shape)
node scripts/lib/pipeline-trace.mjs assemble --pr=<n> \
  [--review-log=<file|-> ] [--review-detail=<file|->] [--history=<file|->]
# → { steps: Step[] }  — any input omitted yields that stage as status:'unknown', never a throw
```

## Tasks

1. Widen `assembleReviewDetail` with `careLevel`/`advisoryCommentAt`/`humanCommentAt`; extend
   `we:scripts/__tests__/review-detail.test.mjs` — assert `careLevel` matches a direct
   `careLevelFromReasons(escalationReason)` call on the same fixture, and that the empty-comment case still
   yields `null` for the two new `*At` fields (byte-identical everywhere else).
2. Add `we:scripts/lib/pipeline-trace.mjs` (`normalizeStep`, the three step builders, the `assemble` CLI) +
   `we:scripts/lib/__tests__/pipeline-trace.test.mjs`. Reuse `we:scripts/lib/__tests__/jury-ledger.test.mjs`'s
   existing multi-round fixture for `reviewStepFromLedger`'s `rounds`/`startedAt`/`endedAt` assertions rather
   than inventing a new one.
3. Run `npm run check:standards` (0 errors).
4. Note in the PR body that the plateau-app render (a per-item timeline panel that reuses #2486/#2642's
   surface for the review step and the #2473 incident-timeline visual pattern for the others) is impl elsewhere
   and is **not** built by this WE-side PR (MEMORY #6) — file it as its own tracked slice if one doesn't already
   cover it, cross-referencing this card and #2486/#2642 so it doesn't re-render the juror roster a second way.

## Done when

- [ ] `assembleReviewDetail` returns `careLevel` equal to `careLevelFromReasons(escalationReason)` on the same
      input, asserted by a test — not by inspection.
- [ ] `assembleReviewDetail` returns `advisoryCommentAt`/`humanCommentAt`, sourced from the matched comment's
      `createdAt`, `null` when no matching comment exists; the pre-existing fixture's other fields are
      byte-identical to today's output.
- [ ] `we:scripts/lib/pipeline-trace.mjs` exports `normalizeStep`, `reviewStepFromLedger`,
      `escalationStepFromReviewDetail`, `landStepFromHistoryEntries`; each is pure, unit-tested, and degrades to
      `status: 'unknown'` on malformed/missing input rather than throwing.
- [ ] `reviewStepFromLedger` on a multi-round fixture jury log returns `rounds === ledger.round + 1` and
      `startedAt`/`endedAt` equal to the min/max `at` across the fixture's raw events.
- [ ] `npm run check:standards` is 0 errors on the WE-side change; no `plateau-app` file is touched or claimed
      done by this card.
- [ ] The card names #2486 and #2642 as the surfaces the review step composes with (done, above) and cross-
      references [#3113] as the prerequisite for the self-review stage (done, above) — a future claimant
      does not have to re-derive either finding.

## Delivery shape

Lands incrementally behind `main`, one PR. Both changes are pure additions (two new optional output fields on
an existing assembler; one new file) — no existing caller's contract changes incompatibly, so no branch is
needed.

## Watch for

- **Do not conflate this card's data trace grammar with the ratified visual card grammar** (`#2789`/`#2554`).
  They answer different questions (what shape is a step's data vs. what box renders it); reuse the box later,
  don't reuse the shape now.
- **`reviewStepFromLedger` must call `foldJuryLedger` unchanged, never re-derive it** — the #2641 guardrail
  ("a second copy of the fold logic in either consumer is a bug") applies here too; this card only adds a
  timestamp-span helper alongside the existing fold, never a parallel reconstruction of the ledger.
- **`landStepFromHistoryEntries` must never read `plateau:.drain-daemon/history.jsonl` itself** — it takes
  already-parsed rows as a parameter. WE holds zero implementation of that read (MEMORY #6); the locus
  boundary is the whole point of the split.
- **Care-level is advisory** (#2563) — rendering it in a timeline must not read as a gate; it is "how hard the
  reviewer looked," not a pass/fail.
- **Independent review still owed** (checklist item 9, `we:agent-memory-src/story-preparation-checklist.md`).
  This preparation was done by one agent, solo; treat it as prepared, not yet build-ready-and-verified, until a
  separately-sessioned reviewer produces a confidence level against this card.

## Acceptance

From a board cell / PR, an operator can open the **convergence rounds** of its review (via #2486/#2642, not
rebuilt here) and a **per-item pipeline timeline** — review, drain-escalation + care-level, and land, each
sourced from an existing ledger via `we:scripts/lib/pipeline-trace.mjs`, with a placeholder row for
build-self-review until [#3113] lands. Both themes; `plateau-app npm test` (for its own render, once filed)
+ `we: check:standards` pass.

Merged into plan step PD-LIVE (PL-WIP-CLEANUP, 2026-11-22).
