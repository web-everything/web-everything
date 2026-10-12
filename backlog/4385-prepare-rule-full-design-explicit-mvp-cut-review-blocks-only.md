---
bornAs: xtw16qn
kind: story
size: 5
priority: high
status: open
scope: ["we:agent-memory-src/story-preparation-checklist.md", "we:skills-src/conveyor/prepare-decision-agent-brief.md", "we:scripts/conveyor/run-rating.mjs", "we:scripts/conveyor/__tests__/run-rating.test.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-09-28"
preparedDate: "2026-10-12"
preparedAgainstSha: "176afcf9341f8b320ac537e242891761687cb30f"
tags: []
---

# Prepare rule: full design, explicit MVP cut, review blocks only on MVP Musts

Prepare writes the FULL design, then names an explicit MVP cut (smallest slice meeting the card's Must criteria, safe standalone); Done-when splits Must vs Could; a plan-review finding is classified BLOCKER (breaks a Must, or real harm: data loss/security/gate break) / SCOPE-GROWTH (valid, beyond MVP Musts — auto-filed as an already-designed follow-up) / NOT-AN-ISSUE; size budget applies to the MVP (~1.5x card size, else split again); max 2 review rounds, then stamp if no MVP-Must blocker and file the rest as follow-ups; run rating records rounds+scope-growth per card. Evidence: we:backlog/4309 (4 Codex rounds, hand-rescoped), we:backlog/4365 and we:backlog/4366 (3 and 4 blockers after the cap, hand-rescoped) — not sustainable.

## Design

**The rule, as ratified (operator, 2026-09-28), applied to how THIS card itself is prepared:**

1. Prepare writes the complete design — reviewers may surface every edge case; they refine the design, they do
   not gate it.
2. Prepare then names an explicit MVP cut — the smallest slice that meets the card's own `## Done when` Musts
   and is safe to ship standalone.
3. `## Done when` splits into **Must** (the MVP) and **Could** (real, already-designed, deferred).
4. A plan-review finding is classified, never left as a bare "blocker": **BLOCKER** (breaks an MVP Must, or
   names real harm — data loss/security/a gate break) blocks the stamp; **SCOPE-GROWTH** (valid, but beyond the
   MVP Musts) becomes an auto-filed, already-designed follow-up slice (never silently dropped, never silently
   "resolved" by widening the MVP); **NOT-AN-ISSUE** is dismissed with a one-line reason, same discipline
   `we:skills-src/conveyor/prepare-scope-agent-brief.md`'s own review step already applies ("a finding you judge
   not-real is dismissed with a one-line reason — never dropped in silence").
5. The size budget applies to the MVP, not the full design — an MVP exceeding ~1.5× the card's own declared
   `size` gets split again (mirrors `we:.claude/skills/split-backlog-item/SKILL.md`'s existing size>8 split
   rubric, applied at the MVP boundary instead of the card boundary).
6. Max 2 review rounds. After that, if no MVP-Must blocker remains, stamp `preparedDate` and file the rest as
   follow-ups — never hold a card open indefinitely chasing scope-growth findings past the cap.
7. Run rating records review rounds and scope growth per card, so "prepared vs. unprepared" and "how many
   rounds did the cap actually cost" become measurable, not anecdotal — the same measurement discipline
   `we:agent-memory-src/fixes-need-prepared-card.md` already asks for ("collect prepared-vs-unprepared stats...
   rather than assuming the win; see the `run-rating` comparison work this motivated").

**Why this card exists now, not as a one-off correction.** Three real cards hit this exact cost the same
session: `we:backlog/4309` took 4 Codex rounds and was rescoped by hand; `we:backlog/4365` and `we:backlog/4366`
each still had real blockers (3 and 4 respectively) after this repo's existing 1-re-review cap, and BOTH had to
be rescoped by an orchestrating session's own judgment call rather than by a named rule — the exact
"judgment stays in context, footguns first" gap rule 51 (Hookable vs Judgment) exists to close: a
script-decidable classification (does this finding break a stated Must? is it in the MVP's own declared scope?)
was being redone from scratch, by hand, every time, instead of being a named step every prepare pass follows.

**Where the rule is APPLIED vs. WHERE it is DOCUMENTED (this card changes documentation/checklists/data fields,
never a new enforcement script — matching this repo's own existing "manual discipline until it becomes an
operation" precedent for prepare, `we:agent-memory-src/story-preparation-checklist.md`'s own closing line).**
There is no single "prepare-story" operation or skill in this repo today — `we:backlog/4364`/`4365`/`4366`'s own
prepare passes ran as an ad-hoc session driving `node we:scripts/codex-direct-task.mjs --review` directly, never
through a named skill. This card's own scope is therefore the artifacts an agent driving a prepare pass
actually reads before/during that work, not a new script:
- `we:agent-memory-src/story-preparation-checklist.md` — the checklist every prepare pass is expected to
  satisfy (items 1–10 today). Gains items 11–13 below (MVP cut, finding classification, round cap).
- `we:skills-src/conveyor/prepare-decision-agent-brief.md` — the prepare brief for decision items (a sibling,
  `we:skills-src/conveyor/prepare-item-agent-brief.md`, drives story/task prepares like this one and today never
  references the checklist — Could C); gains a cross-reference to the story checklist's new items so a decision-shaped prepare pass
  inherits the same MVP-cut/round-cap discipline, not a forked copy of it.
- `we:scripts/conveyor/run-rating.mjs` — gains the two new recorded fields named in point 7 above.
- `we:docs/agent/backlog-workflow.md` — gains a short cross-reference to the checklist's new items at its own
  existing prepare-workflow section, so the Tier-0 router surfaces the rule rather than leaving it findable only
  by opening the memory file directly.

## MVP cut

**Must 1 (MVP):** design points 1–6 above, written into `we:agent-memory-src/story-preparation-checklist.md` as
three new numbered items (11–13, following its own existing 1–10 numbering and voice): **11** = full design,
then the explicit MVP cut, Done-when split into Must/Could, and the ~1.5× size budget on the MVP (points 1–3, 5);
**12** = BLOCKER / SCOPE-GROWTH / NOT-AN-ISSUE finding classification (point 4); **13** = the 2-round cap (point
6). Two existing lines of the same file are edited so they do not contradict the new items: item 10's closing
sentence ("Do not stamp a story until its preparation has passed independent review (item 9)") gains "— within
item 13's round cap"; its heading's "(items 1–9)" widens to "(items 1–9, 11–13)"; and the "How to apply (items
1–8, 10)" paragraph widens to include 11–13. Item 11 names the section form the #4438 lint actually reads — a
`## Explicit MVP cut` heading with numbered `**Must N**` lines — rather than adding a fourth heading spelling
(this card, 4365 and 4366 use `## MVP cut`; the prepare-item brief says `## MVP`). The file's frontmatter
`description:` gains the new topics. This lets any human prepare pass apply the rule by hand starting
immediately — the same "manual discipline until mechanized" shape item 8 already documents; a *dispatched*
prepare agent only inherits it once Could C lands.

**Must 2 (MVP):** one cross-reference paragraph in `we:docs/agent/backlog-workflow.md`, appended to the existing
story-kind `preparedDate` paragraph (`we:docs/agent/backlog-workflow.md:616`, which already says story prep
follows "the 10-item checklist" — that count becomes 13, and the parenthetical list of what the checklist
covers gains the MVP cut, finding classification and round cap so count and list agree). An un-findable rule is
not yet "applied."

**Already delivered (not rebuilt here):** the live application to `we:backlog/4365` and `we:backlog/4366` — both
already carry `## MVP cut` and `## MVP-blocking classification` sections on `main` (commit `914aa5f33`,
`we:backlog/4365-automatic-postmortem-on-every-merge-conflict-a-conflict-a-sc.md:172,324`,
`we:backlog/4366-prevent-prs-that-open-with-red-ci-local-pre-flight-mirrors-e.md:209`). Done-when's first proof
point is therefore already satisfied; this PR cites it rather than re-editing those cards.

**Could (follow-up, already designed above — not built now):**
- **Could A** — `we:scripts/conveyor/run-rating.mjs`'s two new recorded fields (point 7) — genuinely useful once
  several prepared cards exist under the new rule to compare, but not needed for the rule to be FOLLOWED starting
  now (a rule can be applied and later measured; it cannot be measured before it exists). `toScorecardRow`
  (`we:scripts/conveyor/run-rating.mjs:1074`) builds its row as an explicit object literal (it does not spread
  `rating`), so the two fields must be added there by name; the scorecard store passes unknown extra fields
  through (module header, `:46-50`, `we:scripts/conveyor/run-scorecard-store.mjs`), so no schema migration — a
  small, low-risk follow-up. Related, not a
  duplicate: `we:backlog/4304` (record whether an item was prepared).
- **Could B** — `we:skills-src/conveyor/prepare-decision-agent-brief.md`'s cross-reference (its step-5 review
  section, `:141`) — decision-shaped prepares are a smaller, separately-cadenced population than story prepares.
- **Could C** — the same cross-reference in `we:skills-src/conveyor/prepare-item-agent-brief.md` step 5 (this
  very prepare path), so a dispatched prepare agent applies the cap without reading the memory file first.

**Size:** the MVP is one file's worth of new checklist items + two small edits there + one cross-reference
paragraph — about a size-2 slice, well under 1.5× this card's `size: 5`. No split needed.

## Interfaces

- `we:agent-memory-src/story-preparation-checklist.md` — three new numbered items (11–13), in the file's own
  established voice (each states the rule, a "why," and a "how to apply," mirroring items 1–10's own shape):
  11 (MVP cut: full design first, then name the smallest Must-meeting, safe-standalone slice); 12 (finding
  classification: BLOCKER / SCOPE-GROWTH / NOT-AN-ISSUE, with BLOCKER's bar stated explicitly — breaks an MVP
  Must, or real harm); 13 (the 2-round cap: stamp on no remaining MVP-Must blocker, file the rest as follow-ups).
- `we:skills-src/conveyor/prepare-decision-agent-brief.md` — one new paragraph (Could, above) pointing at the
  checklist's items 11–13, in its own existing step-5 review section (`we:skills-src/conveyor/prepare-decision-agent-brief.md:141`,
  "Review your prepared forks — spawn an adversarial review subagent").
- `we:scripts/conveyor/run-rating.mjs` (Could, above) — `toScorecardRow(rating, {provider})`'s `rating` input
  gains two optional fields for a `kind: 'prepare'|'prepare-decision'` row (both already in
  `we:scripts/conveyor/run-rating.mjs`'s `SIZE_SCALED_KINDS`/`BUILD_KINDS`, `:204`/`:207`): `reviewRounds:
  number` (how many plan-review rounds this prepare pass actually ran, 1 or 2) and `scopeGrowthCount: number`
  (how many findings were classified SCOPE-GROWTH and auto-filed as follow-ups) — both pass through as extra,
  unvalidated fields per the module's own documented contract (`:46-50`), no schema change.
- `we:docs/agent/backlog-workflow.md:616` (Must 2) — one added sentence in the story-kind `preparedDate`
  paragraph linking `we:agent-memory-src/story-preparation-checklist.md` items 11–13; "10-item" → "13-item".

## Tasks

1. Author checklist items 11–13 in `we:agent-memory-src/story-preparation-checklist.md` (Must).
2. Add the one cross-reference paragraph in `we:docs/agent/backlog-workflow.md`'s existing prepare-workflow
   section, linking to the checklist (Must).
3. Add the cross-reference paragraph in `we:skills-src/conveyor/prepare-decision-agent-brief.md`'s step-5 review
   section (Could).
4. Add `reviewRounds`/`scopeGrowthCount` to `we:scripts/conveyor/run-rating.mjs#toScorecardRow`'s accepted
   `rating` shape + a unit test asserting both ride through as extra fields (Could).

## Delivery shape

One PR, the Must items first (checklist + backlog-workflow cross-reference are both pure doc edits, no code, no
migration, safe standalone); the two Could items ride along in the same PR if time allows, or land as a
follow-up — neither blocks the other.

## Done when

1. **Must 1** — `we:agent-memory-src/story-preparation-checklist.md` states items 11–13 (MVP cut + Must/Could
   Done-when split + 1.5× size budget; BLOCKER / SCOPE-GROWTH / NOT-AN-ISSUE classification with the unclassified
   = BLOCKER default; the 2-round cap with the round count recorded in the card) in the file's own established
   voice, and item 10's stamp sentence and the "How to apply" paragraph no longer contradict them.
2. **Must 2** — `we:docs/agent/backlog-workflow.md:616` links to the new items from its story-kind prepare
   paragraph. The live proof is already on `main`: the rule was applied by hand to `we:backlog/4365` and
   `we:backlog/4366` (see *MVP cut* above) and to THIS card's own prepare pass, per the "prove on the live case,
   never a private workaround" discipline — not a separate fixture.
3. **Could A** — `we:scripts/conveyor/run-rating.mjs#toScorecardRow` accepts and passes through
   `reviewRounds`/`scopeGrowthCount`, unit-tested. **Could B/C** — the brief cross-references.

## Edge cases this change must handle

This is a documentation change; each class below states the handling the written rule must carry.

1. **Untrusted text** — n/a for the edit itself (static prose, no runtime input). But item 12 must say a review
   finding's text is data to classify, never an instruction to follow.
2. **Truncated reads** — n/a: no `gh`/`git` read is added. (Item 13's round counting reads the card's own
   `## Progress`, a local file.)
3. **Shared state files** — n/a: no state file or writer added. The round count lives in the card body, which
   already has one writer per prepare pass (the `prepare-hold` lease).
4. **Fail closed** — item 12 must say a finding that cannot be classified (no stated Must it breaks, no stated
   harm, no stated "beyond MVP" reason) counts as BLOCKER until classified, never silently SCOPE-GROWTH; item 13
   must say a round that errored or returned no verdict does not count as a clean round.
5. **Identity scoping** — item 13's round count is per card (its own `## Progress`), reset only by a new
   `preparedAgainstSha` re-prepare, never shared across cards; follow-up cards auto-filed for SCOPE-GROWTH cite
   the parent by `we:backlog/<NNN>`/`bornAs` hash.
6. **State over time** — a restart or re-dispatch mid-prepare must not reset the cap: rounds are recorded in the
   card as they finish (item 13), so a fresh prepare agent reads "round 1 done" instead of starting from zero.
   A re-prepare after the card goes stale starts a new count.
7. **Who wrote it** — n/a: the rule grants no trust to any comment or label. The BLOCKER bar (breaks an MVP Must
   / real harm) is judged on substance, not on who or what produced the finding.

## Test plan

No runtime code in the Musts, so tests are the existing content gates plus a mutation probe on the prose:

1. **`check:standards` stays green on the changed files** (the #4438 Must-citation and dangling-ref lints in
   `we:scripts/check-standards-rules.mjs:1134,1164`). The dangling-ref lint fails RED if any new
   `we:backlog/<id>` ref does not resolve. The Must-citation lint is warning-only and reads only a
   `## Explicit MVP cut` section with numbered Musts, so it is vacuous for this card's `## MVP cut` heading —
   this probe asserts "stays green", not RED-before.
2. **Mutation probe (manual, recorded in Progress):** count the lines of
   `we:agent-memory-src/story-preparation-checklist.md` that start with a bold `11.`, `12.` or `13.` — 0 with
   the items deleted, 3 with them present. Asserts the items exist as numbered bold items in the file's own voice.
3. **Contradiction probe:** grep `we:agent-memory-src/story-preparation-checklist.md` for "Do not stamp a story"
   — the sentence must carry the "within item 13's round cap" qualifier. RED before (it says unconditionally
   "passed independent review").
4. **Cross-reference probe:** grep `we:docs/agent/backlog-workflow.md` for `story-preparation-checklist` — the
   paragraph shows the items 11–13 link and "13-item". RED before: "13-item" is absent (it says "10-item"; the
   checklist link itself already exists there).
5. **Could A only, when built:** a `we:scripts/conveyor/__tests__/run-rating.test.mjs` case asserting
   `toScorecardRow({kind:'prepare', reviewRounds: 2, scopeGrowthCount: 1, ...})` returns both fields and still
   passes `validateScorecard` — RED before, since the row builder does not copy them today.

## Proof plan

- **Before/after on the live surface:** capture the probe 2–4 output on `origin/main` (before: 0 matches /
  "10-item" / unqualified stamp sentence) and on the lane after the build (after: 3 / "13-item" / qualified),
  pasted into the build PR body.
- **Live case:** this card's own prepare pass is the first use — `## Progress` records its review rounds and how
  each finding was classified (BLOCKER / SCOPE-GROWTH / NOT-AN-ISSUE); the already-landed 4365/4366 MVP cuts are
  cited as the second and third. No private workaround: the next prepare dispatch reads the checklist as written.
- **Gate:** the build lane's `verify-lane` request comes back green.

## Follow-ups

Each is a future backlog item, filed by the eventual BUILDER (not by this prepare pass):

- **Could A** — `reviewRounds` / `scopeGrowthCount` through `we:scripts/conveyor/run-rating.mjs` `toScorecardRow`
  + unit test (coordinate with `we:backlog/4304`).
- **Could B** — cross-reference in `we:skills-src/conveyor/prepare-decision-agent-brief.md` step 5 (`:141`).
- **Could C** — cross-reference in `we:skills-src/conveyor/prepare-item-agent-brief.md` step 5.
- **Mechanize classification** — a script deciding "does this finding name a Must?" from the card's numbered
  Musts (deterministic-core rule); explicitly out of scope: this card is manual discipline only, as the
  checklist's closing paragraph already frames prepare.

## Progress

- **2026-10-12 prepare pass (agent):** premise check against `main` @ `176afcf9` — items 11–13 absent from the
  checklist (ends at item 10 + "Also check"), no `reviewRounds`/`scopeGrowthCount` in
  `we:scripts/conveyor/run-rating.mjs`; the one `git log` hit for "4385" is PR #4385's own filing merge
  (`0f87f49d9`), not a delivery. **Not already done.**
- **Drift corrected:** `we:scripts/conveyor/run-rating.mjs` `SIZE_SCALED_KINDS`/`BUILD_KINDS` `:203/:206` →
  `:204/:207`; `toScorecardRow` `:1073` → `:1074`; contract note `:47-50` → `:46-50`; "10-item checklist" at
  `we:docs/agent/backlog-workflow.md:616` is the real link point (card said only "prepare-workflow section").
  4365/4366 live application was already delivered by `914aa5f33` — Done-when reworded to cite, not redo.
- **MVP cut refined:** Must 1 now includes design point 5 (size budget) inside item 11, and the two
  contradicting lines (item 10 sentence, "How to apply") — the original cut listed "items 1–4 and 6" and left
  both unaddressed. `size:` unchanged (5).
- **Plan-review round 1 of 2 (adversarial subagent): 0 BLOCKER.** Classified —
  - SCOPE-GROWTH, folded into Must 1 (one-line edits, same file): item-10 heading "(items 1–9)" widened; item 11
    names the lint-read heading form instead of a fourth spelling.
  - SCOPE-GROWTH, folded into Must 2: line-616 parenthetical list extended to match the "13-item" count.
  - SCOPE-GROWTH, card-text corrections: Design's "one EXISTING brief" claim fixed (the prepare-item brief
    exists); Could A "no caller change" sentence fixed (row builder is an explicit literal); test-plan probe 1
    reworded (Must-citation lint is vacuous for `## MVP cut`); probe 4 RED condition stated as "13-item absent".
  - Could C → Must: DISMISSED as a promotion — the brief edit is outside this card's declared Musts and `scope:`;
    instead the over-claim "any prepare pass can apply it immediately" was softened. Kept as Could C.
  - NOT-AN-ISSUE: `:1134/:1164` are the lint's comment lines directly above `:1139/:1167` (close enough); the
    "existing 1-re-review cap" wording is evidence prose in the Design, not a claim any Must depends on.
