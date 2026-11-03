---
kind: story
size: 5
status: open
parent: "2256"
blockedBy: ["2249"]
locus: frontierui
dateOpened: "2026-07-04"
tags: [branding, frontier-ui, favicon, logo]
scope:
  - fui:src/assets/logo.svg
  - fui:src/assets/favicon.svg
  - plateau:branding-proposals/journey.json
  - plateau:branding-proposals/loop/LOOP-LOG.md
  - plateau:branding-proposals/loop/ (new fui-*.svg iteration files)
  - plateau:branding.html (regenerated, not hand-edited)
---

# Finalize the Frontier UI mark

Run the sighted `brand-mark-loop` on the FUI Round-3 shortlist — **FUI-12 (advancing ridge), FUI-18
(ground-edge), FUI-21 (edge-post)** (`plateau:branding-proposals/journey.json`, all mesa-family grammar).
None have been through the per-mark loop yet. Render at 220/64/32/16 on light+dark next to the mesa
(family test); red-team the double-reads (no sailboat / image-placeholder); converge to a winner; then
replace `fui:src/assets/logo.svg` + `fui:src/assets/favicon.svg`. The current "FUI" letterforms are the
weakest constellation mark — this is a real upgrade.

## Grounded findings (2026-08-15 prep)

1. **The three shortlist files exist and match the card's description**, verified by reading them
   (`plateau:branding-proposals/explore/fui3e-advance.svg`, `plateau:branding-proposals/explore/fui3h-ground-edge.svg`,
   `plateau:branding-proposals/explore/fui3m-edge-post.svg`, confirmed against the `fui` journey's Round 3
   node list in `plateau:branding-proposals/journey.json`). All three are already pure flat shapes — solid
   fill + `fill-opacity="0.55"` echo, the mesa-family grammar, no gradient/filter depth of any kind —
   sharing the current FUI gradient (`#0d9488` → `#06b6d4`).
2. **This is the queued next action, not a cold start.** `plateau:branding-proposals/loop/LOOP-LOG.md`'s
   "FUI — log" section and "Next-round queue" both name this exact shortlist and method as the next
   session's work: *"next session: run the loop on the FUI Round-3 shortlist (FUI-12 advancing-ridge,
   FUI-18 ground-edge, FUI-21 edge-post)."* The loop method is proven — it already produced the WE v6
   letterform and the Plateau rich-a/b probes via the same render→critique→red-team→edit cycle.
3. **Consumers of the two shipped files, verified by grep (`fui:` repo), not assumed:**
   `fui:src/assets/logo.svg` has exactly one consumer, `fui:src/_layouts/base.njk:28`
   (`<img src="/assets/logo.svg" ... width="32" height="32">`, the site header). `fui:src/assets/favicon.svg`
   has one real consumer, `fui:src/_layouts/base.njk:7` (`<link rel="icon" ... href="/assets/favicon.svg">`);
   `fui:.eleventy.js:7` passthrough-copies `src/assets` → `_site/assets`, so the built path matches the
   source path. (The many `fui:demos/*.html` files that reference a bare `/favicon.svg` — no `/assets/`
   prefix — point at a path with no file behind it; that is a pre-existing, unrelated dead reference, not
   a consumer of this asset, and out of scope here.) Both are **content-only swaps** — the file path and
   viewBox/outer-dimension contract stay the same, so no consumer needs a code change.
4. **De-risking the `blockedBy: ["2249"]` gate (checklist item 8) — the wait does not change this card's
   design.** #2249 is still `status: open` (prepared, not ratified) — genuinely unresolved, so the edge
   stays (`we:docs/agent/backlog-workflow.md`: `blockedBy` means "cannot start until resolved,"
   mechanically, not a judgment call for a preparer to lift). But #2249's own **Supported-by-default**
   clause already settles the question that matters for *this* card, regardless of which way Fork 1
   (flat-baseline vs rich-dimensional-baseline) rules: depth effects are *"forbidden at ≤64px (favicon,
   small icons, header logo)"* and permitted only on assets whose smallest rendered size is ≥128px.
   Findings 1 and 3 show `fui:src/assets/logo.svg`'s only rendered instance is 32px and `favicon.svg`
   renders as a browser-tab icon (≤32px) — both are named verbatim in that forbidden-depth bracket. So
   **both branches of #2249 converge to "flat" at the size these two files actually render**, and all
   three shortlist candidates are already flat (finding 1) — there is no version of #2249's ruling that
   would send this card's design back to the drawing board. `blockedBy` is kept (the edge is mechanically
   real, and #2256's transition order wants the language codified into #2209 before any mark ships), but
   a builder picking this up the moment #2249 resolves does not need to re-derive or redo anything below.
5. **Size 5, unchanged. Basis:** three pre-narrowed, already-on-grammar candidates (lower design risk
   than WE's unresolved letter-vs-symbol tension, which is also a 5) but full per-candidate sighted-loop
   convergence (render, critique, red-team, edit, re-render — ×3, until one or more get eliminated),
   a head-to-head winner pick, a two-file cross-repo asset swap preserving each file's own outer-dimension
   convention, and the process-bookkeeping the method requires (see Delivery shape). Comparable to #2251
   (WE mark, size 5) and heavier than #2253 (Plateau, size 3, refinement of an already-loved mark with no
   shortlist to narrow).

## Decided design

**Run the `brand-mark-loop` skill on all three shortlist candidates in parallel triage, then converge to
one winner, then ship it as both `fui:src/assets/logo.svg` and `fui:src/assets/favicon.svg`.** No menu is
left open past this card: the shortlist is fixed (finding 1), the method is fixed (the skill), and the
target files are fixed (finding 3). The only real open question the loop itself resolves is *which of the
three motifs* wins and what shape it takes after refinement — that is intentionally not pre-decided here
(a mark's quality can only be judged sighted, per the skill's own "never trust a mark you have not
rendered" rule) — but the process that resolves it is fully specified below.

- **Iteration files live under `plateau:branding-proposals/loop/`**, following the existing
  `<project>-v<N>.svg` naming this loop already uses (`plateau:branding-proposals/loop/we-v1.svg` …
  `we-v6.svg`, `plateau:branding-proposals/loop/plateau-rich-a.svg`):
  `plateau:branding-proposals/loop/fui-advance-v1.svg`,
  `plateau:branding-proposals/loop/fui-groundedge-v1.svg`,
  `plateau:branding-proposals/loop/fui-edgepost-v1.svg`, incrementing `-v2`, `-v3`, … per edit round. The
  `plateau:branding-proposals/explore/` originals (finding 1) are never edited in place — they are the
  Round-3 record.
- **The current FUI gradient stays untouched** (`#0d9488` → `#06b6d4`, ids `fui_gradient`/`fui_fav`).
  Gradient hue-span normalization (FUI 14° vs WE 28° vs mesa 61°) is a named, separate item in
  `plateau:branding-proposals/loop/LOOP-LOG.md`'s "Next-round queue" — pulling it into this card would
  conflate two independent levers (finding 2's queue keeps them separate on purpose).
- **The winning glyph replaces the paths/shapes in both shipped files, not the files' own wrapper
  attributes.** `fui:src/assets/logo.svg` is `width="40" height="40"` with gradient id `fui_gradient`;
  `fui:src/assets/favicon.svg` is `width="32" height="32" viewBox="0 0 40 40"` with gradient id `fui_fav`
  — preserve each file's own outer attributes and gradient id exactly as today, only replacing the glyph
  paths inside.

## Interfaces & protocol

```
# render + look (run from the plateau-app repo root; @playwright/test already a devDependency there)
node scripts/render-mark.mjs <mark.svg> <out.png> [reference.svg]
# e.g.: node scripts/render-mark.mjs branding-proposals/loop/fui-advance-v1.svg /tmp/fui12.png favicon.svg
# renders 220/64/32/16px on light + 64/16px on dark; reference.svg (plateau-app's own favicon.svg = the
# mesa) renders alongside at 64px for the literal family test. Read the PNG — this is the sighted step.
```

- **The `plateau:branding-proposals/journey.json` append** (`journeys[].project === 'fui'`): append one
  new object to that journey's `rounds` array, matching the existing node shape exactly
  (`{id, file, label, verdict}`, add `review` once a candidate has been critiqued — the `plateau` journey's
  `PLT-01`/`PLT-02` nodes show the target shape once reviewed; today's Round 3 `FUI-12`/`FUI-18`/`FUI-21`
  nodes carry no `review` yet):
  ```json
  {
    "title": "Round 4 — sighted refinement",
    "nodes": [
      { "id": "FUI-12v2", "file": "loop/fui-advance-v2.svg", "label": "echo-motion · advancing ridge (refined)",
        "verdict": "winner", "review": "<critique + why it won>" },
      { "id": "FUI-18v1", "file": "loop/fui-groundedge-v1.svg", "label": "horizon · ground edge",
        "verdict": "rejected", "review": "<the flaw that killed it>" },
      { "id": "FUI-21v1", "file": "loop/fui-edgepost-v1.svg", "label": "marker · frontier edge-post",
        "verdict": "rejected", "review": "<the flaw that killed it>" }
    ],
    "ref": { "id": "FUI-00", "file": null, "label": "current FUI letterforms", "note": "incumbent, being replaced" }
  }
  ```
- **Regenerate the review page:** `npm run gen:branding` (plateau-app). Its sibling-repo roots default to
  `../webeverything` / `../frontierui` next to the plateau-app checkout (`plateau:scripts/gen-branding.mjs`
  header comment); when run from a lane clone whose siblings aren't at those relative paths, override with
  `WE_ROOT=<path> FUI_ROOT=<path> npm run gen:branding`.
- **Ship the winner:** overwrite the shape content of `fui:src/assets/logo.svg` and
  `fui:src/assets/favicon.svg` in place (finding 3 — same file paths, same consumers, content-only).
- **Gates per repo** (`we:scripts/check-standards-rules.mjs` `LOCI`): `frontierui` →
  `npm run check:standards`; `plateau-app` → `npm test`. Neither repo's gate currently includes a
  `check:branding` script — that gate is a future addition in #2255, not built yet; don't block this
  card's Done-when on a gate that doesn't exist.

## Tasks

1. Read `plateau:branding-proposals/loop/LOOP-LOG.md` in full (standing findings + FUI log) before
   drafting anything — it is the skill's own required first step.
2. For each of FUI-12, FUI-18, FUI-21: copy `plateau:branding-proposals/explore/<file>` →
   `plateau:branding-proposals/loop/fui-<motif>-v1.svg`; render at 220/64/32/16 light+dark plus the mesa
   family-ref (per the render tool in the Interfaces section above, reference = plateau-app's own
   favicon.svg); write a critique against the FUI rubric (pioneering · pragmatic · kinetic + ownable) —
   swap test, adversarial second-read (rotate/mirror/say-aloud: does "advancing ridge" read as a
   play-button / dorito? does "ground-edge" read as a table/slab? does "edge-post" read as a
   flag/exclamation mark?), 16px legibility, on-dark, family fit vs the mesa.
3. Red-team each candidate (skeptic pass, "prove this is generic/illegible/off-family") and fold surviving
   attacks into the flaw list per candidate.
4. Edit the top 1–2 flaws per candidate (`plateau:branding-proposals/loop/fui-<motif>-v2.svg`, …),
   re-render, repeat 2–3 to convergence or a real wall (stop honestly per the skill's honesty clause — a
   stalled candidate can be eliminated rather than forced).
5. Converge to ONE winner across the (converged/surviving) candidates via a final head-to-head render at
   all sizes + family test.
6. Replace `fui:src/assets/logo.svg` and `fui:src/assets/favicon.svg` per the Decided design's
   wrapper-preservation rule; confirm visually in the running FUI dev server (header + browser-tab
   favicon) before committing.
7. `frontierui` gate: `npm run check:standards`, 0 errors.
8. Append the Round 4 entry to `plateau:branding-proposals/journey.json` (winner + rejected candidates,
   per the Interfaces section) and a dated FUI-log entry to `plateau:branding-proposals/loop/LOOP-LOG.md`
   (tick the "run the loop on the FUI shortlist" line off the Next-round queue); regenerate
   `plateau:branding.html` (`npm run gen:branding`).
9. `plateau-app` gate: `npm test`, green.
10. Land as two separate repo PRs (frontierui: the shipped mark swap; plateau-app: the loop bookkeeping) —
    see Delivery shape.

## Done when

1. All three shortlist candidates (FUI-12, FUI-18, FUI-21) have been rendered at 220/64/32/16 on light+dark
   next to the mesa family-ref and critiqued in writing (rubric + adversarial second-read + 16px
   legibility + family fit) — the critiques are readable in `plateau:branding-proposals/loop/LOOP-LOG.md`,
   not only in memory.
2. `fui:src/assets/logo.svg` and `fui:src/assets/favicon.svg` both contain the winning glyph (not the
   current F/U/I letterform paths), each preserving its own outer `width`/`height` and gradient id
   (`fui_gradient` / `fui_fav`) and the current gradient stops (`#0d9488` → `#06b6d4`) unchanged.
3. The winner holds at 16px on both light and dark with no negative-space closure or stroke blur, stated
   explicitly in its `plateau:branding-proposals/loop/LOOP-LOG.md` entry (not asserted from the
   design-size render alone).
4. `plateau:branding-proposals/journey.json`'s `fui` journey carries a new round covering all three
   shortlist candidates, each node with a `verdict` (`winner` for exactly one, rejection verdicts for the
   other two) and a `review` string; `npm run gen:branding` regenerates `plateau:branding.html` without
   error.
5. `frontierui`'s own `npm run check:standards` is 0 errors on the changed repo; `plateau-app`'s `npm test`
   is green on the changed repo.
6. Two separate PRs exist — one in `frontierui` (the asset swap), one in `plateau-app` (the loop
   bookkeeping) — neither touching `webeverything` beyond this already-prepared card.

## Delivery shape

**Two separate, cross-repo pieces — cannot be one PR (different repos), and each lands as its own single
piece, not incrementally.** (a) `plateau-app`: the `plateau:branding-proposals/journey.json` update, the
`plateau:branding-proposals/loop/LOOP-LOG.md` update, and the regenerated `plateau:branding.html` — pure
documentation/audit trail, zero product risk, landable independently and at any time relative to (b).
(b) `frontierui`: `fui:src/assets/logo.svg` + `fui:src/assets/favicon.svg` together in one commit — they
must ship in lockstep (a new logo with the old favicon, or vice versa, is a visibly broken half-rebrand);
there is no meaningful incremental slice smaller than "both files, one glyph." Neither piece needs a
feature flag or phased rollout — static brand assets have no runtime behavior to gate behind `main`.
