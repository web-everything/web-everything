# Build-UI — the sighted method for "we have a new UI to build"

> Tier-2 reference. Read before designing or building any non-trivial UI surface (a console, a board, a
> panel, a decision-ruling screen). Codified from the Plateau-Loop backlog-console program (#2505 and its
> children), where this exact sequence produced a design that survived review and became a machine-checkable
> spec instead of dying with the session (#2559, serves G5 — the method + the decision record are durable).

The failure this kills: **building a UI straight into the app, then reviewing it by reading the source.**
That produces a plausible-looking surface nobody looked hard at, a design decision nobody can cite, and
craft that evaporates when the session ends. The fix is a *sighted* pipeline — model the domain, mock it,
review the pixels, rule the forks in the open, and freeze the ruling into durable cases — driven to
convergence by fresh adversarial reviewers.

## The one rule that matters

**Never trust a UI you have not rendered and looked at.** A sub-agent that reads your source scores markup,
not appearance — it cannot see that two states are indistinguishable, that a glyph reads as the wrong thing,
or that dark mode is unreadable. The value of this method is the *sighted* loop: render every state, screenshot
it, and review the image. Source review is not a substitute for looking.

## The method (an optional Phase 0, then seven phases in order)

### 0. (Optional) Requirements committee — persona needs, builder-challenged

For a **net-new product surface** (skip it for a small tweak), open before you model anything with a **requirements
committee**: a panel **skewed toward the consumers** of the surface — one user persona at minimum, usually several
(the roles who will live in it) — plus a few **builder-experts to challenge and integrate** the asks into something
feasible. Each persona states its jobs-to-be-done, its single most-frequent action, must-see vs collapse, and
deal-breakers; the builders red-team for feasibility and over-ask. The output is the requirements brief phase 1
models from — and those **same user personas sit on the design jury later** (phases 3/6/7), so the pixels are judged
by the people who will use them, not only by craft lenses. (Proven on the delivery-workspace design, #2676.)

### 1. Model the domain — axes → matrix → the one live-action rule

Before any pixels, enumerate the **axes** of the domain (for the console: actor, edge, primary status,
rendered state, use-case). Cross them into a **matrix** of every real state (the console had 37). Then distill
the **one live-action rule** that governs each state — the single thing the UI must let the operator *do*, or
must show, per cell. The matrix is the spec's skeleton; the live-action rule is what keeps the UI from being a
decorative dashboard. A state with no live-action rule is either dead or mis-modelled — merge or drop it.

**Enumerate the unhappy path, not just the happy one.** The error, empty, loading, and latency states are
real cells of the matrix — and they are exactly the ones a happy-path enumeration silently drops, because they
are the states nobody enjoys drawing. A feature that only models "data loaded, everything fine" ships a design
that has never confronted its own failure modes. Then **run a completeness-critic over the enumeration**: a
fresh agent whose only job is to name what axis, state, or failure mode is missing (not to praise what's
there). An enumeration nobody adversarially checked is a guess wearing a matrix's clothes.

### 2. Mock before build — self-contained HTML, real data shapes

Do **not** build in the real app first. Author a **single self-contained HTML file** (inline CSS/JS, no build
step) that renders the matrix from phase 1, populated with **real data shapes** — the actual item/record
fields, not lorem. A throwaway mock is cheap to iterate, has no framework friction, and forces you to confront
the real data early. This is where the design actually happens; the app build (which lives in the impl repo,
never WE — WE holds zero implementation) comes *after* the mock is ruled and frozen.

**When you iterate, refine the last ratified artifact — do not rebuild from the spec.** Regenerating a fresh
mock from the written spec each round throws away every pixel-level decision the prior round already ratified —
the spacing that finally read right, the glyph that won, the tuned hierarchy — and quietly reintroduces bugs
already fixed. Edit the ratified artifact *forward* so craft accretes across rounds instead of resetting to
zero. The spec is the record of what was decided; it is not a regeneration seed.

**How many mocks? Right-size the proposal panel to the ask — and start at zero.** Fanning several agents out
to each propose a design is a *cost lever you must earn*, not the default shape of this phase. Pick a rung and
**say which rung you picked and why** before you spawn anything:

- **No panel** — you author the mock. The right answer for a tweak, a single component, or a call that is
  already obvious. Most of the time this is the rung.
- **One proposer** — a second pair of eyes when you want a check, not a spread.
- **Two proposers** — the real minimum when you want *spread*: two mocks, two **distinct assigned angles**
  (e.g. density-first vs novice-first), each author **blind to the other's work** so the second isn't an edit
  of the first.
- **More than two** — a genuinely contested or high-stakes surface only, and **never more than four seats**.
  Four is the hard ceiling, not a soft guideline: past four you are paying for candidates nobody will actually
  hold side by side, and the extra angles stop being decorrelated anyway. A surface that seems to need five is
  a surface whose fork is under-specified — sharpen the ask, don't buy more seats.

**Never climb a rung without asking the human first.** Escalation spends real budget and time, so it is their
call, not a silent upgrade. And when there is **no operator channel to ask on** — an unattended `/workflow`
lane, a conveyor run, a drain subagent — the answer is rung zero. Absence of an answer is a refusal, never a
licence to proceed.

**The front door is the `/design-committee` skill** (`skills-src/design-committee`) — it runs this
right-sizing ladder and the blind fan-out for you. Invoke it rather than hand-rolling the panel.

**Right-size by count, not by model tier.** The reason a panel helps is **decorrelated angles**, not more total
brainpower — and that only pays off if each mock is good enough that *seeing it rendered* changes your mind. A
weak candidate teaches nothing: you glance at it, reject it, and the fork is no better ruled than before. So
scale the *number* of proposers and leave each one at full strength; one strong proposer beats three lesser
ones. (This is the mirror of the jury's rigor gate, which sizes the *judging* panel — see
*jury-refinement-method.md → When to run the full jury*. Same instinct, different half of the loop: that dial
is a derivation in the engine, this one is your explicit, asked-for choice.)

### 3. Review the pixels, not the source — screenshot matrix × both themes → PNGs to reviewers

Render the mock and **screenshot every cell of the matrix in BOTH light and dark themes** (Playwright). Hand
the **PNGs** to fresh review subagents — they judge the rendered appearance, never the HTML. Score against the
ratified design-critique rubric (see *vision-tiers.md → Design-critique rubric*) — the same 8 closed axes plus
localized findings the `/review-design` skill uses. Both themes are mandatory: a design that works in light and
fails in dark is a failing design, not a passing one with a caveat.

### 4. Decision-explainer artifacts — the ruling channel

When the design has a genuine fork (which glyph family, whether a rule is transient or persistent, one layout
vs another), do **not** decide it inline. Build a **decision-explainer artifact**: the competing options
rendered **side by side in option panes**, an **honest counter-argument** for each (the real case *against* the
one you prefer, not a strawman), and **one recommendation**.

**Decide the fork on built, rendered candidates — never on a prose description of them.** Each option in the
explainer is an *actual rendered candidate you can look at*, not a paragraph arguing for a design you never
built. A fork argued in prose is ruled on imagination, and imagination hides the very failure the pixels would
have shown — the option that "sounds cleaner" often looks worse the moment it exists. Build both sides, then
look. If you never rendered the losing option, you did not rule the fork; you guessed it. That artifact is the ruling channel — the decision
is ruled from a lane against the explainer, never ratified inline (*backlog-workflow.md → Never take an
unprepared decision*), and the ruling is recorded in the design doc so it is cite-able (the console's live at
`plateau-app:docs/backlog-console-design.md`).

**An interaction-model fork needs an operable candidate, not a static pane.** When the fork is about
*behavior* — expand-in-place vs master-detail vs breadcrumb-zoom, or any choice that plays out across clicks
and navigation rather than a single visual state — a side-by-side picture of one moment cannot show whether the
model actually works: it cannot show that expand-in-place feels cramped once a row grows, that master-detail
loses context on the third click, or that a breadcrumb chain gets unwieldy past two levels. Render each
candidate as a REAL, OPERABLE embed in the explainer — self-contained interactive HTML the operator can
actually click through, not a screenshot of it — driven by the SAME underlying data across every candidate, so
the comparison is apples-to-apples and the operator picks the frame from having *operated* it, not from a
description of how it would behave or a still frame of how it looks. Treat this as a first-class step for any
interaction-model fork, not an ad-hoc thing to remember (proven by hand ruling the feature-tracking-screen's
master-detail frame, #2708).

**How you rule a high-leverage fork — the jury method.** The explainer artifact is the *channel*. For a fork
that is long-lived and high-fan-out (a whole icon grammar, a colour system), the *technique* for ruling it is
the **jury-refinement loop** (#2576, born on the §6e icon grammar). Run a panel of fresh single-lens jurors
(usability · visual · a11y · design-systems, plus IA/ops for structure calls). Keep every fork the panel splits
on — develop each side through an advocate, never average the disagreement away. Rate each option **1–5**, not
just "pick one"; when the best option scores below threshold, **flag it weak and search for new candidates**
rather than settling. Truth-check the live surface each round (collision / duplicate detection, state-vs-action
distinctness). The jury *proposes*; the human *disposes* — no self-ruling. Gate the full machinery by
blast-radius: the heavy jury for a durable high-fan-out call, a light pass for a one-off. This method owns its
own home — **[jury-refinement-method.md](jury-refinement-method.md)** (#2576, under the Plateau-Ruler epic
#2577) — read it there; this section only names the technique, it doesn't duplicate the operational detail.

### 5. Graduate to webcases — durable, cite-able, machine-checkable

A ruling recorded only as prose rots. Port each ruled state into **webcases**: durable fixture files whose
`assert:` line encodes the ruled grammar, hardened by a **conformance test**. The assert line starts as the
**base attention grammar** — the ratified attention-card triple plus the coverage id (the console's
`card-taxonomy.webcases.ts` carries `actor · edge · primary · rendered · uc`). **Ruled visual language — glyph,
motion, colour forks — is additive to that line, not a footnote beside it.** Once a fork is ruled in the design
record, a **dedicated port pass graduates it onto the same `assert:` line** (appending fields like
`glyph`/`motion` alongside the base grammar), so the visual ruling is itself machine-checked — never left as a
prose port-note that drifts. That port was just run for the console taxonomy (#2578). Now the build can *cite* a
state's design by its case id, and drift is caught by the test — the design is a spec, not a memory. This is the
durability payoff (#2559 G5): the method *and* the decision survive the session.

### 6. Integrate — compose the parts into one operable page, reviewed at full scale

A UI is not the sum of its parts, and a part that passes in isolation can fail the moment it shares a screen.
Once the parts are ruled and frozen, **compose them into one operable page** — the real chrome, the real shell,
every part wired together at production scale and populated with the full matrix, not a gallery of isolated
components. Then run an **integration-only review**: fresh reviewers judge the *assembled* page, and only the
assembly — does the hierarchy still hold when every part is present at once, do the parts fight for the same
attention, does the whole read as one product or as a bag of panels bolted together. Integration routinely
surfaces **whole-page forks the part-level review could not see** — the frame itself (master-detail vs stacked
vs split) is decided *here*, on the assembled page. Rule each such fork the phase-4 way (built, OPERABLE
candidates over the same data, honest counter-argument, one recommendation — phase 4's interaction-model rule)
and loop the new ruling back through the webcase port. A part that scored
well alone and fails in the assembled page is a failing part — the page is the unit that ships.

### 7. Converge — alternating-lens fresh reviewers, two clean rounds, every edit assert-verified

Iterate to convergence: spawn **fresh-context reviewers with alternating lenses** (e.g. hierarchy/polish one
round, accessibility/state-distinguishability the next) and keep going until **two consecutive rounds come back
clean — on the integrated page at full scale, not just the isolated parts**. Fresh context each round is the
point — a reviewer who has seen the prior round rationalizes it. And
**every fixture edit is assert-verified**: after each change to a webcase, re-run the conformance test so a
grammar edit can never silently break the spec. One clean round is luck; two in a row from distinct lenses is
convergence.

Two failure modes ride every convergence loop — guard both. **Silent loss:** a round's reviewers verify *that
round's* fix-list; none is asked "what did we lose?", so a clean redesign can quietly drop features the design was
already ruled to keep. Before you call it converged, run a **completeness-critic that diffs the result against the
prior ratified artifact and the endorsed forks-to-keep** — not just this round's findings. **Faked convergence:** a
single author reviewing their own work once is a draft, not convergence — run the fresh-lens rounds; escalate to the
human only when the panel is genuinely stuck, or to ratify the converged result.

## The repo hooks this rides on (non-negotiable)

The build-UI work is edit-action work, so it obeys the standard delivery discipline — none of this is optional:

- **Lane → PR, never a direct commit to `main`.** Every edit runs in an isolated lane clone and lands via a
  ready-to-merge PR (*backlog-workflow.md → Working an item*, #2183/#2190/#2123); `guard-lane.mjs` denies a
  primary `Edit`. Set the lane up **first**, before editing.
- **Complete the branch before labeling.** Finish the item — green gate + `resolve` + one commit (stage only
  the files that piece touched) — *then* open the PR and apply `ready-to-merge`. Never label a half-done branch
  (*backlog-workflow.md → The arc per item*).
- **The write-seam.** The `PreToolUse(Edit|Write)` hook (`scripts/lint-locus-prefix.mjs --pre`, #883) scans the
  *proposed* content and denies the write at the seam — a shared gate enforced at write-time, not after. Expect
  it; don't fight it.

## Honesty clauses

- **Rendered-and-looked-at, or it didn't happen.** Never call a state good from its markup. If you have no
  screenshot, you have no review.
- **Both themes or neither.** A one-theme review is half a review; ship the dark-mode failure as a finding, not
  a footnote.
- **The counter-argument must be real.** A decision-explainer whose counter-argument is a strawman is a
  rationalization with extra steps. State the honest case against your own recommendation.
- **A fork is ruled on built candidates.** If you never rendered the option you rejected, you did not rule the
  fork — you imagined it. Build both sides, then look.
- **Enumerate the unhappy path.** A matrix that only models the happy path hides its hardest states. Error,
  empty, loading, and latency are cells, not extras — and a fresh completeness-critic checks the list for what's
  missing before you trust it.
- **Refine the ratified artifact, don't rebuild it.** Regenerating from the spec each round discards ratified
  craft and reintroduces fixed bugs. Edit the last ratified artifact forward.
- **The page is the unit, not the part.** A part that passes alone but fails in the assembled page at full scale
  is a failing part. Integrate and review the whole before you call any of it done.
- **Convergence can strip value — diff against the last ratified artifact.** A clean redesign can silently drop
  features the earlier design was *ruled to keep*; the round's reviewers only check the round's fix-list, so nobody
  notices. The completeness-critic runs at convergence too, comparing to the **prior ratified artifact and the
  endorsed forks** — not only the current round's findings. (Caught live: a converged lane board that dropped v68's
  delivery-horizon and size-as-height encoding — features an earlier jury had named "worth keeping.")
- **Self-review is not convergence.** Fresh-context reviewers reaching two clean rounds is convergence; you looking
  at your own work is a draft — you rationalize your own pixels and miss your own bugs (even a wrong screenshot).
  Escalate to the human only when the panel is stuck or to ratify — don't hand every fork back, and never label a
  fast single pass "converged."
- **A frame fork may be zoom levels, not rivals.** When the panel splits on the whole-page frame, test whether the
  options are *complementary zooms/modes of one surface* before ruling one out — often the answer is "both, linked"
  (a zoomed-out map and a zoomed-in cockpit sharing one shell), not "pick one."
- **An interaction-model fork is ruled by clicking through it, not by looking at it.** A screenshot proves a
  layout; it cannot prove whether expand-in-place, master-detail, or breadcrumb-zoom actually works once the
  operator navigates it. Build each candidate as an operable page over the same data and click through before
  ruling — never rule an interaction-model fork from static panes.
- **Shared chrome is single-source.** A shell/header used by more than one surface changes in ONE place — a chrome
  change is a *cross-surface* change: update every surface and re-verify together, and freeze the shell as its own
  conformance webcase so a change that breaks a surface fails a check. Inline-copying the chrome per screen
  guarantees drift (a dropped logo, a mismatched toggle).
- **Conform to the ratified visual grammar.** Once a glyph / colour / motion grammar is ruled (the per-state icon
  manifest, the colour-per-class ruling, the motion ruling), the surfaces must *use it* — ad-hoc chips and colours
  that ignore the ruled grammar are an un-graduated draft. The completeness-critic checks grammar conformance too.
- **Version every iteration; review across the width range.** Keep each iteration as a labelled version (stable link
  + history + rollback; the durable diff lands in git). And a review is themes × **breakpoints** — a design fixed at
  one width is half-reviewed; design responsive and look narrow *and* wide.
- **WE holds zero implementation.** The UI impl lives in the product repo (plateau-app); WE owns the *method*
  (this doc), the reference model, and the machine-checkable spec — not the app code (memory rule 6, #1282).

## Related

- Worked example: Plateau-Loop backlog console — epic #2505; the mock-before-build seed #2565; the
  graduate-to-webcases port #2578; design record `plateau-app:docs/backlog-console-design.md`.
- Second worked example (proved the integration phase, decide-on-built-candidates, refine-from-ratified, the
  completeness-critic, and the unhappy-path enumeration): the Plateau-Loop **feature-tracking screen** —
  committee → 10-juror jury → red-team → Round 2 → **integration** → **master-detail** frame (#2708, under the
  design-studio product-loop epic #2676). #2708 carries the decision/trace artifact and the live integrated
  page. Its lesson for a *new* surface: build it *into* the established product chrome, not beside it.
- Rubric the pixel review scores against: *vision-tiers.md → Design-critique rubric* (#1034), driven by
  the `review-design` skill (home: plateauapp/plateau-ops `skills/review-design`, deployed by `sync-skills-deploy`).
- Front door for the phase-2 proposal panel (the rung ladder + the blind fan-out): the `/design-committee`
  skill, `skills-src/design-committee` — right-sizes first and defaults to no panel.
- The fork-ruling technique (plugs into phase 4): the jury-refinement method —
  [jury-refinement-method.md](jury-refinement-method.md) (#2576, parent epic #2577 "Plateau Ruler") —
  multi-lens jury, per-option 1–5 ratings, weak-flag→candidate-search, human-gate; how the §6e icon grammar
  was ruled.
- Delivery discipline: *backlog-workflow.md → Working an item* (lane→PR, the arc, the write-seam).
