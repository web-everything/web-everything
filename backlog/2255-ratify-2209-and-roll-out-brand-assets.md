---
kind: story
size: 5
status: open
parent: "2256"
blockedBy: ["2209", "2250", "2251", "2252", "2253"]
locus: webeverything
relatedTo: ["2209"]
dateOpened: "2026-07-04"
tags: [branding, ratify, rollout, gate]
---

# Ratify #2209 and roll out the brand assets

Terminal integration once the language (#2249), system call (#2250), and three marks (#2251–#2253) are
settled and folded into **#2209**, and #2209 itself is ratified. This story owns only the *rollout* —
**not** the ratification act itself (that happens on the #2209 card, by the decision-owner, per
`we:docs/agent/backlog-workflow.md`'s explicit-ratification gate; a `kind: story` cannot perform it, see
below). **Not build-ready: genuinely and fully blocked on the entire decision chain, none of which has
landed** — see the status section for grounded evidence and what is prepared regardless.

## Status: blocked, not build-ready (prep finding, 2026-08-15)

**Every upstream item is still open, verified live, not carried from stale frontmatter:**

- `#2249` (visual language) and `#2250` (WE color system) — `status: open`, both carry
  `preparedDate: "2026-07-04"` (ready to ratify) but neither has a `resolvedDate`. Confirmed
  `grep -E "^status:|^resolvedDate" backlog/2249-*.md backlog/2250-*.md` 2026-08-15.
- `#2251` (WE mark), `#2252` (FUI mark), `#2253` (Plateau mark) — all `status: open`. #2251 and #2252 are
  themselves *mid-preparation* right now, not yet build-ready, let alone executed: open PRs
  `chalbert/web-everything#1303` ("prepare #2251: block on #2249/#2250 …") and `#1311` ("prepare(#2252):
  … to build-ready") as of this writing. #2253 has no PR at all — not yet touched.
- `#2209` itself — `status: open`, `preparedDate: "2026-07-03"`, no `resolvedDate`. Its own text is
  explicit that #2255's rollout children are filed **"on ratify"** (`we:backlog/2209-*.md`, "Context"
  section) — #2209 has not ratified.
- **Live assets confirm nothing has shipped yet, on any of the three anchors:**
  `we:src/assets/logo.svg` / `we:src/assets/favicon.svg` still render the flat W+ghost-E mark
  (`stroke-width="2.5"`, 2-stop `#4f46e5`→`#9333ea` gradient) — the pre-decision baseline, not the
  ratified construction. `frontierui:src/assets/logo.svg` still renders "F"/"U" letterforms (Fork 3's
  excluded branch (a), not the concept-bearing symbol (b) that's the bold default). `plateau-app:favicon.svg`
  still renders the unaltered current dual-mesa (Fork 5(a)'s starting point, not a ratified pick).
- **The full chain, in the order `plateau:branding-proposals/TRANSITION.md` (the 2026-07-03 handoff doc)
  lays out:** visual language (#2249) → WE color system (#2250) → the three marks finalized together
  (#2251/#2252/#2253) → **"Ratify #2209 with all the above folded in; then execute the asset rollout"**
  (`plateau:branding-proposals/TRANSITION.md:50-51`) — #2255 is that last step, by design, not an
  oversight in its `blockedBy`.

This item stays genuinely **Tier C — blocked, not agent-ready**
(`we:docs/agent/backlog-workflow.md`, tier table: *"anything blocked"*) until #2209, #2250, #2251, #2252,
and #2253 all carry `resolvedDate`. `blockedBy` above adds `"2209"` — it was previously only in
`relatedTo`, but ratifying it (with the amendments folded in) is a hard prerequisite for every rollout
task below, not a "see also." No new blocker item filed: all five prerequisites already exist as backlog
items; nothing to track that isn't already tracked.

**Ratification is not this story's task.** #2255's original brief opened with "Ratify decision #2209" as
if it were a step a builder executes. Per `we:agent-memory-src/index-dec.md` rule 54 ("Decisions Are Work
Items, Not Plan Mode") and the explicit-ratification gate in `we:docs/agent/backlog-workflow.md`
("Resolving a `decision` requires *explicit ratification* — never infer it from agreement"), ratifying
#2209 happens *on the #2209 card*, by the decision-owner, via the decision workflow (`/next decision` or
equivalent) — not as a checklist item inside a `kind: story`. #2255's real scope starts **after** that
ratification lands; this rewrite corrects the framing so a future builder doesn't attempt to "do" the
ratification as part of this story.

**Scope correction — "final mark files per repo" is not this story's job.** The original brief listed
"final mark files per repo" as one of #2255's own rollout children. It is not: #2251's own prepared scope
(PR #1303) already ships `we:src/assets/logo.svg` + `we:src/assets/favicon.svg` directly; #2252's own
prepared scope (PR #1311) already ships `fui:src/assets/logo.svg` + `fui:src/assets/favicon.svg`
directly; #2253 will own `plateau-app:favicon.svg` the same way when it's prepared. #2255 must not
re-touch those files — doing so would either duplicate #2251/#2252/#2253's work or race it. #2255's real
remaining scope, once unblocked, is: the `<link rel="icon" sizes>` **consumer wiring** for the WE
favicon small-variant (the *file* is #2251's, per its own Tasks: "Add an additional small-size variant
only if the ratified rule turns out to require one"), the two WE-local referring icons, the
`check:branding` gate, the named icon cleanup, and cross-repo gradient hue-span normalization.

**Blast-radius finding the original brief under-measured — read this before scoping the `check:branding`
gate.** #2209's "Supported by default" section states the icon-set gate rule as: every `viewBox` must be
`0 0 128 128`, every `stroke-width` ≥ 6, "gradient stops from the template palette"
(`we:backlog/2209-*.md:260-268`), citing "Measured today: 1 icon at 24-viewBox, stroke-widths 1.75–12
across the set." Measured again live, 2026-08-15, against `we:src/assets/icons/*.svg` (70 files):

- **viewBox: confirmed, exactly 1 violation** — `weblayout.svg` (`viewBox="0 0 24 24"`). Matches #2209.
- **stroke-width ≥ 6: 18 files currently below the floor**, not "1 icon" — `prefetch.svg` (min 4),
  `range-anchor.svg` (5), `suggested-edit.svg` (2.5), `webcharts.svg` (2), `webdecisions.svg` (3),
  `webgraph.svg` (2.5), `webguards.svg` (3), `webintl.svg` (5), `webisolation.svg` (5), `weblayout.svg`
  (1.75), `webpolicy.svg` (3), `webportals.svg` (4), `webpositioning.svg` (3), `webregistries.svg` (2),
  `webresources.svg` (3), `webrouting.svg` (2.5), `webstates.svg` (2), `webtheme.svg` (3). #2209's own
  text names the range but never states a violation count — the count is materially bigger than "the
  broken/weak icon-set cleanup" framing (3 named files) implies.
  <!-- doc-only citation, not a check:standards manifest scan -->
- **"gradient stops from the template palette": the premise itself looks stale against the live set.**
  `we:src/assets/icons/_template.svg` defines exactly 4 gradients (`gradRed`, `gradIndigo`, `gradPurple`,
  `gradSky`). The live set defines **70+ distinct gradient ids** (`adapterGrad`, `attrGrad`, `chartBarSky`,
  `webidentity.svg`'s own indigo pair, etc.) — e.g. `webadapters.svg` uses `#fbbf24`→`#d97706` (amber),
  `webattributeparsers.svg` uses `#2dd4bf`→`#0d9488` (teal) — hex pairs with **no id and no stop-color**
  matching any of the 4 template gradients. This reads as an intentional, already-large
  per-category-hue system (each web-standard category gets a consistent 2-stop gradient), not drift — a
  literal "stops from the template palette" gate would fail the large majority of the set on ratification
  day. **This is a genuine premise risk to flag when #2209 ratifies**, not something #2255 can silently
  resolve — the fix is either (a) #2209's gate rule needs restating (e.g. "any 2-stop linear gradient,
  consistent per category" instead of "from the template palette") before `check:branding` can be built
  against it, or (b) the per-category palette itself is the thing being retired, which is a much bigger
  migration than "cleanup." Per `we:agent-memory-src/index-infra.md` rule 143 ("Stage Gate For
  Retroactive Statute Amendment"): a gate whose rule retroactively invalidates most of an existing
  population needs a staged migration, never a same-day flip-on. **Route this finding to #2209 at
  ratification time** (it bears on the gate rule's own wording, which #2209 owns) — not a new backlog
  item, since #2209 already exists as the governing card.

**Sizing risk.** The card is `size: 5`. Once unblocked, its real remaining scope (per the corrections
above) is: 2 icon-file edits (`plateau.svg`, `frontierui.svg`), 1 new `check:standards` validator + fixing
however many of the 18+ stroke-width and 50+ gradient-palette non-conformances the ratified gate rule
ends up covering, 3 named icon rebuilds, cross-repo hue-span normalization (touches 3 repos' anchor
files), and the favicon `<link>` wiring. That is plausibly bigger than a single 5 once the gate's true
remediation set is known. Flagging now rather than resizing blind — re-run `/split` on this card once
#2209 ratifies and the gate rule's exact wording (and therefore its violation count) is fixed, not before.

## What IS prepared now (holds regardless of how the open forks rule)

- **`check:branding` wiring convention.** New validators live in `we:scripts/check-standards-rules.mjs`
  and are imported + invoked from `we:scripts/check-standards.mjs` (see e.g. `scanRepoLocusPrefixes`,
  `validatePlugWeFuiDrift` for the existing pattern: a pure function returning findings, wired into the
  main run). A `validateBranding`/`check:branding` pass belongs there — file, gradient-id/stop, and
  stroke-width checks over `we:src/assets/icons/*.svg`, excluding `we:src/assets/icons/_template.svg`
  itself.
- **Consumers (already grounded, no discovery needed at build time):**
  - `we:src/index.njk:66` / `:68` — the two referring icons (`icon: "/assets/icons/frontierui.svg"`,
    `icon: "/assets/icons/plateau.svg"`).
  - `we:src/_layouts/base.njk:8` — the sole existing `<link rel="icon">`; the small-variant task adds a
    second `<link rel="icon" sizes="...">` here once #2251 ships the variant file.
- **Named cleanup targets, content read in full 2026-08-15:**
  - `we:src/assets/icons/webtraces.svg` — literally the `_template.svg` placeholder content unmodified (a
    single `<circle>` filled `gradIndigo`), never actually authored.
  - `we:src/assets/icons/weblayout.svg` — `viewBox="0 0 24 24"`, `stroke-width="1.75"`, a generic
    3-line "browser chrome" glyph that duplicates `we:src/assets/icons/layout.svg`'s concept (already
    on-template, `viewBox="0 0 128 128"`, `stroke-width="6"`, `gradRed`).
  - Thin red-stroke subfamily — `anchor.svg`, `layout.svg`, `message.svg`, `temporal.svg` are all
    `gradRed` `stroke-width="6"` (at the floor, not below it — #2209's "thin" framing is about visual
    weight versus the rest of the set, not a hard-floor violation); `navigation.svg` is `stroke-width="8"`
    (already above floor); `range-anchor.svg` is `gradAmber` `stroke-width="5"` (below floor — genuinely
    needs a bump, distinct issue from "thin red-stroke").
  - `we:src/assets/icons/plateau.svg` — currently amber (`#f59e0b`→`#d97706`) stacked-mesa glyph; realigns
    to Plateau's ratified violet/cyan once #2253 lands.
  - `we:src/assets/icons/frontierui.svg` — currently "FU" letterforms (`fuiGrad` teal→cyan); realigns to
    the Fork 3 concept-bearing symbol once #2252 lands.
- **Regen surface.** `npm run gen:branding` (`plateau-app:scripts/gen-branding.mjs`) after any asset
  change — the standing before/after visual-check surface (`plateau-app:package.json:22`).
- **Hue-span figures already measured** (`plateau:branding-proposals/TRANSITION.md:65`): FUI 14°, WE 28°,
  mesa 61° — the "also queued (independent, smaller)" normalization target once all three anchors are
  final.

## Tasks — do not start before #2209, #2250, #2251, #2252, AND #2253 all carry `resolvedDate`

1. Re-read #2209's ratified construction/icon-rule text (post-ratification, with the amendments folded
   in) — build against that wording, not this card's paraphrase, and not the pre-ratification "Supported
   by default" draft cited above (which may itself change if the gradient-palette premise finding gets
   folded in at ratification).
2. Wire the WE favicon `<link rel="icon" sizes="...">` variant into `we:src/_layouts/base.njk:8`,
   pointing at whatever small-variant file #2251 shipped (skip this task entirely if #2251's own
   resolution notes say no variant was needed).
3. Realign `we:src/assets/icons/plateau.svg` to Plateau's ratified violet/cyan (read the final geometry
   + colors off the shipped `plateau-app:favicon.svg` from #2253, don't re-derive from the decision text).
4. Realign `we:src/assets/icons/frontierui.svg` to the ratified FUI mark (read off the shipped
   `frontierui:src/assets/logo.svg` from #2252).
5. Build the `check:branding` validator in `we:scripts/check-standards-rules.mjs` +
   `we:scripts/check-standards.mjs`, against #2209's **ratified** (not draft) gate wording. If the
   gradient-palette rule was restated at ratification (per the premise finding above), implement the
   restated rule; if it ratified unchanged, implement it as written but stage the rollout in waves per
   rule 143 rather than flipping it on repo-wide in one commit that fails 50+ pre-existing files.
6. Remediate `weblayout.svg` (viewBox + stroke-width; consider merging into `layout.svg` per #2209's own
   note rather than keeping both) and `webtraces.svg` (author a real glyph, on-template) and
   `range-anchor.svg` (bump `stroke-width` 5→≥6). Remediate the remaining 15 sub-floor stroke-width files
   found above only if the ratified gate actually enforces the floor repo-wide (vs. grandfathering
   pre-existing icons) — that staging call is made at ratification, not invented here.
7. Normalize gradient hue-span across the three anchors (`we:src/assets/logo.svg`,
   `frontierui:src/assets/logo.svg`, `plateau-app:favicon.svg`) toward one shared span, once all three are
   final — this is the one task that necessarily touches all three repos.
8. Regenerate `plateau:branding.html` (`npm run gen:branding`) and confirm the gallery reflects every
   change.
9. Run `npm run check:branding` (or the equivalent flag on `check:standards`) clean; run
   `npm run check:standards` clean on every touched repo.

## Done when (testable, once unblocked)

- `we:src/_layouts/base.njk` carries the small-variant `<link rel="icon" sizes>` tag IF #2251's resolution
  says a variant shipped; otherwise this bullet is N/A and stated as such in the closing PR.
- `we:src/assets/icons/plateau.svg` and `we:src/assets/icons/frontierui.svg` visually match their
  referent repo's shipped mark (`frontierui:src/assets/logo.svg`, `plateau-app:favicon.svg`) — verified by
  eye against `plateau:branding.html` after regen, not asserted from source diff alone.
- A `check:branding` (or equivalently-named) validator exists in `we:scripts/check-standards-rules.mjs`,
  is wired into `we:scripts/check-standards.mjs`, and `we:src/assets/icons/*.svg` passes it (or every
  remaining failure is an explicitly grandfathered exception named in the validator, not a silent skip).
- `weblayout.svg`, `webtraces.svg`, and `range-anchor.svg` no longer violate the ratified floor rules.
- `plateau:branding.html` is regenerated and shows every changed asset.
- `npm run check:standards` is 0 errors on every repo touched (`we`, and `fui`/`plateau-app` only if the
  hue-normalization task changed their anchor files).

## Delivery shape

Cannot land as one piece — spans at minimum this repo (icon realignment, the gate, icon cleanup) and, if
task 7 (hue-span normalization) is in scope, `frontierui` and `plateau-app` as well, since it edits their
anchor files. Land as one PR per repo touched, same pattern as #2252's prepared delivery shape. The
`check:branding` gate itself should land ungated-but-warning first if its true remediation set (task 6)
turns out too large to fix in the same PR that introduces it — ship the validator as a warning, remediate
in follow-up waves, then flip it to blocking. That staging call is for whoever executes this once
unblocked, informed by the actual ratified gate wording.

## Scope

- `we:src/assets/icons/plateau.svg`, `we:src/assets/icons/frontierui.svg` — realign to referent marks.
- `we:src/assets/icons/weblayout.svg`, `webtraces.svg`, `range-anchor.svg` — named cleanup targets;
  possibly more if the ratified gate enforces the stroke-width floor repo-wide (see Tasks #6).
- `we:src/_layouts/base.njk` — favicon `<link>` wiring only, conditional on #2251's resolution.
- `we:scripts/check-standards-rules.mjs`, `we:scripts/check-standards.mjs` — new validator.
- `we:src/assets/logo.svg` — hue-span normalization only (not glyph/construction — that's #2251's).
- Cross-repo, conditional on task 7: `frontierui:src/assets/logo.svg`, `plateau-app:favicon.svg` — same,
  hue-span only.
- **Not in scope** (corrected from the original brief): `we:src/assets/logo.svg` /
  `we:src/assets/favicon.svg`'s construction (owned by #2251), `frontierui:src/assets/logo.svg`'s
  construction (owned by #2252), `plateau-app:favicon.svg`'s construction (owned by #2253), and the act
  of ratifying #2209 itself (owned by the decision-owner on the #2209 card, not this story).
