---
bornAs: x2l32m7
kind: story
size: 3
parent: "4075"
status: open

dateOpened: "2026-09-30"
tags: []
---

# Prevention — Add a check:standards or prepare-stamp gate: any card stamped with preparedAgainstSha must contain a ##… (from chalbert/web-everything#3261 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:135` — Add a check:standards or prepare-stamp gate: any card stamped with preparedAgainstSha must contain a `## Done when` heading with at least one numbered clause. A cheaper first step is to have the probation launcher fail fast when the section is missing.
2. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:53` — Cite symbols (`ghDue` in we:health-watch.mjs) rather than line numbers, or have prep-staleness check file:line citations against preparedAgainstSha.
3. `we:backlog/4378-plateau-credential-inventory-and-rotation-tracker.md:126` — Add a rule to the health-smell and collector test conventions that every free-text field emitted from external API data passes a shared sanitize-and-truncate helper. A unit test should assert that control characters are stripped.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3261@266ed3c23aa679d9811897a534eef420866b50bb

## Progress

- **Premise check (2026-10-02, `main` @ d8680b7e).** Guard 1 is NOT delivered: `git log --grep=4709` finds only the
  card-filing commits, and no detector for a missing/placeholder `## Done when` exists (`we:scripts/check-standards-rules.mjs`
  only has `findMustWithoutDoneWhen` at `:1091`, which checks Must→Done-when citation, and returns `[]` when there are no
  Musts). `prepare-stamp` (`we:scripts/backlog.mjs:579-601`) stamps `preparedAgainstSha` with no body check at all, and the
  probation launcher only tells the worker "every `## Done when` clause … must hold" (`we:scripts/lib/probation-launcher.mjs:144`)
  without verifying the section exists. Guards 2 and 3 are likewise absent (`we:scripts/readiness/prep-staleness.mjs` diffs
  scope files only; no shared sanitize helper is required of health-smell collectors).
- **Scope drift corrected.** Old `scope:` was the REVIEWED card (`we:backlog/4378-…`, where the review found the gaps), not
  the files this item changes. Corrected to the gate, the stamp verb, and their tests. The `4378:<line>` cites in the intro
  are the review's snapshot and are not code to edit.

## Design

Precedent: the #4332 / #4438 lints. A pure body detector in `we:scripts/check-standards-rules.mjs` (next to
`findMustWithoutDoneWhen`, `:1091`, using the same local `sectionLines` helper, `:1003`) is composed into
`lintBacklogItemRendering` (`:1143`) as a WARNING, so both the whole-repo gate and `we:scripts/check-backlog-item.mjs` pick it
up with no new entry point. The detector is **`findDoneWhenGaps(body)`**: returns `[]` when `## Done when` has at least one
numbered clause (`/^\d+\.\s+\S/`) and no clause whose text contains the scaffold placeholder `TODO:` (the exact text
`we:scripts/backlog/scaffold.mjs:113` emits); otherwise one gap of kind `missing-section`, `no-numbered-clause` or
`placeholder-clause`. The lint applies only when the card carries a non-empty `preparedAgainstSha` and `status !== 'resolved'`
— the same "prepared" signal the stamp writes (`we:scripts/backlog.mjs:597`) — so the unprepared scaffold and the old resolved
corpus never trip it. `lintBacklogItemRendering` already receives `item` (frontmatter fields such as `preparedDate` are read at
`:1292`), so no new param is needed.

The fail-fast half lives at the source of the stamp: `prepareStamp()` (`we:scripts/backlog.mjs:579`) runs the same detector over
the card body before writing and `die()`s with the gap kind and a pointer to `## Done when` if any gap is found, so a card
cannot be stamped (and a probation worker cannot be launched against it) without a real Done-when. `we:scripts/backlog.mjs` already imports
from `we:scripts/check-standards-rules.mjs` (`:57`), so the detector is imported, not duplicated.

## MVP

**Must**
1. `findDoneWhenGaps(body)` pure detector + `lintBacklogItemRendering` WARNING for cards with `preparedAgainstSha`.
2. `prepare-stamp` refuses (non-zero exit, no file write) when the detector reports a gap — scoped to `kind: story|task`
   (decisions and epics carry no Done-when by convention; 24 of 286 stamped cards lack one today, 2 decisions + 2 epics + 19
   stories + 1 task) and only on a FIRST stamp (card has no `preparedAgainstSha` yet), so the idempotent re-stamp and the daemon's
   `prepare-stamp-pending` recovery of already-stamped legacy cards are never blocked. The existing `stamp()` fixture in
   `we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs` (body `# x`) gains a valid Done-when, and the conveyor stamp
   callers (`we:scripts/operations/probation-build-run.mjs`, `we:scripts/operations/prepare-stamp-land.mjs`) are checked: a refusal
   there surfaces as their existing `prepare-unstamped` / failed-stamp outcome, with a test asserting it is not a crash.
3. The detector reads `kind` and `preparedAgainstSha` from `item`; the implementer first confirms the loader exposes
   `preparedAgainstSha` on `item` (`preparedDate` is read there at `we:scripts/check-standards-rules.mjs:1292`) and adds it if not.

**Out of scope** (see Follow-ups): the file:line citation staleness check (review guard 2) and the sanitize-and-truncate
convention for health-smell collectors (review guard 3) — separate mechanisms on separate surfaces from this card's gate.

## Test plan

- **Detector, missing section** (capability, RED today: `findDoneWhenGaps` is not exported) — body with no `## Done when` →
  one `missing-section` gap.
- **Detector, no numbered clause** (capability) — heading present with only prose/bullets → `no-numbered-clause`.
- **Detector, placeholder** (capability) — the exact scaffold text `1. **Executable** — TODO: …` → `placeholder-clause`.
- **Detector, valid** (capability — RED today only because the export is absent) — one real numbered clause → `[]`; and a
  valid Done-when on a card with no Must section → `[]` (preservation; mutation proof: make the detector also require a Must
  section and this case goes red).
- **Kind/re-stamp scope** (capability) — a `kind: decision` or `epic` with no Done-when stamps; re-stamping a card that already
  has `preparedAgainstSha` and no Done-when does not refuse.
- **Lint integration** (capability) — `lintBacklogItemRendering` with `preparedAgainstSha` set and a bad Done-when warns; the
  same body without `preparedAgainstSha`, or with `status: resolved`, yields no Done-when warning (preservation; mutation proof:
  drop the `preparedAgainstSha` condition and the unprepared case fails).
- **`prepare-stamp` refusal** (capability, RED today: stamp succeeds on any body) — in
  `we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs`, a card with the scaffold `TODO:` Done-when exits non-zero and
  leaves the file byte-identical (no `preparedDate`/`preparedAgainstSha`); a card with a real Done-when still stamps.

## Proof plan

Run on the live case before/after: `prepare-stamp` (`we:scripts/backlog.mjs`) against a copy of this card's pre-edit body (the
scaffold `TODO:` Done-when) on `main` — it stamps (BEFORE, captured); on the branch it refuses with the gap kind (AFTER). Then
`npm run check:standards` on the branch shows the new warning on a deliberately-bad stamped fixture and none on this card, whose
Done-when is real. Finally `we:scripts/check-backlog-item.mjs` over the stamped corpus reports the count of existing stamped
cards that trip the warning (24 of 286 today, before kind-scoping; the post-scoping count is recorded in the PR, not fixed here).

## Follow-ups

(The builder files each as its own backlog card per the delivery brief, and cites the ids in its PR; this card's title and
Musts cover review guard 1 only.)

1. Cite symbols rather than line numbers, or have `prep-staleness` check `file:line` citations against `preparedAgainstSha`
   (review guard 2, `we:scripts/readiness/prep-staleness.mjs`).
2. Health-smell/collector test convention: every free-text field from external API data passes a shared
   sanitize-and-truncate helper, with a unit test that control characters are stripped (review guard 3).
3. Optionally promote the Done-when warning to an error once the stamped corpus is clean.

## Done when

1. **Executable** — `npx vitest run` over `we:scripts/__tests__/check-standards-rules-content-lint.test.mjs` and `we:scripts/__tests__/backlog-prepare-stamp-status.test.mjs` fails before this item lands and passes after (Musts 1, 2).
2. **Executable** — `prepare-stamp <id>` (`we:scripts/backlog.mjs`) on a card whose `## Done when` is missing or still holds the `TODO:` scaffold line exits non-zero and does not modify the file (Must 2).
3. **Executable** — `npm run check:standards` is green, and warns on a stamped card with no numbered `## Done when` clause (Must 1).

## Findings (standalone worker, 2026-11-19)

The build-dispatch daemon held #4709 with:

> worker-declined: Not prepared: #4709 — could-not-prepare. Its unconditional first-stamp refusal conflicts with #5399’s ratified 'advise → enforce' policy, currently 'advise' in 'we:scripts/lib/task-agreement-policy.json'. Open #5584 already owns the policy-controlled prepare/dispatch gate. The unresolved choice is whether #4709 becomes a complementary lint-only change or retains a separate mandatory stamp gate requiring a policy exception. No files changed, stamps written, or tests run.

`scope:` was cleared above so this card is picked up by the existing unshaped-item auto-prepare path;
a prepare pass re-scopes it against the finding.
