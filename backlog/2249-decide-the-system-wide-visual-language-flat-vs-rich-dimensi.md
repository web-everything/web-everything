---
kind: decision
size: 3
status: open
parent: "2256"
locus: webeverything
relatedTo: ["2209", "2250"]
preparedDate: "2026-07-04"
relatedReport: reports/2026-07-04-constellation-visual-language-and-color-architecture.md
dateOpened: "2026-07-04"
tags: [branding, design, visual-language, decision]
---

# Decide the system-wide visual language — flat-minimal vs rich-dimensional

The single most upstream branding call: does the constellation's mark language stay **flat-minimal**
(current: solid white glyphs on a 45° gradient squircle) or move to **rich-dimensional** (light, shadow,
depth)? It gates every mark and the website, so it is #2256's first child.

## Grounding digest

All three marks today are **flat**: a 40×40 squircle (`rx="12"`), a two-stop 45° gradient, a solid
white glyph — `we:src/assets/logo.svg:2` (the gradient rect) + `:6`/`:11` (the white W + 0.6-opacity
ghost-E, both `stroke-width="2.5"`), mirrored by `fui:src/assets/logo.svg` and `plateau:favicon.svg`.
The "rich" alternative is probed, not shipped: `plateau:branding-proposals/loop/plateau-rich-a.svg`
adds a radial glow (`:10`), a vertical white→pale-blue face gradient (`:6`), a soft
`feDropShadow` (`:8`), and an edge-highlight stroke — a *restrained* soft-light treatment; the heavier
`plateau:branding-proposals/loop/plateau-rich-b.svg` is full 3D. Prior-art survey (2013 flat → ~2020
neumorphism a11y failure → 2025 Apple Liquid Glass + Material 3 Expressive → 2025–26 NN/g legibility
backlash → "skeuomorphic minimalism" consensus):
[report](../reports/2026-07-04-constellation-visual-language-and-color-architecture.md) ·
[/research/](/research/#constellation-visual-language-and-color-architecture). Candidates render at
`plateau:branding.html#journeys`.

## Axis-framing

The axis is **what baseline character the *mark* carries** — flat/restrained vs glossy/dimensional —
and the branches differ on **brand-character merit**, not merely cost. Two separable claims must not be
conflated: (1) a *size-gating rule* (depth muddies at 16px, needs the per-theme variant set, and
outruns the hand-SVG craft ceiling) — this is real but **branch-independent**: a dimensional baseline
would have to flatten at 16px too, so the physics/craft-ceiling justify a size rule *both* branches
honour, not the baseline pick; and (2) the *baseline-character call* — a standards layer's mark should
read timeless and un-ornamented (principled / bedrock), where glossy depth reads as consumer-app
of-the-moment flashiness. The industry did swing back toward depth in 2025, but in *UI chrome*, not core
marks (Apple/Google keep the app-icon glyph flat). So the decision separates cleanly: the marks are flat
by character; restrained depth is a size-scoped allowance on large surfaces; glass/full-3D is banned.

### Recommended path at a glance

| Fork | Recommended default | Main alternative (excluded) | Confidence |
|---|---|---|---|
| 1 — baseline mark language | **(a) flat-minimal baseline + size-gated depth (keep current construction as the small form)** | (b) rich-dimensional as the baseline mark language | Med-high (~75%, taste-weighted) |

## Fork 1 — baseline mark language: flat-minimal (with size-gated depth) vs rich-dimensional-as-baseline

**Why it's a fork (real either/or):** WE's — and the family's — baseline mark carries exactly one
character, and the branches differ on **brand-character merit**, not just cost. The excluded branch is
**rich-dimensional as the baseline mark language**: a glossy, light-and-shadow identity reads as
consumer-app of-the-moment flashiness, which is *at odds with WE's brand character* — the zero-impl
standards layer whose #2209 attribute set is *universal · principled · inevitable*, target feeling
**calm trust / bedrock**. A standards brand's mark should read timeless and un-ornamented, not trend-lit.
(Note: the *size-gated depth rule* below — flat ≤64px, restrained depth ≥128px, glass banned — is
branch-independent; a rich baseline would have to flatten at 16px too, so the physics/craft-ceiling
justify *that rule*, not the baseline pick. This fork is the baseline-character call.)

- **(a) flat-minimal baseline — keep the current solid-glyph-on-gradient construction as the family's
  core character. [bold default]** The merit that survives "free to build, perfectly maintained": flat
  fits WE's identity. The reference-library cohort of serious engineering/spec brands is flat-minimal
  (Vercel, Linear, GitHub/Octicons) precisely because restraint signals *principled / timeless /
  system*, matching #2209's WE attributes; glossy depth signals *product*, the wrong register for a
  standards layer. Flat is also the low-risk, low-maintenance form (recolors trivially for light/dark,
  hand-authorable) — but that is a *supporting* cost point, not the reason to pick it. The current
  construction is already the flat baseline:
  ```svg
  <!-- we:src/assets/logo.svg — flat: solid glyph on a flat 45° gradient, no depth -->
  <rect width="40" height="40" rx="12" fill="url(#logo_gradient)"/>
  <path d="M11.7 10.2 L16.2 22.2 L20.2 12.2 L24.2 22.2 L28.7 10.2"
        stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  ```
- **(b) rich-dimensional marks — adopt light/shadow/depth as the baseline character.** The restrained
  `rich-a` treatment is genuinely attractive at ≥64px, and both platforms we render inside (Apple,
  Google) went dimensional in 2025 — the real counter is "flat now reads dated." But a glossy baseline
  miscasts a *standards* brand as a consumer product (the character mismatch is the primary exclusion),
  and it also fails on the mark's decisive small surface:
  ```svg
  <!-- plateau:branding-proposals/loop/plateau-rich-a.svg — depth via filters; muddy <32px -->
  <filter id="pra_sh"><feDropShadow dx="0" dy="1.4" stdDeviation="1.6"
      flood-color="#0a1030" flood-opacity="0.35"/></filter>
  <rect width="40" height="40" rx="12" fill="url(#pra_glow)"/>          <!-- radial highlight -->
  <g filter="url(#pra_sh)"><path d="M6 29 L12 19 H23 L29 29 Z" fill="url(#pra_front)"/></g>
  ```
  At 16px the drop-shadow + radial glow collapse into a grey smear and the per-theme variant burden
  lands on the one asset that must render everywhere.

Skeptic: SURVIVES-WITH-AMENDMENT — hostile pass landed three fixes, all folded in. (1) *Classification:*
the original "not a config dimension / one language not both" framing was false on the prep's own terms
— the by-surface split ships both, fenced by size — so the fork is reframed to **flat-baseline +
size-gated depth**, and the size half is explicitly composed with #2209 Fork 2's ratified per-size
variant policy rather than duplicated (the skeptic's correct catch that "a 256px app-icon *is* the mark
rendered large" — the line is a pixel threshold, not mark-vs-surface). (2) *Hookable-vs-judgment (#51):*
"restrained depth" was a bare judgment word that would degrade #2209's script-decidable `check:branding`
floor — now given a concrete hookable definition below. (3) *Citation-scope:* the WCAG/neumorphism/
Liquid-Glass a11y evidence governs *interactive UI chrome* (affordance/contrast for controls), not a
non-interactive logo — downgraded from authority to supporting context; the default now rests on the two
legs that do reach a mark (16px physics + hand-SVG craft ceiling).
Screen: flagged (prioritization) → fixed. The fresh-context screen caught that the two stated legs are
cost + size-gating, not a baseline-merit argument: the craft ceiling evaporates under "free to build,"
and 16px physics argues for a *size-gating rule both branches must honor* (a rich baseline flattens at
16px too), not for flat-as-baseline. Re-layered: the size-gating rule is moved to Supported-by-default
as branch-independent, and the baseline pick is re-grounded on the brand-character merit that survives
free-to-build — flat fits WE's *principled / bedrock / timeless* #2209 attribute set and the serious
engineering/spec-brand cohort (Vercel/Linear/GitHub), where glossy depth would miscast a standards layer
as a consumer product. Merit difference now stands independent of cost. (impl-detail: clear — brand
meta-asset authoring, off the WE↔FUI boundary.)

## Supported by default (not decisions)

- **Restrained depth is allowed only on large-rendered surfaces — script-decidable floor.** This is the
  size-gated flip side of Fork 1 (a), and it composes with #2209 Fork 2's per-size variant policy (the
  house already legislates that one mark renders differently by size). To keep it out of judgment-tier
  drift and inside the hookable `check:branding` gate, the allowance is defined concretely, not as the
  word "restrained": depth effects (`feDropShadow`, a subtle radial highlight) are permitted **only on
  assets whose smallest rendered size is ≥128px** (hero art, ≥256px app icons, marketing lockups) and
  are **forbidden at ≤64px** (favicon, small icons, header logo); and **glass / full-3D is banned at
  every size** — no `backdrop-filter`, `feGaussianBlur`-blur, `feDisplacementMap`, or
  `feSpecularLighting` in any brand asset, and any permitted `feDropShadow` stays ≤0.35 flood-opacity
  (the `rich-a` ceiling, `plateau:branding-proposals/loop/plateau-rich-a.svg:8`). The residue that stays
  judgment-tier (is a *given* large lockup's soft-light tasteful?) is explicitly out of the gate. No
  either/or here — the small marks are flat and large surfaces may carry bounded depth simultaneously.
- **Gradient-as-brand-color stays** — the existing two-stop gradient fill is not "dimensionality"; it
  is the flat construction's color and is untouched under (a) (Stripe/Figma/Instagram keep flat marks
  with brand gradients).

## Context

- **Classification (per-fork pass):** branding meta-asset authoring — no WE standard artifact,
  protocol, or intent changes; nothing crosses the WE↔FUI impl boundary. `locus: webeverything` because
  the ruling codifies into #2209's construction-system section (the "flat, one gradient + white glyph"
  rule gains an explicit *flat baseline + size-gated depth floor* clause, folded into the same per-size
  variant policy as #2209 Fork 2 — one statute for the small-size slot, not two); the asset edits fan
  out per repo as #2251–#2253. The *baseline-language* question is a real either/or (rich-as-baseline is
  excluded, broken at 16px + off-character); the depth *allowance* is a size-scoped rule, not a
  competing default.
- **On ratify:** codify the flat-marks / restrained-depth-by-surface rule into #2209's construction
  section; it becomes a ground-truth label for the #2207 design-AI reviewer and binds #2251 (WE),
  #2252 (FUI), #2253 (Plateau) mark execution + #2254 (website) direction.
- **Review surface:** any brand-asset change regenerates `plateau:branding.html` (`npm run gen:branding`).

Ratified 2026-11-22 (PL-BRAND-RATIFY): ratified in one sitting with #2209, #2249 and #2250.
