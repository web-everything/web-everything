---
bornAs: xtjsuum
kind: story
size: 2
parent: "2676"
status: closed
closedReason: duplicate
closedInto: "2707"
dateClosed: "2026-11-22"
scope:
  - we:skills-src/jury/subject-jury.workflow.js
  - we:skills-src/jury/SKILL.md
  - we:skills-src/jury/__tests__/
dateOpened: "2026-07-27"
tags: []
---

# Built-in adversarial red-team of the tool's own proposals

**Prepared 2026-08-15.** The mandatory post-jury red-team **mechanism** this card asked for already shipped as
[#2707](/backlog/2707-jury-skill-red-team-after-jury-fail-closed.md) (`redTeamRequired` / `foldRedTeamVerdict` in
`we:scripts/lib/jury-core.mjs`, wired into `we:skills-src/jury/subject-jury.workflow.js`'s `redTeamGate`): every
jury `accept` is already followed by one mandatory adversarial pass before ratification, fail-closed (an unrun
red-team never ratifies). What is **still missing**, and is this card's real remaining scope, is that the
red-team's hunt is currently **generic** ("an unstated assumption, a correctness or security hole, a claim the
material asserts but did not earn") rather than **naming the specific honesty failure modes** this card was filed
over — the ones a generic hunt does not reliably reach because they are not "wrong", they are **overclaimed**.

## Grounded findings (2026-08-15 prep)

1. **The mechanism is built and resolved.** `we:scripts/lib/jury-core.mjs:627` (`redTeamRequired`) and `:645`
   (`foldRedTeamVerdict`) are the pure rules; `we:skills-src/jury/subject-jury.workflow.js`'s `redTeamGate` (around
   line 860) runs one adversarial agent on every jury `accept`, folds its findings through the same shared review
   core the panel uses, and degrades to `needs-human` if it does not run. `backlog/2707-*.md` is `status: resolved`
   (2026-07-27). **This card must not re-propose that mechanism** — doing so would duplicate landed work.
2. **The red-team's current mandate is generic, not honesty-lens-specific.** `redTeamPrompt()`
   (`we:skills-src/jury/subject-jury.workflow.js:697-728`) tells the adversary to hunt for "an unstated assumption,
   an unhandled case, a correctness or security hole, a claim the material asserts but did not earn, an edge that
   fails" — nowhere does it name internal-contradiction, false-precision, scale-unproven, a11y-truth, or
   data-model-truth as **specific axes to check**. Those are exactly the failure modes the feature-tracking-screen
   session's red-team caught by hand (a self-contradictory headline number, a forecast implying precision on
   blocked work, scale asserted but never rendered) and a generic "hunt for a reason" pass is not guaranteed to
   reach systematically — the session caught them because a human, not a generic prompt, specifically looked for
   them. Naming the checklist is the gap.
3. **"A ratifiability verdict (blockers / conditions / nits)" is ALSO already covered — by a different,
   deliberately narrower mechanism than what this card's original text imagined, not by an absence.** Two things
   are true at once:
   - `redTeamPrompt()` already instructs the adversary that every returned finding is, by construction, a
     **blocking** reason not to ratify ("do NOT pad with nitpicks — a red-team finding must be a real reason to
     withhold ratification"; an empty list is the only non-blocking outcome). That is a **deliberate** design
     choice (#2707), not an oversight: diluting the red-team's signal with nits would defeat the point of running
     an adversary at all. Re-scoping the red-team itself to emit three severity tiers would work against that
     design, not complete it.
   - The **general** blocker / carve-out / nit vocabulary this card's text describes is already ratified and is
     **actively being built** as [#2950](/backlog/2950-finding-disposition-blocker-carve-out-nit-and-only-blockers-.md)
     (`status: active`, i.e. someone has this file open right now) — `DISPOSITIONS` enum + `deriveFindingDisposition`
     in `we:scripts/lib/jury-core.mjs:277-328`. It uses `carve-out` where this card's text says "condition" (the
     closest existing analogue: a carve-out is filed and does not block, the same shape a "condition" implies) and
     `nit` verbatim. #2950 is scoped to the **whole jury's finding-routing**, not the red-team specifically, and its
     own card lists real undelivered pieces ("blockers are delivered, not negotiated"; "nits are filed"). **This
     card must not build a second, parallel severity vocabulary while #2950 is mid-build on the first one** — that
     is exactly the collision risk `we:agent-memory-src/story-preparation-checklist.md` item 8 asks prep to name up
     front. If #2950 later threads its routing through the red-team's own findings, that is #2950's scope to
     extend into (its `Finding` shape is already shared with the red-team's), not this card's.
4. **`data-model-truth` overlaps a sibling card, not a duplicate to fold in.**
   [#2695](/backlog/2695-data-grounding-lens-check-design-claims-against-real-data-av.md) (`status: open`, also a
   child of #2676, filed the same session) is the **automated, deeper** home for the data-model-truth check — "a
   lens that verifies a design's claims against the data we actually store... and emit the missing-capture work as
   follow-up items." That is real automation (reading the actual data-store shape, filing follow-ups); this card's
   red-team checklist can only ask the adversary to **look for** an unproven data-model claim by eye, the same
   by-eye posture the rest of `redTeamPrompt()` already has for everything else it hunts. The checklist item below
   says so explicitly rather than silently overlapping #2695's scope.
5. **No consumer of `we:skills-src/jury/subject-jury.workflow.js` needs its own edit.** Grepped every reference to
   `subject-jury` / `/jury` across `we:.claude/skills`, `we:skills-src`, `we:docs/agent`, and `we:scripts` (the
   subprocess-caller set the checklist calls out as usually the larger one, alongside ES imports) —
   `we:skills-src/design-committee/SKILL.md`, `we:skills-src/converge/SKILL.md`, `we:skills-src/drain/SKILL.md`,
   `we:skills-src/conveyor/SKILL.md`, and `we:scripts/lib/jury-core.mjs` / `we:scripts/lib/review-core.mjs` /
   `we:scripts/lib/judge-panel.mjs` all reference the jury **conceptually** or by invoking `/workflow subject-jury`,
   never by importing `redTeamPrompt` or the `RED_TEAM_SCHEMA` directly. This card adds instruction lines to an
   existing prompt string and does not change `RED_TEAM_SCHEMA`, the function signature, or any return shape — so
   nothing downstream (the reduce path, the ledger, `we:scripts/lib/review-render.mjs`) needs to change to keep
   working.
6. **Precedent for editing this exact prompt safely already exists twice.** #2823 (rootCause/prevention/
   preventionCaptured) and #2950 (the three disposition questions) both added instruction lines to jury prompts in
   this same file/family and both landed with `check:standards` at 0 errors — this is a proven-safe edit shape, not
   a novel one.
7. **`we:skills-src/jury/subject-jury.workflow.js` is a Workflow sandbox body, not an importable module** — its own
   header notes `node --check` rejects its top-level `return`. The one existing test file for it,
   `we:skills-src/jury/__tests__/panel-fanout.test.mjs`, reads it with `readFileSync(HARNESS, 'utf8')` and asserts
   on the text (e.g. it pins the literal shell command the harness prints, naming `we:skills-src/jury/panel-fanout.mjs`
   by its repo-relative path). That file's own docstring
   scopes it to the #3057 fan-out migration; this card's assertions belong in a **new**, narrowly-scoped test file
   following the same read-as-text pattern, not bolted onto panel-fanout's.

## Decided design

Add a **named honesty-lens checklist** to `redTeamPrompt()` — internal-contradiction, false-precision,
scale-unproven, a11y-truth, data-model-truth — as explicit axes the adversary must check **in addition to** its
existing generic hunt, not instead of it. Each becomes one line the red-team is told to actively probe, worded
subject-agnostically (the same prompt runs for pr-diff, design-pixels, and decision-prose subjects):

- **internal-contradiction** — does a headline number or claim in the material contradict another stated fact in
  the same material?
- **false-precision** — does a forecast or estimate imply certainty the material has not earned (e.g. precision
  claimed on work that is blocked, unmeasured, or provisional)?
- **scale-unproven** — is a scale, volume, or performance claim asserted but never rendered, measured, or
  demonstrated in the material?
- **a11y-truth** — is an accessibility claim asserted without evidence it was actually checked?
- **data-model-truth** — does the material assume data that is not actually captured or stored? (Named here as a
  by-eye check only; #2695 is the automated, deeper version of this specific lens and should be cited so a builder
  does not duplicate it.)

No change to `RED_TEAM_SCHEMA`, `redTeamRequired`, `foldRedTeamVerdict`, or the `DISPOSITIONS` enum — this is a
pure enrichment of what the already-mandatory red-team looks for, not a new mechanism or a new severity vocabulary.

## Interfaces / protocol

- **Edit point:** `we:skills-src/jury/subject-jury.workflow.js`, inside `redTeamPrompt(subject, noun, material,
  materialFile)` (currently lines 697-728). Insert the checklist as additional lines in the returned array, after
  `'Ground every attack in the material; do not invent defects you cannot point to.'` and before the
  `...UNTRUSTED_MATERIAL,` spread — so the checklist reads as part of the adversary's brief, ahead of the material
  fence. Re-verify the exact line range against the file at build time; it may have shifted.
- **Shape (no schema change):** the checklist is prose inside the existing prompt string, e.g.:
  ```js
  'In particular, actively check for five HONESTY failure modes a generic hunt can miss because the material is',
  'not WRONG, it is OVERCLAIMED (#2697): INTERNAL-CONTRADICTION (a headline number/claim that contradicts another',
  'stated fact), FALSE-PRECISION (a forecast/estimate implying certainty on work that is blocked, unmeasured, or',
  'provisional), SCALE-UNPROVEN (a scale/volume/perf claim asserted but never rendered or measured), A11Y-TRUTH',
  '(an accessibility claim asserted with no evidence it was checked), and DATA-MODEL-TRUTH (the material assumes',
  'data that is not actually captured or stored — a by-eye check only; #2695 is the deeper automated version).',
  'Tag a finding\'s `category` with the matching lens name when one fits.',
  ```
  `category` on `RED_TEAM_SCHEMA` findings is already a free-text `string`
  (`we:skills-src/jury/subject-jury.workflow.js:444`) — no schema edit needed to let a finding self-tag with one of
  these five names.
- **Doc:** `we:skills-src/jury/SKILL.md`'s existing `## The mandatory post-jury red-team + fail-closed posture
  (#2707)` section gets one added line naming the five-lens checklist and citing #2697, so the skill's own
  description of what the red-team does stays accurate.
- **Test surface (new):** `we:skills-src/jury/__tests__/redteam-honesty-lenses.test.mjs` (name illustrative) —
  `readFileSync` the harness (mirroring `HARNESS`/`HERE` in `we:skills-src/jury/__tests__/panel-fanout.test.mjs`),
  extract the `redTeamPrompt` function's source by slicing between its `function redTeamPrompt(` declaration and
  the next top-level `function `/`const ` (or a regex bounding the block), and assert that slice `.toContain()`s
  each of the five lens names. Scoping the assertion to the function body (not the whole file) is what proves the
  checklist lives in the red-team's own brief rather than merely somewhere in the file.

## Tasks

1. Re-open `we:skills-src/jury/subject-jury.workflow.js`, confirm `redTeamPrompt()`'s current line range and the
   exact text of its last two lines (they may have shifted since 2026-08-15).
2. Insert the five-lens checklist paragraph per **Interfaces** above.
3. Add one line to `we:skills-src/jury/SKILL.md`'s `#2707` section naming the checklist.
4. Add the new test file asserting all five lens names appear inside `redTeamPrompt`'s own source slice.
5. Run `npm run test:unit` (or scope to `skills-src/jury` + `we:scripts/lib/__tests__/jury-core.test.mjs`) —
   green, no regression to the existing `we:skills-src/jury/__tests__/panel-fanout.test.mjs` suite.
6. Run `npm run check:standards` — 0 errors.
7. Resolve this card citing the PR.

## Done when

- [ ] `redTeamPrompt()` in `we:skills-src/jury/subject-jury.workflow.js` contains explicit, named checks for all
      five lenses: internal-contradiction, false-precision, scale-unproven, a11y-truth, data-model-truth.
- [ ] A new vitest suite asserts those five names appear inside `redTeamPrompt`'s own function-source slice (not
      merely somewhere in the file) — passing.
- [ ] `we:skills-src/jury/SKILL.md`'s `#2707` section documents the checklist by name.
- [ ] `RED_TEAM_SCHEMA`, `redTeamRequired`, `foldRedTeamVerdict` (`we:scripts/lib/jury-core.mjs`), and the
      `DISPOSITIONS` enum are byte-unchanged — confirms the card stayed a pure prompt enrichment and did not
      collide with #2950's in-flight disposition work.
- [ ] `npm run check:standards` — 0 errors.
- [ ] `npm run test:unit` (full suite, or at minimum every `skills-src/jury/**` and `scripts/lib/__tests__/jury-*`
      suite) — green.

## Delivery shape

One incremental, single-repo (WE) PR — prompt text + one doc line + one new test file. No schema, engine, or
cross-repo change; does not touch #2695's or #2950's files, so it can land independently of both and in any order
relative to them.

Superseded 2026-11-22 by #2707 (Its mandatory post-jury red-team mechanism already shipped as #2707 (per its own prep note).) [PL-WIP-CLEANUP / plateau rulings].
