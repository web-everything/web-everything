---
bornAs: xppaab9
kind: story
size: 3
parent: "4075"
status: active
scope: ["we:backlog/4377-provider-allowance-gate-every-model-spawn-checks-a-live-allo.md"]
dateOpened: "2026-09-28"
dateStarted: "2026-09-30"
preparedDate: "2026-09-30"
preparedAgainstSha: "577ae7270910faca246326a32db914fb1c6a6dcf"
tags: []
---

# File the prevention guard(s) owed by chalbert/web-everything#2882's independent review

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4377-provider-allowance-gate-every-model-spawn-checks-a-live-allo.md:103` — A prepare-time check, or a lint in check:standards on backlog cards, that every Must-numbered MVP item is referenced by at least one Done-when clause; at minimum a review-lens checklist line.
2. `we:backlog/4377-provider-allowance-gate-every-model-spawn-checks-a-live-allo.md:13` — Extend the backlog locus-prefix lint to fail (or warn) on `we:backlog/<id>` refs that resolve to no file on main or in the same PR, with an explicit 'pending-lane' escape marker.
3. `we:backlog/4377-provider-allowance-gate-every-model-spawn-checks-a-live-allo.md:1` — A frontmatter validation step in `check:standards` that enforces the presence of `workItem` and `size` on all markdown files in the `backlog/` directory.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#2882@356e0a22730b04e418dd9450b00a9fdaf57546e4

## Progress

- **Premise check (2026-09-30, against `main` @ 577ae727).** Guards 1 and 2 are NOT delivered (no detector for either in
  `we:scripts/check-standards-rules.mjs`; `git log --grep` finds no commit for #4438 / `4438` beyond the JIT renumber).
  Guard 3 IS delivered in current form: `workItem` was superseded by the single `kind` axis (#466/#487,
  `we:scripts/check-standards-rules.mjs:216-222`), and `we:scripts/check-standards-rules.mjs:446-455` already errors on
  a story with no `size` and a task with one; `kind` presence + enum is checked just above. The cited card 4377 carries
  `kind: epic` (size optional while an epic), so it is already valid — guard 3 as worded targets a field that no
  longer exists. Dropped from the MVP with this evidence.
- **Citation drift.** The three `4377:<line>` cites point at the review's snapshot of that card; its current line
  numbers differ. The substance (Must list at `## Explicit MVP cut`, `we:backlog/<id>` refs in prose) still exists.

## Design

Precedent: the #4332 test-plan lint. `findTestPlanGaps` is a pure body detector in
`we:scripts/check-standards-rules.mjs`, composed into `lintBacklogItemRendering` (`:1016`), which the whole-repo gate
(`we:scripts/check-standards.mjs:926`) and the scoped `we:scripts/check-backlog-item.mjs` both call, so the two never
diverge. It is WARNING-only and skips `status: resolved` (the old corpus predates the rule). Both new guards follow that
exact shape — no new entry point, no gate-red risk on the existing 4.6k-card corpus.

1. **Guard 1 — `findMustWithoutDoneWhen(body)`.** Parse the numbered items under the `**Must (MVP):**` label inside
   `## Explicit MVP cut` (when present), and the text of `## Done when`. **Decided convention (no prior one exists —
   4377's Done-when cites none by number):** a Must N is "cited" only by an explicit number reference in Done-when:
   `Must N`, a list `Musts A, B`, or a range `Musts A-B` covering N (regex-parsed). Substance-matching and count-based
   checks are rejected as unreliable; a card whose Done-when covers a Must only in prose is flagged, and the fix is to
   add the number — cheap, and the point of the guard. Return one gap per uncited Must. Cards with no
   `## Explicit MVP cut` or no numbered Musts return `[]`. Expected on the live corpus: 4377 warns for Musts it never
   cites by number (true positive).
2. **Guard 2 — `findDanglingBacklogRefs(body, knownIds)`.** Extract `we:backlog/<id>[-slug][.md]` refs from the body
   (prose and backticks), including the bare `we:backlog/4380` form, using id shape `[0-9]{1,5}|x[0-9a-z]{6,7}` (the
   same as `BACKLOG_GLOB_CITE_SOURCE`, `we:scripts/lib/citation-check.mjs:153`). Flag a ref whose `<id>` is not in
   `knownIds`, built with the existing `buildBacklogResolvableIds(backlog)` (`we:scripts/lib/citation-check.mjs`,
   ~`:158`) — landed nums PLUS `bornAs` hashes, so a ref written against a since-JIT-numbered hash still resolves.
   **Why a new detector beside the adjacent ones:** gates 6f-ii-c/6f-ii-d (`we:scripts/check-standards.mjs` ~`:1717-1815`)
   cover hash-path cites outside `backlog/` and the `backlog/<id>-*.md` glob form only; the `we:backlog/<id>` prose ref
   form is covered by neither, and audit-backlog-health's D2 covers `#N` refs. Escape marker: a ref immediately followed
   by `(pending-lane)` is exempt (a sibling card still in flight in the same PR/lane). `lintBacklogItemRendering`
   gains an optional `knownBacklogIds` param (like `pocRegistry`); when absent the detector is skipped, so existing
   callers are unchanged. The gate builds the Set once from its already-loaded `backlog` array, outside the per-item loop
   (next to `pocRegistry`, `we:scripts/check-standards.mjs:920`); `we:scripts/check-backlog-item.mjs` needs a NEW
   directory read + item load for this (its existing listing at `:111` sits inside the `blockedBy` branch only).
3. **Review-lens line** (Guard 1's stated minimum): one checklist line added to
   `we:agent-memory-src/story-preparation-checklist.md` — "every MVP Must is cited by number in a Done-when clause".

## MVP

**Must**
1. `findMustWithoutDoneWhen` pure detector + wiring into `lintBacklogItemRendering` as a WARNING.
2. `findDanglingBacklogRefs` pure detector with `(pending-lane)` escape + `knownBacklogIds` plumbed from both callers, as a WARNING.
3. Unit tests for both (see Test plan), plus one integration case through `lintBacklogItemRendering`.
4. The one-line review-lens checklist entry.

**Out of MVP** (Follow-ups): promote either warning to an error; corpus-wide cleanup of existing dangling refs; guard 3 (already delivered, above).

## Test plan

In `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs`, beside the `findTestPlanGaps` block (`:679`):
- `findMustWithoutDoneWhen`: card with Musts 1-3 and Done-when citing only "Must 1" and "Must 3" → exactly one gap (Must 2). Red today: export does not exist.
- `findMustWithoutDoneWhen` matching forms: `Must 2`, `Musts 1, 3`, and `Musts 1-4` each cite the numbers they name; prose-only coverage is NOT a citation. Red today: export does not exist.
- `findMustWithoutDoneWhen` all cited, and no-MVP-section cards, → `[]`. Red today: export does not exist; mutation proof — dropping the range parsing makes the `Musts 1-4` case fail.
- `findDanglingBacklogRefs`: `we:backlog/9999-nope.md` with `knownIds` lacking 9999 → one gap; same ref with `knownIds` containing it → none; provisional `xabc123` id present → none; a ref to a graduated card's `bornAs` hash, with `knownIds` from `buildBacklogResolvableIds`, → none. Red today: export does not exist.
- `findDanglingBacklogRefs` escape: the ref followed by `(pending-lane)` → none. Red today: export does not exist.
- `lintBacklogItemRendering` integration: both gaps surface in `warnings` (not `errors`) for an open card. Red today: no such warning is emitted.
- `lintBacklogItemRendering` resolved card yields neither, and omitting `knownBacklogIds` skips guard 2 only. Red today: detectors absent, so the positive half of each assertion fails.

## Proof plan

Live before/after on the real corpus: run the scoped item check (`we:scripts/check-backlog-item.mjs`, arg `4377`) on `main` (no warnings for these
guards) and in the lane after the change, expecting a Guard 1 warning naming the 4377 Musts its Done-when never cites by
number (Musts 1-4; its Done-when #2 covers Must 5 only in prose), and NO Guard 2 warning for 4377's `we:backlog/4380`
refs (they resolve today — the negative example), then `npm run check:standards` to show the gate stays green (warnings only) and report the new
warning count. Include the captured output in the PR body.

## Follow-ups

- Promote guard 1 / guard 2 from warning to error after a corpus cleanup pass.
- One-off sweep fixing existing dangling `we:backlog/<id>` refs surfaced by guard 2.
- Teach the backlog CLI write path (`we:scripts/backlog/guarded-write.mjs`) to run guard 2 at write time, as the locus-prefix check does.

## Done when

1. **Executable** — `npx vitest run check-standards-rules-content-lint -t "findMustWithoutDoneWhen|findDanglingBacklogRefs"` fails before this item lands (exports missing) and passes after.
2. **Must** — Musts 1-4 of the MVP above are each delivered; the gate stays green with both lints as warnings.
