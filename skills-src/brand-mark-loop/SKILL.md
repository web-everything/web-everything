---
name: brand-mark-loop
description: Design or refine a brand mark / logo / icon the RIGHT way — a sighted, red-teamed refinement loop grounded in our brand rubric and reference corpus, not blind one-shot generation. Use when the user wants to create, refine, or critique a logo/mark/favicon/icon for the constellation (Web Everything, Frontier UI, Plateau), run "the logo loop", or explore brand-mark options.
---

# Brand-mark refinement loop

The method for producing brand marks that are actually good — codified after a 2026-07-03 session found
that **blind, one-shot, fan-out generation produces mediocre marks**. The fix is a *sighted* loop with
the eye in it and adversarial review to convergence. This skill is the durable how-to; the living
artifacts it drives are in `plateau-app` (branding pipeline) and the decision/rubric in WE #2209/#2207/#2208.

## The one rule that matters

**Never trust a mark you have not rendered and looked at.** Sub-agents that emit SVG usually have no
rasterizer — they score geometry, not appearance, and they cannot see that a "W" reads as a pause icon.
The main loop CAN render (Playwright) and edit SVG directly. So generation is cheap breadth; **the value
is in the sighted refinement loop the main loop drives itself.**

## Inputs (read these first — do not design cold)

1. **Rubric** — WE #2209 Fork 6 brand attribute sets + the shared baseline attribute **ownable**
   ("could this be another brand's logo?" — Neumeier's swap test). Each project's attributes:
   WE = universal · principled · inevitable (calm trust); FUI = pioneering · pragmatic · kinetic
   (capable momentum); Plateau = elevated · steady · commanding (assured overview). Shared narrative:
   bedrock → horizon → plateau.
2. **Reference corpus** — `plateau-app/branding-refs/*.json` (exemplars, failures, failure-patterns,
   brand-systems, reading list; rendered at `plateau-app/branding-refs.html`). Cite named lessons:
   FedEx/Amazon (concept-in-form survives extraction), Apple bite (one surgical irregularity =
   ownable), Nike (static motion = asymmetry + swelling stroke + exit vector), Vercel (distinctive ≠
   meaningful), Wikipedia/WordPress-W (the W is the most crowded letter), London-2012/OGC (adversarial
   second-read), Lufthansa/IBM (family = shared geometric discipline).
3. **Construction system** — 40×40 squircle `rx="12"`, white glyph, per-project gradient. Family
   coherence axes discovered 2026-07-03: (a) all marks share a **hue-span** (measure it — WE 28°,
   FUI 14°, Plateau mesa 61°; they are NOT yet consistent, a real defect); (b) the mesa's **solid +
   ~0.55-opacity echo** grammar is the family anchor.

## The loop (per mark, to convergence)

1. **Frame the brief** — name the ONE concept the mark must carry (a meaning, not an adjective) and the
   owning attribute set. A mark with no idea is dead on arrival (the concept-bearing bar).
2. **Draft** — hand-author the SVG (or seed from a fan-out, but treat that as a sketch, not an answer).
3. **RENDER and LOOK** — use `plateau-app/scripts/render-mark.mjs <svg> <out.png>`: it shows the mark at
   220 / 64 / 32 / 16 px on light AND dark. Read the image. This is the step blind generation skips.
4. **Critique hard, in writing** — against the rubric + corpus. Run every check: does the glyph read as
   its intended form? swap test (cover it — generic?); adversarial second-read (rotate/mirror/say-aloud —
   sailboat? placeholder? pause icon?); 16px legibility (does negative space close? do strokes blur?);
   on-dark; family fit vs the mesa (grammar + hue-span). Name concrete flaws, not vibes.
5. **Red-team** — spawn a **real** skeptic prompted only to REFUTE: "this mark is generic / illegible /
   off-family — prove it." Fold surviving attacks into the flaw list. **Role-playing the skeptic yourself is
   not a substitute and is no longer offered** (#3145): you just authored the mark and wrote the step-4
   critique, so a self-played refutation is the author grading the author. Nor is the `Agent` tool — a
   subagent inherits this session's `CLAUDE_CODE_SESSION_ID`, the identity
   `we:scripts/lib/review-independence.mjs` keys independence on, so it is the same actor in a different hat.
   Seat the skeptic through `judgePanel`, which spawns a tool-free headless `claude -p` with its own derived
   session id (payload shape and limits:
   [delivery-loop.md](../../docs/agent/delivery-loop.md#independent-judgment-spawn)):

   ```bash
   # $PAYLOAD: { subject: "design-pixels", subjectNoun: "mark", materialFile: "<your step-3/4 write-up>",
   #             jurors: [{ id: "skeptic#1", lens: "skeptic", mandate: "REFUTE this mark: prove it is
   #                        generic, illegible at 16px, or off-family. Default REJECT." }] }
   node skills-src/jury/panel-fanout.mjs --payload-file="$PAYLOAD" \
     --depth=0 --max-depth=2 --max-total-budget-usd=2 --run-id="mark-<name>-r<round>"
   ```

   **The seat is tool-free, so it cannot see the PNG — you are the eyes, it is the doubt.** Feed it your
   step-3 rendering notes and the step-4 critique as `materialFile` (what the glyph reads as, what happens at
   16 px, the on-dark result, the hue/grammar comparison against the mesa), and let it attack *those claims*.
   That keeps the one thing a self-played skeptic can never give you — an actor with no stake in the mark —
   and is honest about the one thing it cannot give you: a second pair of eyes on the pixels. A seat that
   comes back `ok: false` did not run, and an unrun red-team does not clear the round.
6. **Edit the SVG** to fix the top 1–2 flaws. Small, surgical changes.
7. **Re-render, re-look.** Repeat 3–6 until the mark holds (no surviving critique) or you hit a real wall.
   **Stop honestly** — if 3–4 iterations don't converge, say so; the raw concept may be unsalvageable
   (kill it) or the ceiling is the model (escalate to a human designer with the brief as spec).
8. **Self-improve across rounds & sessions — the loop-log.** After each iteration/batch, append the
   finding to `plateau-app/branding-proposals/loop/LOOP-LOG.md` (standing findings + per-brand log +
   a next-round queue). **Read that log FIRST when starting any loop** so a new round — even a new
   session — starts ahead of where the last one ended, never cold. Promote recurring findings to its
   "Standing findings" list; they are the loop's accumulated craft.

## Record every step in the journey (training data)

Log the trail in `plateau-app/branding-proposals/journey.json` and regenerate
(`npm run gen:branding`): nodes = candidates (with `id`, `file`, `label`, `verdict`, `review`), rounds =
collapsible `<details>`, each varied round pins the mark it varies as a separated `ref` at the top.
Every user verdict is a labeled example — append it to the WE #2207 learning log with the principle it
encodes. The journey + labels ARE the fixture the design-AI reviewer (#2207) trains and regresses
against.

## Honesty clauses

- Rendered-and-looked-at, or it didn't happen. Never call a mark good from geometry alone.
- Breadth is cheap; depth is the point. Prefer refining one mark to convergence over 12 blind options.
- State the ceiling. AI logo craft has a real limit; when the sighted loop stalls, the highest-value
  output is the brief + rubric + corpus handed to a human — say so rather than shipping mediocrity.

## Related

- WE #2209 (brand rubric, ratify), #2207 (design-AI reviewer training + learning log), #2208
  (design-intelligence-watch program). Pipeline & pages: `plateau-app/scripts/gen-branding*.mjs`,
  `branding.html`, `branding-refs.html`.
