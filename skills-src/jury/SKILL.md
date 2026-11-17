---
name: jury
description: Run the subject-agnostic jury on ONE review subject (a PR diff, a rendered design, or a decision approach in prose) through its adapter — resolve the roster, fan out the jurors, and render the verdict + ledger. A THIN shell over the jury engine (we:scripts/lib/jury-core.mjs): all jury logic — diversity-selection, the round cap, the care→rigor dial, which lens is mandatory, how verdicts reduce — lives in the engine, never here. Use when the user asks to "run the jury on <subject>", "convene the jury", "jury this diff/design/decision", or run the jury method by hand. NOT for landing a PR (that is the drain) and NOT for the interactive human verdict on a parked PR (that is /review).
---

# /jury — run the subject-agnostic jury (F1 front door, #2658)

The jury is the reusable, subject-agnostic review method (epic #2649, ratified F1/F2/F3 from the jury-of-#2576
decision record). This skill is its **thin front door**. It owns **no jury logic** — the F1 ruling is that the
method lives once in the engine and the shell only **invokes the engine and renders the result**. Everything about
*how* a jury works — who is on it (roster), how many jurors per lens (the care→rigor dial), which lenses must
unanimously accept (mandatory set), how a split verdict reduces (diversity-selection, never a majority vote), and
the round cap — is a pure derivation in the engine:

- **The engine (the single source of the method):** [scripts/lib/jury-core.mjs](../../../scripts/lib/jury-core.mjs)
  — `resolveAdapterRoster`, `materializeRoster`, `derivePanelVerdict`, `panelRigorForCareLevel`, the #2654 ledger
  event schema. Nothing in this skill re-derives any of it.
- **The three subject adapters** (the only per-domain code — F2): `PR_DIFF_ADAPTER`
  ([scripts/lib/review-core.mjs](../../../scripts/lib/review-core.mjs)), `DESIGN_PIXELS_ADAPTER`
  ([scripts/lib/design-pixels-adapter.mjs](../../../scripts/lib/design-pixels-adapter.mjs)), and
  `DECISION_PROSE_ADAPTER` ([scripts/lib/decision-prose-adapter.mjs](../../../scripts/lib/decision-prose-adapter.mjs)).
- **The harness** that fans the jury out and returns the ledger: [subject-jury.workflow.js](subject-jury.workflow.js)
  — the subject-agnostic generalization of `we:scripts/workflows/review-parked-prs.mjs`.
- **The engine-invoker shim** the harness shells (it does the `resolveAdapterRoster` call the sandboxed harness
  can't `import`): [resolve-roster.mjs](resolve-roster.mjs). Pure glue — zero jury logic.
- **The panel shim** the harness shells to fan the jurors out (#3057): [panel-fanout.mjs](panel-fanout.mjs). It
  calls `judgePanel` ([scripts/lib/judge-panel.mjs](../../../scripts/lib/judge-panel.mjs), #3050), which spawns one
  **tool-free headless `claude -p` juror per seat**. Same reason as above — the sandbox can't `import` a Node
  function. Pure glue: it returns each seat's answer and **derives no verdict**.

## What this skill does

Given a **subject** (`pr-diff` | `design-pixels` | `decision-prose`), a **care-level**, and the subject's
**input** (what earns the perspective lenses) + **material** (what the jurors judge), it:

1. **Selects the adapter and resolves the roster** — through the engine, never by hand. The care band's static
   lenses + the subject's touch-set lenses, materialized into `jurorsPerLens` independent jurors each, with each
   lens's mandate framed by the adapter.
2. **Fans out one juror per rostered seat** over the one shared subject snapshot, each judging under its mandate.
   Since #3057 each juror is a **headless, tool-free `claude -p` process with its own `--session-id`**, derived
   from the run id plus the seat's `lens#slot`, not a subagent. That matters because a subagent **inherits its
   parent's `CLAUDE_CODE_SESSION_ID`** — the identity
   [review-independence.mjs](../../../scripts/lib/review-independence.mjs) keys reviewer independence on — so the
   old fan-out was one actor wearing N hats by this repo's own test. `panelSeats` refuses to seat a panel whose
   derived ids are not pairwise distinct, before anything spawns. Read the limit honestly (#2895): a distinct
   session id is not an *unforgeable* actor signal; it removes the failure a subagent juror has by construction.
3. **Reduces the panel** to per-lens verdicts + one panel verdict via the shared review core
   (`review-core-cli reduce` — diversity-selection). A mandatory lens whose whole jury fails degrades the panel to
   `needs-human` (a jury that did not run never reads as accept).
4. **Red-teams a positive verdict before ratifying it** (#2707). A jury `accept` is a **proposal**, not an
   auto-land: one adversarial red-team agent then actively tries to **break** it. A red-team that runs clean
   ratifies the accept; one that finds a blocking issue bounces it (`changes`, folded into another round); one that
   **does not run degrades to `needs-human`** — fail-closed, an unrun red-team never ratifies.
5. **Renders the verdict + the in-memory jury ledger** (the #2654 event stream) for you to read.

## Run it

Drive the harness with a launch config — the subject, the care-level, the roster `input`, and the `material` the
jury reads:

```
/workflow subject-jury { "subject": "pr-diff", "careLevel": "high", "input": ["src/board.ts"], "material": "<the diff text>" }
/workflow subject-jury { "subject": "design-pixels", "careLevel": "low", "input": { "surfaces": ["board"], "hasTarget": true }, "material": "<a description of the rendered design>" }
/workflow subject-jury { "subject": "decision-prose", "careLevel": "elevated", "input": { "approach": "<the proposed approach>" }, "material": "<the approach prose>" }
```

For a real, multi-hundred-line subject too big to paste inline, point at a file with `materialFile` instead of
`material` — a repo-relative path the **juror agents** read (the sandboxed harness body never touches the
filesystem; only the fan-out jurors, which have file access, open it):

```
/workflow subject-jury { "subject": "pr-diff", "careLevel": "high", "input": ["src/board.ts"], "materialFile": "reports/pr-719.diff" }
```

`careLevel` may be omitted when `reasons` (escalation reasons) are supplied — the harness derives it from them
through the shared review core (`review-core-cli rigor`). The `input` drives which perspective lenses the subject
earns; `material` (inline) **or** `materialFile` (a path the jurors read) is the content the jurors actually judge —
inline `material` wins when both are given.

To resolve just the roster (no fan-out) — e.g. to inspect who the jury would be — shell the engine-invoker directly:

```
node skills-src/jury/resolve-roster.mjs --subject=pr-diff --care-level=high --input='["src/board.ts"]' --json
```

## The boundary — the jury JUDGES, it never acts

This skill (and its harness) **returns a verdict + a ledger and nothing else** — it applies **no label**, posts
**no comment**, and **merges nothing**. What a verdict *does* is the caller's decision (the same "decisions stay in
the loop" boundary `review-parked-prs` holds). Landing a PR is the drain's job; the interactive human verdict on a
drain-parked PR is `/review`.

## The mandatory post-jury red-team + fail-closed posture (#2707)

Two safeguards keep a jury from **fabricating** a positive verdict — the failure the feature-tracking-screen
design session hit, where a foreman synthesized ratings over a jury that produced no real signal:

- **A positive verdict is red-teamed before it ratifies.** When the panel reaches `accept`, the harness runs one
  **adversarial red-team** pass (the sequential `jury → red-team → Round 2` shape that session ratified) that
  assumes the accept is wrong and hunts the reason it should not ship. Only a red-team that runs and **cannot**
  break the accept lets the loop land. A red-team that finds a blocking issue turns the accept into `changes` (its
  findings feed the same round loop); the round cap still bounds the negotiation. The two rules — *a red-team is
  owed exactly on `accept`* and *how its result folds into the final verdict* — live in the engine
  (`redTeamRequired` / `foldRedTeamVerdict` in `we:scripts/lib/jury-core.mjs`), never in this shell (F1).
- **Every stage fails closed on missing signal.** No stage that returns an empty or failed result is ever read as
  accept. A resolve that did not run, a mandatory lens whose whole jury failed, an editor fold that produced
  nothing, and — now — a red-team that did not run **all degrade to `needs-human`**. The invariant is uniform: a
  stage that produced no signal is treated as a *failing* signal, never a silent land.

## Deferred (not this slice)

The **durable on-disk jury logbook** and the fold that replays it (#2641) — this returns the **in-memory** ledger
for now. The **editor↔reviewer convergence** round loop (#2285), the **roster reconcile-at-PR-open** (#2635), the
**disposition judge** over the ledger (#2652), and the design-pixels **`screenshot-vs-target`** grounding (deferred
in its adapter, #2657) are their own slices — a juror on the `visual` lens judges by eye and says it could not run
the automated diff.
