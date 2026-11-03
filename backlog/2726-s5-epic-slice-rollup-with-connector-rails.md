---
bornAs: x9cuge3
kind: story
size: 5
parent: "2705"
status: open
blockedBy: ["2725", "2691"]
scope:
  - "plateau-app:src/feature-tracker/rollup.ts"
  - "plateau-app:src/feature-tracker/rollup.css"
  - "plateau-app:src/feature-tracker/rollup.test.ts"
  - "plateau-app:src/feature-tracker/read-model.ts (owned re-edit)"
  - "plateau-app:src/feature-tracker/read-model.test.ts (owned re-edit)"
scopeRationale: "plateau-app:rollup.ts/.css render the epic->slice rollup; plateau-app:rollup.test.ts is its own unit-test sibling per this epic's own convention (S1a pairs plateau-app:read-model.ts with plateau-app:read-model.test.ts; plateau-app:lane-board.ts/.test.ts does the same). plateau-app:read-model.ts gains a rollup accessor here (declared 'owned re-edit' by the original card) -- its test sibling plateau-app:read-model.test.ts (created by #2718) must be re-edited in lockstep or the new accessor ships untested. No consumer outside plateau-app: plateau-app:detail.ts (#2725) is the sole importer (the section registry self-registration point); plateau-app:mount.ts (#2721) never imports plateau-app:rollup.ts directly. Test harnesses (#2717 webcases conformance, #2720 mount-conformance, #2735 golden baseline, #2730 behavioral gate) exercise plateau-app:rollup.ts's rendered OUTPUT through the mounted DOM, not as direct callers -- named as consumers of the render contract, not scope."
dateOpened: "2026-07-27"
tags: []
---

# S5 · Epic→slice rollup with connector rails

Feature-epic-slice rollup with connector rails: expandable epic nodes (mini progress bar, blocked flag, pts), slice rows with state chips, expand/collapse-all. Registers into the section registry. Interim epic-slice ships now; the #2691 adapter later adds the real feature tier above epics.

## Deliverable
Feature → epic → slice rollup with connector rails: expandable epic nodes (mini progress bar, blocked flag, pts), slice rows with state chips, expand/collapse-all. Registers into the section registry. The interim epic → slice ships now; the #2691 adapter later adds the real feature tier ABOVE epics.

## FT cases → rendered=yes
M9–M12 (+M13 spec); M14–M17.

## Grounded against live repo state, 2026-08-15

Verified, not assumed, before writing the design below:

- **Nothing in this chain has been built except the taxonomy register.** `plateau-app:src/feature-tracker/`
  contains exactly one file today, `plateau-app:feature-tracking.webcases.ts` (landed by #2716, commit
  `da66083e`). `git log --oneline --all -- src/feature-tracker/` in the `plateau-app` checkout shows no
  other commit touching this directory. `plateau-app:rollup.ts`, `plateau-app:rollup.css`,
  `plateau-app:read-model.ts`, `plateau-app:detail.ts`, `plateau-app:data.ts`, `plateau-app:mount.ts` —
  none exist yet. #2716's backlog status is stale (still `open` though its full deliverable landed
  2026-07-27); that stale flag is already caught and fixed in an open PR
  (`chalbert/web-everything#1343`, branch `lane/reconcile-2716`) found on `git fetch` while preparing this
  card — not re-filed here to avoid a dup.
- **This item's own `blockedBy` chain is real and unbroken.** #2726 → #2725 (S2, open) → #2721 (S1b, open)
  → {#2718 (S1a, open), #2719 (DEC, resolved)} → #2717 (S0a, open) → #2716 (S0r, code landed, status
  stale). So #2726 is correctly sequenced; it is simply not yet buildable, which is normal for the 5th of
  18 slices in a freshly-ratified epic, not a defect in this card.
- **The RATIFIED visual/behavioural target is a real, inspectable artifact, not a prose description.**
  #2705's "Live integrated page" (`https://claude.ai/code/artifact/d6816fec-3b87-4480-9cbb-0bb96e05a046`)
  is the v3 baseline the Acceptance line below means by "baseline" — it contains a working, scripted
  epic→slice rollup with connector rails (`renderOverview()`, `epicNode()`, `filmstrip()`, `shiplog()`).
  Cited concretely under *Decided design* so the builder is porting a read artifact, not inventing one.
- **`plateau-app` has an established composition rule this rollup must follow, which the raw mock does
  NOT demonstrate.** `plateau-app:src/backlog-view/lane-board.ts:24-33` states the "plateau CARDINAL
  RULE — compose FUI, hand-roll nothing abstract" and composes `we-progress` (`registerProgress`,
  `@frontierui/blocks/progress`) and `we-badge` (`registerBadge`, `@frontierui/blocks/badge`, also used at
  `plateau-app:src/backlog-view/queue-view.ts:17`) for exactly the primitives this rollup needs (a mini
  progress bar, a state chip). The artifact mock hand-rolls both in raw `<div>`/CSS because it is a
  standalone demo with no access to FUI — porting it 1:1 would violate the cardinal rule the sibling
  screen already follows. No `Accordion`/`Disclosure` FUI block fits the epic-node expand/collapse (the
  closest, `DisclosureNav`, is nav-specific); that stays hand-rolled, same as lane-board's own windowing.
- **Per-screen token scoping is an established pattern, not a free choice.** `plateau-app:src/styles/theme.css`
  is the app-wide `--color-*` base (light-only, no dark block: 65 lines, confirmed no `data-theme`/`dark`
  occurrence). Each screen scopes its OWN semantic aliases under its own root class, deriving from
  `--color-*` with a literal fallback, and carries its OWN dark override —
  `plateau-app:src/backlog-view/lane-board.css:15-39` (`.lb-root { --primary: var(--color-primary,
  #6453f4); … }`) plus the dual dark-mode selector at `plateau-app:src/backlog-view/lane-board.css:481-485`
  (`@media (prefers-color-scheme: dark) { .lb-root:not([data-theme="light"]) … }` AND an explicit
  `:root[data-theme="dark"] .lb-root …` / `.lb-root[data-theme="dark"] …` pair for a forced toggle).
  The feature-tracking screen's own semantic layer (`--ok`/`--caveat`/`--stall`/`--noisy`/`--blk`, and the
  categorical, **non-semantic** phase colours `--ph-spec`/`--ph-build`/`--ph-review`/`--ph-wait`) is owned
  by `plateau-app:feature-tracker.css` (#2721/S1b's scope), scoped under whatever root class that slice
  lands with — **not** invented locally in `plateau-app:rollup.css`. `plateau-app:rollup.css` consumes
  those tokens the same way the rest of the screen does; it does not redefine them.
- **The feature-tracking screen's state/colour vocabulary is its OWN ratified system, distinct from the
  backlog-console's.** `plateau-app:src/backlog-view/console-glyphs.ts:44-50` defines a *different*
  ratified grammar (`StateColorBucket`: build/deliver/human/fail/wait/queue, §2554/#2795) for the lane
  board. The feature-tracking screen was ratified separately (#2705, its own committee → jury → red-team →
  frame committee) with its own vocabulary (epic states done/active/blocked; slice states
  done/active/todo/blocked; forecast states ok/caveat/stall/noisy). These are sibling, non-interchangeable
  systems — grafting `StateColorBucket` onto this rollup would import the wrong screen's grammar. Flagged
  so a builder does not "reuse for consistency" across screens that were never designed to share one.

## Decided design

No open fork — the visual/behavioural target is already ratified at #2705; this is a port + platform-fit
exercise, not a design choice. Two structural questions remain genuinely open (next section) because the
code that answers them has not been written yet; they are not a design gap in this card.

**Port the ratified rollup 1:1 in behaviour and pixels, rebuilt on FUI composition and this app's token
convention** (both established patterns above), from the baseline artifact's `renderOverview()` section
(the section head + `.rollup` list) and its three helpers:

- **`epicNode(epic)`** → one `.epic` card per epic, state class `done`/`active`/`blocked` driving the
  connector-rail dot colour (`.epic::after`) via `--ok`/`--primary`/`--blk` (screen tokens, not invented
  here). Header row: disclosure toggle, epic name, `FILMSTRIP`/`SHIP-LOG` kind badge, optional `BLOCKED`
  flag, a mini progress bar (**`we-progress`**, value = `pct/100`, replacing the mock's hand-rolled
  `.mini i{width:...}` bar) + `%` + slice count, and a right-aligned `done/total pts` twin. Body (shown
  when open): the slice list and, per epic kind, the filmstrip or ship-log block.
- **`filmstrip(epic)`** (visual epics) / **`shiplog(epic)`** (build epics) — ported near-verbatim; these
  are app-specific layout, not primitive-composable (no FUI thumbnail-strip/log-row block exists).
- **Connector rails** — pure CSS, ported near-verbatim: `.rollup::before` (the vertical spine) +
  `.epic::before`/`.epic::after` (the branch tick + node dot per card), each colour driven by the epic's
  state class exactly as the baseline does.
- **Slice-row state chips** — **`we-badge`** per slice (`done`/`active`/`todo`/`blocked`), replacing the
  mock's hand-rolled `.st` glyph square. Badge tone maps to the same screen tokens the epic-node dot uses
  (`done`→`--ok`, `active`→`--primary`/`--sel`, `blocked`→`--blk`, `todo`→neutral `--border-2`/`--text-3`).
- **Expand/collapse-all** — ported verbatim: a header button toggling every `.epic`'s open class; label
  swaps `Expand all` ⇄ `Collapse all`; first render opens the first `active`-state epic (or the first epic
  if none is active), matching the baseline's `firstActive` logic.
- **One deliberate, justified deviation from the literal mock: make the epic-header disclosure toggle a
  real `<button>`, not a bare `<div>` with only a `click` listener.** The mock's `.epic-head` click handler
  (artifact, `epicNode()`) has no `tabindex`/`role`/keyboard handler — not keyboard-operable. A native
  `<button>` wrapping the header gets Enter/Space activation for free (native-first, per this repo's own
  default) at zero extra ARIA cost, and costs nothing to port faithfully alongside everything else. This is
  a small correctness fix over the mock, not a new design question.

## Interfaces — one determined, one honestly open

**Determined (this card owns it):** the `plateau-app:read-model.ts` accessor this rollup calls. Proposed
shape, derived directly from the baseline mock's own `AUTHORED` epic-drill data structure (the mock's
ground truth for "what an epic→slice rollup needs"), renamed to this repo's conventions:

```ts
// plateau-app:read-model.ts — new export, additive to whatever #2718 lands with.
export interface RollupSlice {
  readonly name: string;
  readonly state: 'done' | 'active' | 'todo' | 'blocked';
  readonly pts: number;
}
export interface RollupEpic {
  readonly id: string;
  readonly name: string;
  readonly kind: 'visual' | 'build';   // drives FILMSTRIP vs SHIP-LOG
  readonly state: 'done' | 'active' | 'blocked';
  readonly pct: number;                // 0-100, drives the mini we-progress bar
  readonly done: number;
  readonly total: number;              // pts twin
  readonly blk: boolean;               // BLOCKED flag
  readonly slices: readonly RollupSlice[];
  readonly film?: readonly [label: string, state: string][];   // visual epics only
  readonly log?: readonly [kind: 'ep' | 'ts', line: string, status: 'pass' | 'pend' | 'fail'][]; // build epics only
}
export function rollupOf(featureId: string): readonly RollupEpic[];
```

`rollupOf` reads from whatever `plateau-app:data.ts` (#2721) actually exports and applies the #2691
`featureOf` adapter so epic-level and feature-level totals reconcile — **the exact export name and shape
of `plateau-app:data.ts`'s fixture cannot be cited today because that file does not exist yet**; task 1
below is verifying this proposal against the real file before writing `rollupOf`'s body.

**Genuinely open — do not invent:** the section-registry call `plateau-app:rollup.ts` must make to
self-register with `plateau-app:detail.ts` (#2725: "a data-driven section registry (velocity/burnup/rollup
self-register to identical ratified DOM)"). #2725 has not landed. A repo-wide search
(`grep -rn "export function register\|export const register" plateau-app/src`) finds **zero** existing
"register a section" pattern anywhere in `plateau-app` today — unlike the read-model accessor above, there
is no sibling to model this on, and no fallback guess is offered. Task 1 is to read
`plateau-app:detail.ts`'s real registration signature once #2725 lands and wire `plateau-app:rollup.ts` to
the ACTUAL contract, never a remembered one from this card.

## Ordered tasks

1. **Before writing any code**, confirm against the real, landed files (not this card): (a)
   `plateau-app:detail.ts`'s section-registry registration call (#2725) — its exact function/argument
   shape; (b) `plateau-app:data.ts`'s exported fixture shape (#2721) and `plateau-app:read-model.ts`'s
   existing exports (#2718) — confirm or correct the `RollupEpic` proposal above against what actually
   landed.
2. Add `rollupOf(featureId)` to `plateau-app:read-model.ts` (additive export only — do not touch #2718's
   existing exports), applying #2691's `featureOf` so an epic's feature-level rollup total reconciles with
   the feature's burn-up total. Unit-test in `plateau-app:read-model.test.ts` (re-edited, not replaced):
   happy path, feature with zero epics, and the reconciliation invariant against a fixture with the #2691
   adapter applied.
3. Write `plateau-app:rollup.ts`: `epicNode()`/`filmstrip()`/`shiplog()` ported per *Decided design*,
   composing `registerProgress`/`registerBadge` from `@frontierui/blocks/*`, with the native-`<button>`
   disclosure fix. Export a render entry point matching whatever shape task 1's registry contract requires.
4. Write `plateau-app:rollup.css`: connector-rail geometry (`.rollup::before`, `.epic::before`/`::after`)
   ported verbatim; every colour a `var(--token, fallback)` read from `plateau-app:feature-tracker.css`'s
   screen-level tokens (#2721) — no locally redefined `--ok`/`--caveat`/`--blk`/etc.
5. Wire expand/collapse-all + the first-active-open default, ported verbatim from the baseline.
6. `plateau-app:rollup.test.ts`: DOM-shape/state-class assertions per epic/slice state
   (done/active/blocked/todo), FILMSTRIP vs SHIP-LOG branch, and the disclosure button's native keyboard
   operability (Enter/Space toggles `.open` — a plain `click()` on a `<button>` covers this; no
   synthetic-keydown plumbing needed).
7. Confirm the two rendered-vs-spec FT cases this card claims (M9–M12, M14–M17 rendered=yes; M13 stays on
   the frozen spec allow-list, `plateau-app:feature-tracking.webcases.ts`'s `SPEC_BEFORE_RENDER`) once
   #2717 (S0a) has graduated real case assert-lines to check against — do not flip M13 to `yes`.
8. Run `check:standards`, the plateau-app gate, and the FT conformance suite once #2717's harness exists.

## Delivery shape

**One piece**, landing as its own PR once #2725 (its declared blocker) has merged — mirroring how #2716
landed as a single self-contained commit. Cannot land earlier: `plateau-app:rollup.ts` cannot import a
registry that does not exist, and `plateau-app:read-model.ts`'s `rollupOf` has nothing to read from before
`plateau-app:data.ts` (#2721) lands. Cannot be split smaller without breaking the "identical ratified DOM"
contract #2725 sets: the render module, its styles, its data accessor, and their tests are one coherent
seam matching one rollup block.

## Size — 5 (unchanged)

Basis: porting ~140 lines of already-designed, already-working render logic (baseline artifact) into two
new files (`plateau-app:rollup.ts`, `plateau-app:rollup.css`) plus one additive accessor on an existing
file (`plateau-app:read-model.ts`) plus two test files. Heavily de-risked by the ratified reference
implementation (no design invention) — what keeps it off a smaller number is the two real interfaces that
must be read fresh rather than guessed (task 1), the FUI-composition rewrite of two hand-rolled primitives
(progress bar, chip) the mock does not demonstrate, and the #2691 reconciliation invariant in `rollupOf`.

## Done when

- `plateau-app:rollup.ts` self-registers with `plateau-app:detail.ts`'s real (not assumed) section
  registry and renders into the section's slot with no console error.
- Epic nodes render connector rails + state-coloured dots matching the baseline in both light and dark
  theme (screen tokens only — no literal hex in `plateau-app:rollup.css`), for `done`/`active`/`blocked`
  states.
- Each epic node shows a `we-progress` mini bar (not a hand-rolled div bar) at the correct `pct`, the
  `done/total pts` twin, the FILMSTRIP/SHIP-LOG kind badge, and the BLOCKED flag when `blk` is true.
- Slice rows render a `we-badge` per slice state (`done`/`active`/`todo`/`blocked`), matching baseline
  colour-per-state.
- Expand/collapse-all toggles every epic node and swaps its own label; the first `active` epic (else the
  first epic) is open on initial render — matching the baseline.
- The epic-header disclosure is operable by mouse click AND keyboard (Enter/Space via a real `<button>`) —
  a strict improvement over the baseline mock, asserted in `plateau-app:rollup.test.ts`.
- `rollupOf(featureId)` is unit-tested (`plateau-app:read-model.test.ts`) and its per-epic point totals
  reconcile with the feature's burn-up total once #2691's adapter is applied (fixture-asserted, per #2718's
  own acceptance shape).
- FT cases M9–M12 and M14–M17 render (`yes`); M13 stays `spec` on the frozen allow-list
  (`plateau-app:feature-tracking.webcases.ts`'s `SPEC_BEFORE_RENDER`) — not flipped by this card.
- `plateau-app:rollup.css` defines no `--ok`/`--caveat`/`--stall`/`--blk`/`--ph-*` token of its own; every
  colour resolves through `plateau-app:feature-tracker.css`'s screen-scoped tokens.
- `check:standards` and the plateau-app test/gate suite pass green.

## Acceptance

Rails + node states match baseline in both themes; slice chips reflect state; with #2691 the feature tier sits above epics and rollup pts reconcile with the burn-up total; the interim epic → slice is coherent standalone.
