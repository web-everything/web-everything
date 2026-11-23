---
kind: decision
size: 2
status: open
parent: "2256"
blockedBy: ["2249"]
locus: webeverything
relatedTo: ["2209", "2249"]
preparedDate: "2026-07-04"
relatedReport: reports/2026-07-04-constellation-visual-language-and-color-architecture.md
dateOpened: "2026-07-04"
tags: [branding, design, web-everything, color, decision]
---

# WE mark system — multi-color umbrella vs monochrome

The user-favored WE direction is the **constellation-color union** (WE-indigo + FUI-cyan +
Plateau-violet = "Web Everything = the whole constellation unified"). The question is how WE carries
"all the colors" as a *system*: does WE stay single-hue (strict monochrome), or become the umbrella that
spans the family palette — and if the latter, **as a rule-compatible multi-stop gradient or as
rule-breaking overlapping color regions (a Venn)?** Amendment to #2209's construction-system section.

## Grounding digest

The construction rule this fork amends is one gradient + one white glyph per project. WE's is a single
indigo→purple gradient today: `we:src/assets/logo.svg:13-14` (`#4f46e5` → `#9333ea`); FUI is teal→cyan,
Plateau violet→cyan — each **one gradient spanning its own hue-range**. The umbrella candidates were
probed the risky way: `plateau:branding-proposals/loop/we-venn-lumin.svg` overlaps three translucent
radial circles under `mix-blend-mode:screen` (`:16`) — the muddy-blend, floating-Venn form; siblings
`weB-venn-constellation.svg` / `we-venn-flat.svg` are the same family, none clean at 16px. Prior-art
survey (JetBrains' umbrella is a **smooth multi-stop gradient** square, not a Venn; NBC is a defined
silhouette; Adobe/Material run the *inverse* restrained-parent rule; overlapping-circles is the
ownability cliché; `mix-blend-mode:screen` mud):
[report](../reports/2026-07-04-constellation-visual-language-and-color-architecture.md) ·
[/research/](/research/#constellation-visual-language-and-color-architecture). Candidates render at
`plateau:branding.html#journeys` (Round 8: WE-37/38).

## Axis-framing

Two things were conflated in the original filing and must be split: the **meaning goal** (WE should read
as "the whole constellation unified") and the **execution form** (how that is drawn). The meaning goal
is legitimate and user-favored. The trap is assuming it requires *overlapping color regions* (a Venn) —
which would genuinely break the one-gradient rule, is the single most worn B2B ownability cliché (fails
#2209's own baseline attribute "could this be another brand's logo?"), renders muddy in hand-authored
SVG, and — decisively — **collides with #2209 Fork 2**, whose ratified default degrades the WE favicon
to a *mono W-only glyph ≤32px*; a tri-hue union that must be legible at 16px is the direct contradiction
of that same slot. But the meaning goal has a rule-compatible expression the skeptic surfaced: **a
single gradient can span all three constellation hues** (indigo→cyan→violet). A 3-stop gradient is still
"one gradient" — it does *not* break the rule, it is exactly JetBrains' actual umbrella construction
(a palette-spanning gradient square over per-product sub-range squares), it downscales cleanly (a
gradient background under a white glyph is 16px-safe and compatible with Fork 2's mono-W), and it makes
WE visibly the widest-spanning mark while children each span a subset — a legible umbrella hierarchy
*without* the exception-to-the-rule. So the live fork is **which gradient is WE's mark**, and the
overlapping-region Venn is excluded, not defaulted.

### Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
|---|---|---|---|
| 1 — WE mark color system | **(a) constellation-spanning multi-stop gradient (within the one-gradient rule)** | (b) strict single-hue monochrome | Med-high (~70%) |

## Fork 1 — WE mark color system: constellation-spanning gradient vs strict single-hue

**Why it's a fork (real either/or):** WE's mark ships exactly one gradient — it is either the current
2-stop indigo→purple or a 3-stop constellation span; a single mark cannot be both, so the branches
genuinely cannot coexist. Both are coherent, rule-compatible end-states (this is a real either/or over
*which gradient is the mark*, not a config knob you ship twice). The genuinely *broken* branch — the
overlapping-color-region Venn — is excluded to Supported-by-default below, not offered as an option.

- **(a) constellation-spanning multi-stop gradient — WE's single gradient spans the family palette
  (indigo → cyan → violet); white glyph on top, per the rule. [bold default]** This delivers the
  user's "everything unified" meaning *within* the one-gradient rule (no exception for the flagship),
  matches JetBrains' actual umbrella construction (palette-spanning gradient, children = sub-ranges),
  is 16px-safe (a gradient downscales cleanly, unlike overlapping translucent circles), and is
  compatible with #2209 Fork 2 (the ≤32px favicon is still a white W over a gradient square — only the
  stop count changes). WE reads as the widest-spanning mark of the family — a legible "umbrella
  contains the constellation" signal:
  ```svg
  <!-- (a) WE = one gradient spanning all three constellation hues; glyph unchanged, rule intact -->
  <linearGradient id="logo_gradient" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse">
    <stop stop-color="#4f46e5"/>              <!-- WE indigo -->
    <stop offset="0.5" stop-color="#16d3e6"/> <!-- FUI/constellation cyan -->
    <stop offset="1" stop-color="#9333ea"/>   <!-- Plateau-adjacent violet -->
  </linearGradient>
  <rect width="40" height="40" rx="12" fill="url(#logo_gradient)"/>
  <!-- white W(+E) glyph rides on top, unchanged from we:src/assets/logo.svg -->
  ```
- **(b) strict single-hue monochrome — WE keeps its 2-stop indigo→purple gradient.** The lowest-risk
  hold: maximal rule consistency (every project is a same-width single-hue gradient), and the respected
  modern default is in fact a *restrained* parent (Adobe red / Google wordmark over colorful children).
  It forfeits the "everything unified" read WE alone can carry, but it is the guaranteed-clean fallback
  if the 3-stop span reads muddy or generic side-by-side at 16px.
  ```svg
  <!-- (b) unchanged: WE stays a single indigo→purple gradient -->
  <linearGradient id="logo_gradient" x1="0" y1="0" x2="40" y2="40">
    <stop stop-color="#4f46e5"/><stop offset="1" stop-color="#9333ea"/>
  </linearGradient>
  ```

Skeptic: REFUTED (original default) → flipped, then re-attacked. The hostile pass refuted the original
"(a) multi-color umbrella *Venn*, conditioned on JetBrains-grade execution" on four landing axes:
*classification* — a default gated on an unbuilt, already-failed execution (the mix-blend probes) is a
hope, not a prepared pick; *merit* — overlapping-color "we-contain-everything" is the most generic B2B
trope and fails #2209's own ownability baseline, and breaking the one rule for the flagship is
self-defeating; *statute-overlap* — a tri-hue union legible at 16px directly contradicts #2209 Fork 2's
ratified mono-W-≤32px favicon in the same cluster; *citation-scope* — JetBrains' umbrella is a smooth
*gradient* (already permitted by "one gradient"), NOT a Venn, so the precedent authorizes only a
palette-spanning gradient, and "user-favored" is a preference input, not design authority. All four are
folded in by **flipping the default to the rule-compatible expression the citation actually supports**:
the constellation-spanning *gradient* (a) honors the user's color instinct without breaking the rule,
without the cliché, and without the Fork-2 collision; the overlapping-region Venn is demoted to an
explicit ban; monochrome (b) is the named fallback. Re-attacked, (a) survives: it is not a rule break
(3-stop is still one gradient), so the self-contradiction and Fork-2 collision both dissolve.
Screen: clear — the fresh-context screen confirmed a genuine free-to-build merit difference: (a) asserts
*hierarchy* (WE = the umbrella containing FUI + Plateau) while (b) makes WE a visual peer of its own
children — a real identity claim, not cost, and a real either/or (a brand wears one primary mark; the
banned Venn confirms broken branches, not just tastes). Its one caveat — that the merit hinges on the
prior "should WE read as above vs peer?" — resolves toward (a) under the ratified constellation model
(WE = the zero-impl umbrella over FUI + Plateau; memory #96). impl-detail: clear — gradient stop-count
is brand meta-asset authoring, off the WE↔FUI boundary.

## Supported by default (not decisions)

- **The overlapping-color-region union / translucent Venn is banned regardless of branch** — a flawed
  form, not an option: it breaks the one-gradient rule (multiple colored shapes, not one gradient),
  fails the ownability cliché test ("could be Mastercard's subsidiary"), renders muddy via
  `mix-blend-mode:screen` (`plateau:branding-proposals/loop/we-venn-lumin.svg:16`), and contradicts
  #2209 Fork 2's mono-W-≤32px favicon. Ratification records the ban alongside the pick; the probe SVGs
  are retired.
- **FUI and Plateau stay single-hue under both branches** — the fork is only about *WE*; each child's
  own-range gradient is not in question (forced by the rule under (b), and by the umbrella-hierarchy
  logic under (a): children span subsets, the parent spans the union).

## Context

- **Classification (per-fork pass):** branding meta-asset authoring — no WE standard artifact,
  protocol, or intent changes; nothing crosses the WE↔FUI impl boundary. `locus: webeverything` because
  the ruling amends #2209's construction-system section (adds the WE gradient-span clause + the
  Venn ban). Not a config dimension: one gradient is *the* WE mark; (a) and (b) are mutually exclusive
  marks, not two values shipped together.
- **Depends on #2249:** the visual language (flat vs rich) is upstream — the gradient is drawn in
  whatever language #2249 rules — so this decides after it (`blockedBy: ["2249"]`).
- **No statute self-contradiction (post-flip):** because (a) is a *gradient* (rule-compatible), it does
  not re-open #2209's "one hue per project" invariant the way the Venn did — it widens WE's gradient
  span within the rule, and leaves Fork 2's mono-W favicon intact. On ratify, amend #2209's construction
  section with the WE gradient-span policy + the Venn ban; it binds #2251 (finalize the WE mark) and
  becomes a #2207 ground-truth label.
- **Review surface:** any brand-asset change regenerates `plateau:branding.html` (`npm run gen:branding`).

Ratified 2026-11-22 (PL-BRAND-RATIFY): ratified in one sitting with #2209, #2249 and #2250.
