---
kind: decision
size: 3
status: open
locus: webeverything
preparedDate: "2026-07-03"
relatedReport: reports/2026-07-03-constellation-branding-system.md
relatedTo: ["1034", "2207", "1283", "1587"]
dateOpened: "2026-07-03"
dateStarted: "2026-07-03"
tags: [branding, design, naming, favicon, logo, iconography, brand-philosophy, decision]
---

# Ratify the constellation branding system — philosophy, naming, marks, icon rules

The 2026-07-03 cross-project branding review (rendered gallery: `plateau:branding.html`, generated
by `plateau:scripts/gen-branding.mjs` from the live assets of all three repos) found the brand
*system* already coherent — all three marks share one construction (40×40 squircle, `rx="12"`, 45°
gradient, white glyph; `we:src/assets/logo.svg`, `fui:src/assets/logo.svg`, `plateau:favicon.svg`) with
one hue per project — but six live choices sit unratified, plus a tier of mechanical drift.

**Visual candidates for every mark fork are rendered side by side (64/32/16 px) at
`plateau:branding.html#proposals`** (on the plateau dev server, port 4000; candidate sources:
`plateau:branding-proposals/` SVGs + manifest). Survey, inventory, and the branding-methodology
write-up that grounds Fork 6 (kept durable for the #2207 design-AI reviewer training):
[report](../reports/2026-07-03-constellation-branding-system.md) ·
[/research/](/research/#constellation-branding-system).

### Recommendation at a glance

| Fork | Recommended default | Main alternative (excluded) | Confidence |
|---|---|---|---|
| 1 — canonical prose name of the impl repo | **(a) "Frontier UI"** | (b) "FrontierUI" | Med-high (~75%) |
| 2 — WE mark at favicon sizes | **(b) W-only favicon variant ≤32px** | (a) identical W+ghost-E at all sizes | High (~85%) |
| 3 — FUI mark strategy | **(b) concept-bearing symbol, sub-fork (b1) horizon** | (a) keep FUI letterforms | Medium (~65%) |
| 4 — Plateau violet: one value | **(a) favicon adopts token `#6453f4`** | (b) token retints to favicon `#6d5efc` | High (~90%) |
| 5 — Plateau mark geometry | **(a) keep current dual mesa** | (b) grounded / (c) strata restatement | High (~85%) |
| 6 — brand rubric: content + integration shape | **(a) adopt attribute sets + narrative as a parallel brand rubric** | (b) fold into #1034 as v3 axes / (c) archetypes or uncodified (foreclosed by precedent) | Med-high (~75%) |

## Fork 1 — canonical prose spelling: "Frontier UI" vs "FrontierUI"

**Why it's a fork (real either/or):** both spellings are coherent conventions, but a canonical prose
name is definitionally singular — and the corpus is genuinely split: ≈174 "Frontier UI" across WE +
plateau src vs 36 "FrontierUI", with FUI's own repo *internally* split (its newer prose — `fui:AGENTS.md`,
`fui:CLAUDE.md`, blocks code comments — writes "Frontier UI"; the compound is confined to the older
rendered site templates). Only a ruling settles it. Code identifiers are out of scope: `frontierui`
(pkg name) / `frontier-ui` stay as-is under both branches, per the npm-scope package-naming ruling in
`we:docs/agent/platform-decisions.md` (package ids have their own ratified convention; this fork is
prose only).

- **(a) "Frontier UI" — two words. [bold default]** Matches the ecosystem majority *and* FUI's own
  newer prose; two-word wordmarks read better in running text and lockups (see the Fork 1 lockup render
  on the proposals page); precedent: mainstream libraries style multi-word product names with spaces in
  prose ("Material UI", "Chakra UI", "Radix UI") while keeping compound package ids. The migration set
  is FUI's rendered site surfaces — `fui:src/_layouts/base.njk` (default `<title>`, header wordmark
  lockup, footer), `fui:src/index.njk` `<h1>`, `fui:src/_data/site.js` `name` — a real but bounded,
  enumerable set.
- **(b) "FrontierUI" — compound.** Matches the `frontierui` package id 1:1 and the older rendered
  templates; but it contradicts FUI's own newer prose and the ecosystem majority, and camel-compound
  prose names are the minority convention in the reference-library cohort.

Skeptic: SURVIVES-WITH-AMENDMENT — the prep's original rejection ("no shipped artifact renders
'FrontierUI' as a brand surface") was *false*: the FUI site header wordmark, title, h1, and footer all
render it. Folded in: the migration set is now stated honestly (the rendered site surfaces), and the
default survives on the corrected grounds — ecosystem majority + FUI's own newer prose already write
(a), and the recognition delta is bounded by the team-of-one audience.
Screen: clear — pure naming call, no impl detail, merit (one canonical name) not prioritization.

## Fork 2 — WE mark at favicon sizes: identical everywhere vs W-only small variant

**Why it's a fork (real either/or):** the mechanics can support both artifacts (multiple
`<link rel="icon" sizes>` is standard) — the exclusivity is *policy*, not file count: strict one-mark
identity ("the mark is never simplified") and size-tuned variants ("the 16px slot shows what 16px can
carry") are contradictory brand rules for the same slot, and the house must pick one.

- **(a) current W + ghost-E at all sizes.** One mark everywhere; zero variant-sync burden. But at 16px
  the reflected E spans ~2.4px at 60% opacity — it renders as under-glyph noise (see the 16px cells on
  the proposals page), and the favicon is the mark's highest-frequency surface.
- **(b) W-only favicon variant at small sizes — [bold default].** Keep the full W+E mark at ≥32px
  (header logo, social cards); ship a W-only, heavier-stroke (2.5→3) favicon
  (`plateau:branding-proposals/fork2-b-w-only.svg`). Size-tuned mark simplification is established
  practice (Firefox's 2019 simplified-mark system; type/icon vendors ship per-size optical grades).
  Cost, stated honestly: the two variants' shared W geometry stays in sync by *judgment* (the
  `check:branding` gate below covers icon-template rules, not favicon-variant geometry) — the
  regenerated `plateau:branding.html` side-by-side is the standing review surface for that.

Skeptic: SURVIVES-WITH-AMENDMENT — attack was "the ghost-E *is* the identity (W+E = Web Everything);
dropping it at the most-seen size erodes the pun to a generic W," plus two defects: the GitHub
precedent was misused (GitHub's favicon is the same symbol, wordmark-dropped — it argued for (a));
and "cost bounded by the gate" overreached. Folded in: GitHub cite dropped; variant-sync cost restated
as unhooked judgment; (b) stays scoped to ≤32px favicon surfaces with the full mark mandatory ≥32px so
the W+E identity remains canonical — the favicon is a legibility-degraded echo, not the identity
carrier. Screen: clear — observable brand surface, not impl; merit (legibility at the
highest-frequency size).

## Fork 3 — FUI mark: keep letterforms vs a concept-bearing symbol

**Why it's a fork (real either/or):** one primary mark ships; "FUI" letterforms and a symbol are
mutually exclusive as that mark. Both are coherent: letterforms maximize name-recognition, a symbol
maximizes distinctiveness and small-size quality. The review's bar — stated precisely — is
**concept-bearing**, not "symbol-first": WE's kept mark is letterforms *carrying an idea* (the W/E
reflection pun), the mesa carries an idea (a literal plateau); FUI's three crammed strokes carry none.

- **(a) keep FUI letterforms.** Legible, zero work, name-first. But it's the weakest mark in the
  review: no idea, and the 85%-opacity U/I reads as accidental fading; it fails the concept-bearing
  bar on its own terms.
- **(b) concept-bearing symbol — [bold default].** Three candidates rendered on the proposals page,
  all in the existing teal→cyan hue and squircle construction. b1's case stands without Fork 6:
  simplest geometry of the three, cleanest at 16px, and a *literal* frontier. Scored against the
  proposed FUI attribute set (*pioneering · pragmatic · kinetic* — usable even if Fork 6 lands
  elsewhere): b1 pioneering ✓ / pragmatic ✓ / kinetic ✗ (static sunrise); b2 pioneering ✓ /
  pragmatic ~ / kinetic ~; b3 pioneering ✓ / kinetic ✓ / pragmatic ✗ (collides with generic
  share/export arrow glyphs — ambiguity is a pragmatism failure). No candidate sweeps; b1 wins on
  clarity-per-pixel with one honest miss.
  - **(b1) horizon — sun over the frontier line. [recommended sub-fork pick]** If Fork 6's landscape
    narrative also ratifies, the mesa/horizon motif family is a free bonus — supporting context here,
    not the argument.
  - **(b2) boundary-marker flag** — planted-flag metaphor; slightly busier at 16px.
  - **(b3) past-the-edge arrow** — most kinetic; generic-arrow collision risk (reads "share"/"export").
  - The sub-fork pick stays open to override at ratification with the Fork 6 rubric in hand — the
    scoring above is the prep's application of it, shown so the decider can re-run it.
- Rollout note if (b): WE's category icon `we:src/assets/icons/frontierui.svg` (currently "FU") follows
  the ratified mark (Supported-by-default alignment below).

Skeptic: SURVIVES-WITH-AMENDMENT — attacks were (i) circular bootstrapping (b1 justified by Fork 6's
narrative while Fork 6 was sold as motivating b1), (ii) "symbol-first" bar contradicted by WE's own
letterform mark, (iii) sub-pick made without scoring candidates against the proposed rubric, plus the
recognition-continuity attack (rebuffed: team-of-one audience means rebrand cost ≈ zero now, maximal
later). Folded in: bar renamed concept-bearing; b1's rationale de-coupled from Fork 6; inline
attribute scoring added with the sub-pick explicitly overridable. Confidence stays Medium — taste
legitimately dominates. Screen: clear — mark choice is boundary-observable; merit not prioritization.

## Fork 4 — Plateau violet: favicon `#6d5efc` vs token `#6453f4`

**Why it's a fork (forced alignment, two coherent resolutions):** the mark and the token layer state
two different brand violets — drift, not intent. Exactly one value can be *the* Plateau violet; the
fork is only which side moves.

- **(a) favicon adopts the token `#6453f4` — [bold default].** The token layer *already claims the
  brand gradient by name*: `plateau:src/styles/tokens.json` defines
  `gradient.brand = linear-gradient(120deg, #6453f4 0%, #16d3e6 100%)` — the favicon's gradient is a
  drifted hand-copy of exactly that token (its end stop `#16d3e6` still matches). #1283 (resolved
  story) established the tokens-as-source convention for Plateau's theme; the favicon is hand-authored
  (not generated), which is *how* it drifted. Align the copy to the naming owner:
  ```svg
  <!-- plateau:favicon.svg -->
  <stop stop-color="#6453f4"/>   <!-- was #6d5efc; matches gradient.brand + --color-primary -->
  ```
  Side-by-side render on the proposals page shows the shift is imperceptible at favicon sizes — this
  alignment is visually free.
- **(b) token retints to `#6d5efc`.** Coherent only if the favicon violet is judged *better*; but that
  retint cascades through every `--color-primary*` consumer (hover, light, gradients) for no observable
  brand gain, and inverts the tokens-as-source convention.

Skeptic: SURVIVES-WITH-AMENDMENT — attack confirmed the drift and direction but caught two stretched
citations: #1283 is a resolved *story* (convention, not ratified statute), and the favicon is not a
"derived artifact" (nothing generates it). Folded in: the authority is now the `gradient.brand` token
itself — the token layer literally owns a token named *brand* with this colorway — with #1283 as the
convention it rides. Screen: clear (with the screen's note that this is the thinnest fork —
principle-resolved, the two violets being observably near-identical — which is accepted: that is what
makes (a) free). Not a config dimension: the *drift* is the flaw; both values persisting is the broken
branch.

## Fork 5 — Plateau mark geometry: keep dual mesa vs refinements

**Why it's a fork (real either/or):** one mark ships; the current dual mesa and the two refinement
candidates are mutually exclusive geometries. Filed *because the favorite mark still deserves the
critical pass* — the candidates test its two arguable weaknesses (the mesas float unanchored; the
front/back overlap is heavy at 16px).

- **(a) keep the current dual mesa — [bold default].** It's the review's quality bar and the
  user-validated favorite; both critiques are mild and neither refinement clearly beats it side by side
  (see proposals page, Fork 5 row). Ratifying the incumbent is a real decision: it locks the mark and
  becomes a Fork 6 ground-truth label (#2207).
- **(b) grounded dual mesa** — adds a horizon baseline; anchors the composition but adds a third
  element at 16px and (with Fork 3 b1) makes the horizon line do double duty across two marks.
- **(c) stacked strata mesa** — restates the mesa as tiers, echoing WE's `we:src/assets/icons/plateau.svg`
  category icon; strongest small-size silhouette of the three, but reads more "layers/stack" than
  "plateau" and breaks from the silhouette the user already prefers.

Skeptic: SURVIVES — attack was "(c) is objectively stronger at 16px and rhymes with the WE category
icon; preferring (a) is pure incumbency." Rejected on merit: (a)'s overlapping-mesa depth *is* the
distinctive feature — (c)'s banded pyramid is verifiably near-identical to generic layers/stack
iconography (collision risk), and the cross-repo rhyme is achieved more cheaply by realigning
`we:src/assets/icons/plateau.svg` (confirmed amber today; that realignment is owed under either
branch). For a pure-taste call the user's validated preference is legitimate authority.
Screen: clear — mark geometry, boundary-observable; merit not prioritization (all three are built).

## Fork 6 — brand rubric: attribute-set content + integration shape

**Why it's a fork (real either/or), re-scoped after the statute check:** the house method for design
judging is *already rubric-shaped and ratified* — the #1034 design-critique rubric v2
(`we:docs/agent/vision-tiers.md`, "Design-critique rubric"; anchored in
`we:docs/agent/platform-decisions.md` as the vision service's output contract), closed-axis,
versioned, with per-axis provenance (#1587). That precedent substantially *forecloses* "archetypes vs
uncodified taste" as house methods. What remains genuinely open — and cannot coexist in two forms —
is (i) **which brand-attribute content** the constellation adopts, and (ii) the **integration shape**:
a parallel brand rubric beside #1034's page-critique rubric, or new brand axes folded into #1034 as a
v3 version bump. One owner of brand judging must be named.

- **(a) adopt the proposed attribute sets + landscape narrative as a parallel brand rubric —
  [bold default].** A sibling artifact to the #1034 rubric (same discipline: closed attribute sets,
  versioned, each attribute carrying provenance to this ruling + the research topic), applied to
  *brand artifacts* — marks, lockups, palettes, names — while #1034 v2's page-critique axes stay
  untouched (its axis 8 "aesthetic polish/craft" continues to own page-level polish). Proposed
  content (rendered as lockups on the proposals page):
  - **Web Everything** — *universal · principled · inevitable*; target feeling: **calm trust** — it
    should feel like bedrock ("The web is the platform").
  - **Frontier UI** — *pioneering · pragmatic · kinetic*; target feeling: **capable momentum** — the
    working edge where the standard meets real ground.
  - **Plateau** — *elevated · steady · commanding*; target feeling: **assured overview** — high flat
    ground: see everything, stable footing.
  - **Shared narrative (the landscape story):** bedrock → horizon → plateau — WE is the ground
    everything stands on, FUI is the horizon where new ground is claimed, Plateau is the high ground
    you operate from. Generative rule for future mark/icon work, not just a style cop.
  - **Shared baseline attribute (all three sets): ownable** — the mark must be distinctive at 16px;
    operational test: *"could this be another brand's logo?"* (Prep amendment 2026-07-03, from the
    user's critique of a W-only favicon candidate — "could be a logo of anything"; the original sets
    had no distinctiveness attribute, so the rubric could not even represent that verdict.)
  Every brand verdict names the owning attribute set and the attribute served/violated — the same
  cite-the-statute discipline decisions follow. Trainability, stated precisely: what makes this
  trainable is the **labeled fixture + agreement metric + per-attribute exemplars** (#2207 — the
  ratified picks of this very item are the first labels), not the bare checklist shape.
- **(b) fold brand attributes into #1034 as v3 axes.** Excluded on axis-scope mismatch: brand-mark
  judging fires on marks and lockups, not rendered pages — bolting brand axes onto every page critique
  makes page reviews carry non-applicable axes and forces a rubric version bump for an orthogonal
  artifact class.
- **(c) archetype framework (WE ≈ Sage, FUI ≈ Explorer, Plateau ≈ Ruler) or uncodified taste.**
  Foreclosed as the *house method* by the #1034 precedent (the house judges by closed, versioned,
  provenance-carrying rubrics); the archetype mapping is kept as narrative color in the research
  topic. Uncodified taste is additionally the status quo that produced this item's drift tier and
  leaves #2207 nothing to train against.

**Statute reconciliation:** (1) `we:docs/agent/vision-tiers.md` design-critique rubric — no collision
under (a): different artifact class (brand assets vs rendered pages), cross-referenced, both follow
the same rubric discipline; the brand rubric adopts #1587-style provenance from birth. (2) The
brand-on-distinctness anchor in `we:docs/agent/platform-decisions.md` governs *when a separate brand
may exist*; this rubric governs *how an existing brand's expression is judged* — adjacent turf,
scope-fenced, no overlap. (3) The attribute sets ratify as **defaults with a review horizon** (the
research topic carries `reviewHorizon: P6M`), answering the fossilization attack.

Skeptic: SURVIVES-WITH-AMENDMENT — the statute-overlap axis found the #1034 rubric collision (the
original fork framing "rubric vs archetypes vs taste" ignored that the house already ratified
rubric-as-method); fork re-scoped to content + integration shape, reconciliation added, trainability
claim re-grounded in the fixture rather than the checklist. Screen: clear — the rubric is a
review-process artifact observable in every future brand verdict; choosing its owner and content is
merit, not prioritization.

---

## Supported by default (not decisions)

- **"WebEverything" (camel) is banned** — a third spelling variant with zero design rationale (11 uses,
  all in `plateau:src/`), contradicting the prose majority in every repo. Flawed branch, not a fork;
  ratification codifies the ban alongside Fork 1's pick.
- **Cross-repo referring icons must match the referent's own ratified brand** — forced invariant (an
  icon of a *named product* that contradicts that product's mark is wrong, not a style choice):
  `we:src/assets/icons/plateau.svg` (amber) realigns to Plateau's violet/cyan mesa;
  `we:src/assets/icons/frontierui.svg` ("FU") realigns to the Fork 3 outcome.
- **Icon-set template rules become a gate — with the ruling tightening them to script-decidable
  form.** `we:src/assets/icons/_template.svg` states "min 6px stroke *for outlines*" — "outline" is a
  judgment word, so the ratified rule is the absolute, hookable floor: in `we:src/assets/icons/`,
  every `viewBox` must be `0 0 128 128`, every `stroke-width` ≥ 6, gradient stops from the template
  palette. Measured today: 1 icon at 24-viewBox, stroke-widths 1.75–12 across the set. Enforcement is
  a `check:branding` validator in `check:standards` (per hookable-vs-judgment; precedent: the
  manifest-key validator in the statute layer), filed as a follow-up story. (The Icon *Intent* —
  `we:src/_data/intents/icon.json` — governs product iconography dimensions and is untouched; these
  are site-asset authoring rules, a different layer.)
- **Broken/weak icon rebuilds are stories, not forks** — `we:src/assets/icons/webtraces.svg` (a single
  circle), `we:src/assets/icons/weblayout.svg` (off-template 24×24 outline duplicating `layout.svg` —
  merge them), and the thin red-stroke subfamily (`anchor`, `layout`, `loader`, `message`, `navigation`,
  `temporal`, `range-anchor`) rebuild to the strong-tier shape. Which to rebuild first is
  prioritization, decided at scheduling time.

## Context

- **Classification (per-fork pass):** branding is repo/site meta-asset authoring — no WE standard
  artifact, protocol, or intent changes anywhere in this item; nothing crosses the WE↔FUI impl
  boundary. `locus: webeverything` because the statute (spelling ban + gate rule + Fork 6 rubric)
  codifies here; the asset edits fan out per repo as children.
- **On ratify, file the children:** WE favicon small-variant (Fork 2), FUI mark rollout incl. the
  rendered-site spelling migration (Forks 1+3), Plateau favicon stop alignment (Fork 4), cross-repo
  icon realignments, the `check:branding` gate story, the icon-rebuild batch, and the Plateau
  full-logo lockup story (mesa + wordmark; Plateau has no logo asset today — favicon only) —
  prioritized at scheduling like the rest.
- **Testing-ground link:** the ratified picks (all six forks) become the first labeled ground truth for
  the design-AI reviewer training card (#2207) — the branding gallery + proposals page is its
  regression fixture, and the Fork 6 rubric + methodology research topic is its knowledge base.
- **Review surface:** any brand-asset change regenerates `plateau:branding.html`
  (`npm run gen:branding`) — the standing before/after visual-check surface for branding edits.
- **Ratify step:** the ratification of these forks lives here in #2209. The rollout work after ratification stays on #2255, which is kept open.

Ratified 2026-11-22 (PL-BRAND-RATIFY): ratified in one sitting with #2249 and #2250; plan step DZ-BRAND-OK carries the sign-off.
