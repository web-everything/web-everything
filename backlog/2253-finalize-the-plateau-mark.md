---
kind: story
size: 2
status: open
parent: "2256"
blockedBy: ["2249"]
locus: plateau-app
dateOpened: "2026-07-04"
scope:
  - plateau:branding-proposals/loop/LOOP-LOG.md
  - plateau:branding-proposals/journey.json
  - plateau:branding.html (regenerated, not hand-edited)
tags: [branding, plateau, favicon]
---

# Finalize the Plateau mark

Plateau's mesa is the family anchor and the user favorite, so this is *refinement*, not redesign.
**Prepared 2026-08-15: the #2249 flat-vs-rich-dimensional fork converges to flat for Plateau regardless
of which way it rules** — see *Grounded findings*. That leaves a decided design with, surprisingly,
**zero product-asset edits**: keep the current mesa (`plateau:favicon.svg` + the inline `#mesa-mark`
symbol in `plateau:index.html`) exactly as shipped, and close out the loop bookkeeping. Still blocked on
#2249 mechanically (unratified), but nothing below changes once it resolves.

## Grounded findings (2026-08-15 prep)

1. **Every real rendered instance of the Plateau mark is ≤36px — verified by reading the CSS, not
   assumed.** `plateau:favicon.svg` (`<link rel="icon">`, `plateau:index.html:7`) is
   `width="32" height="32"`. The mark is *also* defined a second time as an inline `<symbol id="mesa-mark">`
   in `plateau:index.html:23` (same path data, instantiated via `<use href="#mesa-mark">`) at: sidebar
   `.sidebar-brand-mark` — `30×30px` (`plateau:src/styles/layout.css:69-75`); auth screens
   `.auth-mark` — `34×34px`, 3 instances (`plateau:src/styles/layout.css:94-99`,
   `plateau:index.html:305,336,370`); pricing `.pricing-brand svg` — `36×36px`
   (`plateau:packages/saas/src/marketing/pricing.ts:72`). No hero art, app-icon manifest, or
   marketing lockup renders the mark larger anywhere in the repo (checked: no `plateau:*.webmanifest`/
   `plateau:manifest.json` icon entries, no `og:image`/`apple-touch-icon` tags in `plateau:index.html`).
2. **#2249's own "Supported by default" section is branch-independent** — it applies under *either*
   outcome of Fork 1 (flat-minimal vs rich-dimensional baseline), not just the flat branch: depth effects
   are *"forbidden at ≤64px (favicon, small icons, header logo)"* and *"permitted only on assets whose
   smallest rendered size is ≥128px"*
   (`we:backlog/2249-decide-the-system-wide-visual-language-flat-vs-rich-dimensi.md:118-129`). Every one
   of finding 1's real sizes (30/32/34/36px) sits inside the forbidden band, nowhere near the ≥128px
   allowance. So **`plateau:branding-proposals/loop/plateau-rich-a.svg` (and `plateau:branding-proposals/loop/plateau-rich-b.svg`) can never ship as
   Plateau's shipped mark, regardless of how Fork 1 rules** — the original brief's "if rich-dimensional
   wins, take `plateau-rich-a.svg` to final" branch is dead on #2249's own branch-independent terms, not
   a live open question. This is the same convergence shape #2252's prep found for FUI's mark
   (`we:backlog/2252-finalize-the-frontier-ui-mark.md`, finding 4) — verified independently here for
   Plateau's own consumers rather than assumed by analogy.
3. **De-risked by actually rendering and looking (checklist item 8), not asserted from source.**
   `node plateau:scripts/render-mark.mjs plateau:favicon.svg <out>.png` (220/64/32/16px light + 64/16px dark)
   shows the current mesa legible and clean at every size in both themes — front/back mesa stay
   distinguishable down to 16px, no muddiness. This settles the original brief's "(possibly minor optical
   cleanup)" hedge: **none found.** The same tool against `plateau:branding-proposals/loop/plateau-rich-a.svg` shows the drop-shadow +
   radial glow are visibly present even at 32/16px (extra edges/gradient noise beyond the flat silhouette)
   — consistent with, not contradicting, finding 2's categorical size-gating rule; the render check is
   supporting evidence, not the deciding authority (the deciding authority is #2249's cited text, which
   bans the effect at this size regardless of how it looks).
4. **The card's own "align gradient stop to the `gradient.brand` token per #2209 Fork 4" clause is
   out of scope here — corrected, not executed.** #2209 (`we:backlog/2209-ratify-the-constellation-branding-system-naming-marks-icon-r.md`)
   is itself unratified (`status: open`, `preparedDate: "2026-07-03"`, no `resolvedDate`), and its own
   Fork 4 section states the token-alignment task explicitly as a **future child to be filed on #2209's
   ratification** ("On ratify, file the children: ... Plateau favicon stop alignment (Fork 4) ..." —
   `we:backlog/2209-ratify-the-constellation-branding-system-naming-marks-icon-r.md:281-284`). The parent epic #2256 confirms this ownership split in its transition order: **#2255**
   ("ratify #2209 + brand-asset rollout") is the designated home for #2209's rollout, sequenced *after*
   #2253 (`we:backlog/2256-constellation-branding-and-website-design.md`). Bundling the token-stop change
   into #2253 would mean silently picking #2209 Fork 4's unratified default on this card's behalf — the
   exact move `we:agent-memory-src/story-preparation-checklist.md` item 4 forbids — and would duplicate
   #2255's already-planned scope. **Corroborating evidence of the drift #2209 Fork 4 describes, left for
   #2255 to fix (not fixed here):** the two copies of the mesa drawing already disagree with each other
   today — `plateau:favicon.svg:9` uses `stop-color="#6d5efc"` while the inline
   `plateau:index.html:20` `#mesaGrad` symbol already uses `stop-color="#6453f4"` (#2209 Fork 4's
   *recommended* token value) for the same visual slot. Neither copy is touched by this card.
5. **No collision risk introduced.** The "keep it distinct from the WE mark" clause in the original brief
   stays satisfied by construction: this card ships no geometry change, and WE's own mark (#2251, still
   blocked) has not shipped anything that could collide with the mesa's existing silhouette.
6. **Size revised 3 → 2, basis stated.** The original size assumed some refinement work would ship. This
   prep found zero product-asset edits are needed (findings 2–3) and the token-alignment sub-task is out
   of scope (finding 4) — what's left, once unblocked, is a short re-verification plus two small doc/data
   edits (no sighted-loop iteration, no cross-repo asset PR). Smaller than #2252 (size 5: three-candidate
   full loop) and #2251 (size 5: blocked, unresolved); kept at 2 rather than 1 because the re-verification
   step in Task 1 below is a real, if small, check a builder must not skip.

## Decided design

**Ship no change to `plateau:favicon.svg` or the inline `#mesa-mark` symbol.** Close out the two
probe candidates (`plateau:branding-proposals/loop/plateau-rich-a.svg`, `plateau:branding-proposals/loop/plateau-rich-b.svg`) as excluded-by-size-gating in the loop's own
records, so a future reader of `plateau:branding-proposals/journey.json`/`plateau:branding-proposals/loop/LOOP-LOG.md` doesn't mistake them for still-live options.
That is the entire deliverable — a bookkeeping closure, not an asset change.

## Interfaces / protocol

- **Re-verification (once #2249 carries `resolvedDate`):** re-read the ratified text folded into #2209's
  construction section (#2249's own "On ratify" note: codifies there). Confirm the ≤64px-forbidden /
  ≥128px-permitted thresholds shipped unchanged from the prepared draft cited in finding 2. This is a
  read-and-compare step, not a build step — if the ratified text changed the thresholds in a way that
  would newly permit depth at Plateau's ≤36px sizes, stop and escalate (do not silently re-derive a new
  design); otherwise finding 2's conclusion holds and no asset work follows.
- **`plateau:branding-proposals/journey.json`** — `journeys[].project === 'plateau'`, the single
  existing round (`"Probe — rich/dimensional visual language (user)"`). Edit nodes `PLT-01` and `PLT-02`'s
  `verdict` field from `"promising"` / `"heavier"` to `"excluded"`, and extend each `review` string with one
  clause citing the ratified size-gating rule as the reason (not a fresh critique — the existing review
  text stays, this only appends the closure reason).
- **`plateau:branding-proposals/loop/LOOP-LOG.md`** — append a dated `## Plateau — log` section (the
  file currently has none; WE and FUI each have their own section) recording: the mark was reviewed
  against the ratified #2249 text, no product-asset change was made, and why (one line each for findings
  1–3 above).
- **Regen:** `npm run gen:branding` (plateau-app) so `plateau:branding.html` reflects the closed
  probe rounds. No `WE_ROOT`/`FUI_ROOT` override needed — this edit touches no cross-repo assets.

## Tasks

1. Once #2249 carries `resolvedDate`: re-read the ratified #2209-construction-section text and confirm
   the size-gating thresholds match the prepared draft (Interfaces step 1). If they don't, stop and
   escalate instead of improvising.
2. Update `PLT-01`/`PLT-02` verdicts in `plateau:branding-proposals/journey.json` per the Interfaces
   section.
3. Append the dated `## Plateau — log` section to `plateau:branding-proposals/loop/LOOP-LOG.md`.
4. `npm run gen:branding` (plateau-app) to regenerate `plateau:branding.html`.
5. `plateau-app` gate: `npm test`, green.
6. Resolve this card, citing the closure reason (no asset change; excluded by the ratified size-gating
   rule) in the resolution note.

## Done when

- [ ] `plateau:branding-proposals/journey.json`'s `PLT-01`/`PLT-02` nodes both carry
      `verdict: "excluded"` with a review clause citing the ratified size-gating rule.
- [ ] `plateau:branding-proposals/loop/LOOP-LOG.md` carries a dated `## Plateau — log` entry recording
      the no-change outcome and why.
- [ ] `plateau:favicon.svg` and the inline `#mesa-mark` symbol in `plateau:index.html` are
      byte-identical to their state before this card started — confirming no accidental asset edit.
- [ ] `npm run gen:branding` regenerates `plateau:branding.html` without error.
- [ ] `plateau-app`'s `npm test` is green.

## Delivery shape

One incremental, doc/data-only PR in `plateau-app` — `plateau:branding-proposals/journey.json` + `plateau:branding-proposals/loop/LOOP-LOG.md` + the regenerated
`plateau:branding.html`. No cross-repo piece (unlike #2251/#2252): there is no `frontierui`/`webeverything`
product-asset change, because this card's decided design makes none.
