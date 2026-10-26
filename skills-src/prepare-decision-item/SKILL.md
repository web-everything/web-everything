---
name: prepare-decision-item
description: Take an un-prepared open decision and do the research + authoring that brings its forks to the "Definition of Ready" — so the eventual decision turn is fast ratification, not cold research. Pure agent work (no human judgment): surveys prior art, publishes a /research/ topic, states each fork's options + bold default, then sets preparedDate so readiness tags it "✓ ready to ratify". Use when the user wants to "prepare" a decision, get a fork ready to decide ahead of time, or pre-research an open design call. To MAKE a prepared call, use /next decision instead.
---

# Prepare — bring an open decision to "ready to ratify", ahead of the call

Trigger + pointer — the method lives in
[backlog-workflow.md](../../../docs/agent/backlog-workflow.md): *backlog-workflow.md → Fork-readiness
pass*, *backlog-workflow.md → Per-fork classification pass*, and *backlog-workflow.md → The
prepared-fork shape*, which lean on *design-first.md → step 1 prior-art survey* and *research-workflow.md
→ publishing a /research/ topic*. Don't restate the rubric here; if the method changes, edit those docs.

Prep is the autonomous **half of a decision** — the research + authoring that can be done *ahead* of the
call, with no human judgment yet. It does *not* make the call; that's `/next decision`. When prep is done
the item carries `preparedDate`, so `check:readiness --select` ranks it prepared-first within Tier B and
tags it `✓ ready to ratify` (vs `○ needs prep`).

> **Runs in a lane — set it up FIRST (#2123).** Prepare *edits the tree* (the item body + a `/research/`
> topic), so like every edit-action session it runs in an **isolated lane clone**, never the shared primary
> checkout — `we:scripts/guard-lane.mjs` will hard-block a primary `Edit` mid-flow otherwise, forcing a
> re-home after you've already spent the research budget. So provision/enter a lane **before** step 3's
> authoring: `node we:scripts/lane-pool.mjs status --json` → pick a clean lane → do all authoring there →
> land via PR. The concurrency guarantee is the **hard local prepare-hold** (#2219 (b), shipped #2264):
> `prepare-hold` before you start, `prepare-stamp` the `preparedDate` **in the lane**, land one PR, then
> `prepare-release`. No `preparedDate`/`status` splice ever touches primary — see *Close out*.

## Quick path — the loop in commands

1. **Build the candidate set — un-prepared open decisions.** `npm run check:readiness -- --select
   --json` → take Tier B items where `preparedDate` is null (the `○ needs prep` ones). Blocked (Tier C)
   decisions aren't in that projection, so also one-pass scan `backlog/*.md` for
   `type: decision`/`review` + `status: open` + no `preparedDate`. `/prepare <NNN>` (or `<NNN-slug>`)
   focuses one item — skip ranking, go to step 3. Bare `/prepare` ranks the set.
2. **Rank by downstream-unblock leverage and recommend one** (same rule as *When nothing is
   agent-ready* → most dependents wins; tie-break smaller fork first). Present a short shortlist (top
   3–5, one-line rationale + leverage each) with two links per item ([live] · [md]) and your
   recommended pick. Prep is a real token spend (a prior-art survey + a `/research/` topic + authoring),
   so get one "go" on which item before burning it — *not* a multiple-choice; planning-as-discussion.
3. **Prepare-hold it (hard local lock), then enter the lane.** `node scripts/backlog.mjs prepare-hold <NNN>
   --session=<slug>` — a HARD local hold (#2219 (b) / #2264): `--select` skips it and `claim` refuses it
   until you `prepare-release`, so a concurrent session can't select or steal the fork you're researching.
   Unlike the old `claim --as=preparing`, it writes **no** frontmatter to primary — the item stays `open`,
   the hold is a local, lease-bearing token (refresh by re-holding across a long prepare). Emit the rename
   slug. Then work entirely in your lane clone (the lane-note above); the `preparedDate` gets stamped
   in-lane at *Close out*, never spliced onto primary.

## Doing the prep — the passes, in order (standing test first)

Run the documented passes on the claimed item, editing the item on disk (not just chat) — the durable
output is the rewritten body, not a message:

0. **Standing test FIRST — is each concern even a fork?** (*backlog-workflow.md → Standing test before
   any of the above — is this even a decision?*). Run the fork-existence test on every concern: a real
   fork exists only if exactly one branch is correct and the alternative is *broken* (forced invariant →
   ratify), or two coherent branches genuinely *cannot* coexist. If you can't name the broken/excluded
   branch, there is no fork — author it as a "Supported by default" entry, never a `## Fork N` with a pick.
   (The #756 miss: A and B were composable from one `traitEnforcerParcel` factory, so the call was
   *support both, default to the factory*.) **The standing test has *three* outcomes, not two**
   (*backlog-workflow.md → Third archetype — the validation-gate decision*): a concern is either (1) a real
   **fork** → `## Fork N`; (2) **support-both** → "Supported by default"; or (3) a one-sided **go/no-go on a
   candidate** (the #142 AI-generated idea cards) → the **validation-gate shape** (Digest+verdict ·
   prior-art delta · why-not-a-fork · recommendation = go/no/not-yet + concrete trigger + merit `Skeptic:`),
   no `## Fork N`. Don't drop a validation gate as "not a fork" — prepare it; just guard the #1620 soft-park
   (a bare "do we need this, on what trigger" with no delta/verdict is not a prepared gate). Worked example:
   [#1631](/backlog/1631-shareable-full-context-repro-bundle-for-the-dev-browser/).
1. **Prior-art research first — never author a fork cold** (*backlog-workflow.md → Fork-readiness pass*,
   first bullet). If the decision designs anything greenfield (a new intent/block/plug/protocol/adapter,
   or any "no design exists yet" call), run *design-first.md → step 1*: survey browser standards
   (MDN/WHATWG/W3C/WAI-ARIA APG) + the `references.json` benchmark libraries, reuse platform vocabulary,
   and publish the findings as a `/research/` topic — a `researchTopics.json` entry +
   `src/_includes/research-descriptions/{id}.njk` write-up (*research-workflow.md*) — keeping the session
   `reports/{date}-{slug}.md` as the artifact and linking it via `relatedReport`. A decision over
   already-researched ground just links the prior report; one that only ratifies shipped code skips the
   web survey but still needs the concrete-refs check. Research reshapes the forks — expect it to add or
   dissolve a fork (#64 gained Fork 4 from its survey); a pass that only confirms the existing framing
   means the survey was too shallow.
   - **Standard-layer grounding before any vocab→component mapping** (*backlog-workflow.md → Fork-readiness
     pass → Standard-layer grounding*). Before a fork's default maps a domain word (badge / pill / label /
     status / chip / tag, or any UX noun) onto a component, grep `src/_data/intents/` **and**
     `docs/agent/platform-decisions.md` for an intent/decomposition that already owns that vocabulary, and
     **cite the owning intent in the item**. Grounding the impl tree alone (does a `badge` component exist?)
     silently re-conflates vocabulary the standard layer already split — #1621 put taxonomy pills on the
     status badge, re-merging what #1319 split into Status Indicator / Tag / Notification Marker. A mapping
     that can't cite an owning intent is ungrounded (do the grep) or a genuine gap (the new intent *is* the
     fork).
2. **Per-fork classification pass** — run the fixed 7-question sequence (which layer? · protocol or
   intent dimension? · expose the whole axis? · fixed mechanic or dimension? · DI-injectable? · most-
   permissive default? · seam between intents?) on every element, and record the classification in the
   item — it *is* much of the eventual ruling. Honour the standing bias: separate and decouple (burden of
   proof is on combining). **Two verdicts are *dispositive non-fork* routes — apply them, don't write a
   `## Fork N` anyway** (the #1892 misses): a **config dimension** (Q4 = "both branches legitimate
   end-states" → `#config-extends-platform-default`: not a fork, no ratifiable default, default = the
   most-permissive *platform-default flavor* from Q6) and a **contract-derived classification** (Q1
   which-layer / the residue bar #1839 — *derive the contract from #1826 first, independently, then run the
   test; never narrow the contract to fit the answer you want*).
3. **Author the prepared-fork shape** (*backlog-workflow.md → The prepared-fork shape*) — rewrite the
   body to that shape. WE-specific reminders: pin each axis to concrete `file:line` refs into the real
   tree (go read the code, cite it — an authored snippet never substitutes); **open every `## Fork N`
   with its one-line fork-existence justification (#819)** — name the *flawed/excluded* branch (forced
   invariant) or *why the coherent branches genuinely cannot coexist* (real either/or); a fork that can't
   produce that line is a pass-0 miss, dissolve it to "Supported by default" rather than stamp over it.
   Only genuine forks get a
   preview-table row — support-both concerns from pass 0 go in the "Supported by default" list, not the
   table. A row whose "main alternative" isn't actually *excluded* is a pass-0 miss — demote it. Author
   the default to survive a red-team (*backlog-workflow.md → Red-team the default*): ground the default's
   rationale against the real tree now. **Add a concrete code example whenever the fork turns on a
   code-level shape** — an API surface, wire-form, attribute, schema, or call-site. A fork that is "which
   shape" stays abstract until you show the shape: write a short snippet for the default (and, where the
   contrast carries the argument, for the main alternative), keyed to the *real* API you grounded against
   (use the actual provider/registration calls, not pseudo-code) and labelled by fork + option. Skip it
   only for forks with no code surface (pure naming/ownership/scope/timing calls) — there a snippet adds
   nothing. The example is part of the fork's prepared shape, not chat-only (#1621 — examples go in the
   item).
   - **Make the call tangible with a real-life example** (*backlog-workflow.md → The prepared-fork shape
     → Make the call tangible*). Two forms, by decision kind. **Occurrences — always:** name the shipped
     systems the pattern already appears in (the "Known occurrences" — e.g. #2533's YouTube-scrubber /
     Percy citations); for a mint this *is* the corrected-bar justification. **A rendered mockup — when
     the fork is about what a *visual/UI surface* looks like:** don't stop at an ASCII sketch — build a
     small self-contained, operable mockup and embed it so the decider can *see and click* it. Mechanics:
     write the standalone HTML (its own `<style>`/`<script>`, no build) to `we:src/assets/<slug>/index.html`
     and embed it with `<iframe src="/assets/<slug>/" …>` in the item body — the backlog markdown renderer
     runs with `html: true`, so the iframe renders inline. **Two gotchas:** (1) *iframe* it, don't inline the
     markup — the mockup's generic classes (`.form`, `.chip`, `.note`) would otherwise collide with the
     backlog page's own CSS; the iframe is the isolation boundary. (2) Reference the **directory** URL
     `/assets/<slug>/`, **not** `…/index.html` — the locus-prefix write-hook (`we:scripts/lint-locus-prefix.mjs`)
     flags any bare `.html`/`.ts`/… path as an un-prefixed code-path ref, and a `we:` prefix would break the
     live URL; an extensionless directory URL sidesteps it cleanly (and resolves to `index.html` on the 11ty
     dev server). Worked example: [#2538](/backlog/2538-shape-the-annotated-visual-diff-surface-contract-then-decide-mint/).
4. **Run the skeptic pass *now*, in prep — don't defer the attack to the decision turn** (*backlog-workflow.md
   → Red-team the default*: prep is the primary skeptic seat). Prep that only *asserts* a default and tags
   "flag for the skeptic" leaves the attack to land at ratify time — the exact failure #1437 hit (prep
   asserted a Fork-2 default, the decision turn wobbled it, and only the ratify-time skeptic recovered it).
   Close it at the source: after authoring each fork's default, **spin up a throwaway skeptic sub-agent
   (prompted *only* to refute — `general-purpose`, default "this default is wrong") and have it attack the
   recommended branch of every fork, hardest on the high-leverage / high-`gates` ones.** The skeptic's
   prompt **must carry four attack axes, not one**: (0) **classification** *(run first — the #1892 axis)* —
   is this even the right *kind* of question? try to re-route it: is the `## Fork N` actually a **config
   dimension** (`#config-extends-platform-default` — two values of one knob, not a fork), a *support-both*, or
   *settled by precedent*; and if the classification turns on a **contract** (residue #1839 / which-layer),
   is the contract the **coherent-standard** one (#1826) or one **narrowed to fit the answer**? — then
   (1) *merit* — is the default wrong on correctness /
   composability / a11y / lock-in? and (2) **statute-overlap** (*backlog-workflow.md → Red-team the default
   → Statute-overlap check*, #1886) — *if this decision will set `codifiedIn`, does the rule it would write
   collide with or duplicate an anchor already in [platform-decisions.md](../../../docs/agent/platform-decisions.md)
   governing the same turf by a different test?* Draft the codified claim, grep `platform-decisions.md` for
   same-subject anchors, and have the skeptic try to find the collision — the axis whose miss is
   un-recoverable downstream (a statute conflict found at *resolve* lands after the human has ratified, when
   the call is immutable and the only honest move is a new reconciliation item; prep is the last cheap fix).
   Then (3) **citation-scope** (*backlog-workflow.md → Red-team the default → Citation-scope check*, #1932) —
   *for each anchor a default cites to **authorize** a branch, does the cited rule's authoring scope actually
   reach this case?* A value-default rule must not be cited as authority over an engine-robustness question; a
   single-author / catalog-evolution rule must not authorize cross-author extension. Read the cited anchor's
   own scope; if it governs a narrower turf, downgrade the citation from *authority* to *supporting context*
   and re-derive the default on its merits (the #1913 miss: `:385`'s value-default clause cited against an
   unknown-**id** robustness fork). Then **resolve its
   findings into the item before stamping**: REFUTED → flip the default + rewrite the rationale; SURVIVES →
   record the surviving rationale (the attack it beat); SURVIVES-WITH-AMENDMENT → fold the amendment in;
   **statute overlap found → reconcile it in the item now** (cite the sibling anchor, state how the two rules
   compose) so ratification never inherits an unreconciled conflict.
   The durable output is a one-line **`Skeptic: <verdict + what changed>`** note under each `## Fork N`, so
   the decision turn sees an already-attacked default, not a raw assertion. Never leave a bare "flag for the
   skeptic" marker — running it *is* prep's job. (The decision-turn red-team in *backlog-workflow.md* stays,
   but as a *confirmation* + a re-attack only if the discussion surfaced something new — no longer the first
   time a skeptic sees the fork.)
5. **Two-confusion screen — fresh-context, every fork, before the stamp** (*backlog-workflow.md → The
   prepared-fork shape → Two-confusion screen*, #2091). Distinct from the pass-4 skeptic (which attacks the
   *default*): spawn a **separate throwaway agent that has not seen this session's authoring** and have it
   answer exactly two questions per `## Fork N` (and per validation-gate verdict): (1) does the fork rule on
   an **implementation detail** — invisible to a consumer across the WE↔FUI boundary — or put an impl
   concern on the standard side? (2) with both branches imagined *free to build and instantly maintained*,
   does a **merit** difference remain, or is this **prioritization** in fork costume? Record a **`Screen:`**
   line beside each `Skeptic:` line (`Screen: clear` / `Screen: flagged(impl|prio) → <fix applied>`), and
   **rewrite any flagged fork before stamping** (re-layer the impl detail, or dissolve to ruling + a
   separately-prioritized build). The screen is mandatory on every fork — no leverage exception — because
   these two framing flaws are what a same-session skeptic is structurally blind to.

6. **Pre-register the review jury — early human alignment (#2638, care-gated).** A settled #2636 design call:
   for an **elevated/high-care** item, author a *provisional* review jury onto the body **before any code is
   written**, so the human aligns on the review bar up front and the pre-registered expectations kill post-hoc
   goalpost-moving (a juror can't invent a new bar at review time that was never registered). This reuses the
   SAME care dial that sizes review rigor, so **skip it for `low`/`none` care** — aligning every juror up front
   is real cost that only an elevated/high change earns. Mechanics (all pure, from `we:scripts/lib/review-core.mjs`):
   - **Estimate the care band** from the item's escalation-predictive signals — a scope touching statute /
     gate-self is `high`, system-machinery / cross-repo is `elevated`, a routine change is `low`/`none` (the
     same signals `deriveCareLevel` reads; you don't have a diff yet, so estimate from the item's nature).
   - **Run the touch-set probe (#2619) — it feeds the charter AND scopes any buildable child. This probe is
     NOT care-gated — run it even at `low`/`none` care** (only the jury build/render/embed below is skipped
     below the floor; a child still needs a scope regardless of the decision's care band). Predict the
     coarse, repo-qualified, prefix-shaped touch-set of the work this decision authorizes (narrowest prefix
     that still covers it — a whole directory `we:scripts/readiness/` when the work spans it, a single file
     `we:scripts/backlog.mjs` when it doesn't; #2679). This touch-set does double duty: it is the
     `changedFiles` the charter reads (next bullet), and — since a *decision* is ratified, never dispatched to
     build, so it carries **no** build-`scope:` of its own — it seeds the **`scope:` of each buildable child**
     the close-out carves off this fork (close-out step 1). When a fork carves *several* children, give each
     child only **its own slice** of the touch-set, not the whole set onto every child — identical scopes
     would make the children mutually overlap and serialize (the exact opposite of the parallelization goal,
     #2609). Those children then arrive at Definition of Ready already scoped, no auto-prepare round-trip.
     Don't stamp `scope:` onto the decision item itself.
   - **Build + render the charter:** `buildJuryCharter({ careLevel, changedFiles })` — pass that predicted
     touch-set as `changedFiles`, so a UI-file touch-set earns the
     a11y + visual seats a script-only one does not. It derives the provisional roster from the same
     `resolveJuryPlan` the open-time jury uses and attaches each juror's up-front **expectation** (the concrete bar,
     single-sourced in `LENS_EXPECTATIONS`). Below the floor it returns an un-registered charter with the skip
     reason — that is expected, not an error.
   - **Embed it:** append `renderJuryCharter(charter)`'s markdown to the item body (a `### Review jury (provisional
     — pre-registered #2638)` block for a registered charter, or the one-line skip note below the floor). The
     charter is **provisional** — it binds against the predicted scope now and #2636 re-checks it against the real
     diff at PR open (drift past registration re-triggers alignment), so don't over-invest: it is the bar to align
     on, not a contract.

## Close out — stamp prepared in-lane, land one PR, release the hold

A prepared decision is **still open** — the call hasn't been made. So `prepare-stamp` (not `resolve`) and
land the `preparedDate` via the lane→PR; `resolve` is the *decision* turn's job, not prep's:

1. **Gate before stamping — every fork must actually be at DoR, *including* the one you'd rather leave
   "for the human."** Prep's whole job is to bring the human-judgment fork to options + tradeoffs + a
   bold recommended default the decider then ratifies or overrides — not to hand the human a raw
   question. A fork you couldn't shape that way is un-prepared, not "deferred": either shape it (it almost
   always can be — even a naming/ownership/scope call gets researched options + a default; see #009's
   "mint `webpush` vs fold the protocol into an existing project" fork), or carve it to a child item that
   is *itself* prepared and rewrite the parent fork to "→ delegated to #NNN (prepared)". **A buildable child
   you carve off is scaffolded WITH its predicted `scope:`** — pass that child's slice of the #2619 touch-set
   as `scaffold --scope=<coarse,prefix,shaped>` (run the step-6 probe here if the care-gated jury step was
   skipped — the probe itself is not care-gated), so the child arrives at DoR already scoped rather than
   forcing a downstream auto-prepare. A body still
   carrying a bare "needs a human call" / "confirm X" / "TBD" / slash-name (`webpush`/`webpermissions`)
   fork is not prepared — do not stamp it. **Scan the *whole body*, not just the `## Fork N` headings, for
   a live choice left as prose** (*backlog-workflow.md → no live choice may sit outside a `## Fork N`*):
   "open residue", "decide at ratification", "whether v1 ships X or Y", a "TBD"/"to be decided" anywhere, a
   glance-table footnote, a "Net mechanism … open question:" trailer. Each such aside is an un-prepared fork
   in disguise — the structural reason `prepare` and the decision turn *diverge* (#1935); promote it to its
   own `## Fork N` (research it now), fold it into an existing fork's default, or drop it. Then walk every
   `## Fork N` and confirm each has its fork-existence
   justification line (#819), named options,
   tradeoffs, a bold default, **a `Skeptic:` verdict line** (the pass-4 attack was run and its findings
   folded in — a fork with no `Skeptic:` note is un-attacked, so not at DoR; do not stamp it), **and a
   `Screen:` verdict line** (the pass-5 fresh-context two-confusion screen ran and any flag was fixed — a
   fork with no `Screen:` line is un-screened, so not at DoR; do not stamp it) — **plus a
   concrete code example for any fork that turns on a code-level shape** (API/wire-form/attr/schema/call-site;
   a code-shape fork with no snippet is not at DoR — pure naming/ownership/scope/timing forks are exempt). **If the
   item is a *validation-gate* decision** (third archetype — a go/no-go on a candidate, no `## Fork N`),
   gate on its shape instead: confirm a Digest+verdict (go/no/not-yet), a prior-art delta, a *concrete*
   un-gate trigger, and a merit `Skeptic:` line — and that it is **not** a bare "do we need this, on what
   trigger" (the #1620 soft-park). Then stamp. **Use the
   fixed fork-labeling convention** (*backlog-workflow.md → the
   prepared-decision shape*): numbered `## Fork N` section headings, lowercase `(a)`/`(b)`/`(c)` options
   referenced as "Fork N (a)", a second-level choice as a "Fork N sub-fork" — never `## Fork (a)` or
   `A1`/`B2` aliases.
   **Trust boundary and threat model (REQUIRED).** For any item that runs, publishes or trusts untrusted
   output, add that section and run a design red-team on it before stamping: either the `/jury` panel on the
   prose, or a Gemini red-team via local agy (`scripts/gemini-direct-task.mjs`, model from the
   vendor-routing setting); PR reviews still use the review panel (*backlog-workflow.md → Definition of Ready → Trust boundary and threat model*).
   Then stamp `preparedDate` **in the lane** with `node scripts/backlog.mjs prepare-stamp
   <NNN>` (writes `status: open` + `preparedDate: <today>` into the lane's item file — the one flag that
   makes readiness rank it `✓ ready to ratify`, so stamping a half-prepared item is a false "ready" the next
   decision turn will trust). `prepare-stamp` is blocked from a primary cwd and allowed in the lane, so this
   splice lands via the one PR, never onto primary — do **not** hand-Edit `preparedDate`.
2. **Gate:** `npm run check:standards` green (and the new `/research/` topic renders — confirm the
   `researchTopics.json` entry + `.njk` write-up parsed), and — for a decision item with `## Fork N`
   sections — `npm run check:health` green too (catches a G4 false-prepared-fork tell before review
   instead of after a bounce; the #3427 prep bounced review:changes on exactly this). Confirm a
   `relatedReport` link exists.
3. **Land the one PR, then release the hold.** Commit the item file + `/research/` topic in the lane and
   land it via `we:scripts/pr-land.mjs` (the standard transport). Once the PR is open/landing, drop the
   hold: `node scripts/backlog.mjs prepare-release <NNN>` — the item is `open` + prepared and claimable
   again. Do not `resolve` — resolving is the *decision* turn's job, not prep's.
4. Close with a one-line net-flow note (item `#NNN` now `✓ ready to ratify`, research topic published)
   and point at `/next decision` to make the call when ready.

## Relationship to `/next decision`

Prepare is the upstream feeder for `/next decision`: it pays the research cost once, ahead of time, so
the decision turn is a fast ratification. Run `/prepare` to manufacture ready-to-ratify decisions, then
`/next decision` to ratify them.
