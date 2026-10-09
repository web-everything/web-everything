---
name: next-backlog-item
description: Review the backlog and pick the next item to work on, prioritizing items an agent can implement now (dev-ready) over open design decisions. Use when the user asks "what's next?", "what should I work on?", "pick/select the next backlog item", or "review the backlog and choose". Pass the keyword `decision` (or `review`) to invert the bias and surface the single highest-leverage decision to make instead of a build.
---

# Select — and work — the next backlog item

Trigger + pointer — the rubrics live in
[docs/agent/backlog-workflow.md](../../../docs/agent/backlog-workflow.md)
(*backlog-workflow.md → Selecting the next item to work on*, *backlog-workflow.md → Working an
item*, *backlog-workflow.md → Closing out a completed item*), so every agent uses the same method
and there is nothing to keep in sync here. This skill covers the whole arc: pick it → claim it →
keep its progress in sync → mark it `resolved` when done. If the selection, working, or close-out
method changes, edit `backlog-workflow.md`, not this skill.

**Mode at a glance.** Default is **build-mode** (steps 1–3 rank Tier-A agent-ready work). Two
diversions: an item named in the invocation **skips selection** (step 0); the bare keyword
`decision`/`review` runs **decision-mode** — surface the one highest-leverage *call to make*, not a
build (step 0b). All modes share the same claim → sync → close-out tail (steps 4–8).

> **Working an item edits the tree → enter a lane FIRST (#2123).** Once you've picked an item to *build*
> (not just surface), the work runs in an **isolated lane clone**, never the shared primary checkout —
> `we:scripts/guard-lane.mjs` blocks a primary `Edit` otherwise. Provision/enter a lane before you start
> editing: `node we:scripts/lane-pool.mjs status --json` → pick a clean lane → work + `resolve` there →
> land via PR. The claim/`resolve` frontmatter splice rides that same lane→PR (never a primary write) —
> the #2219 (b) lifecycle, shipped #2264 (which also adds the `prepare-hold` hard lock for the prepare path).

## The loop

**0. Item named in the invocation → skip selection.** When the caller passes an item (a bare `NNN`
like `100`, or a full `NNN-slug`), do **not** run the ranking flow (steps 1–3):

- **Resolve** it against `backlog/*.md` by `#`-id or filename slug. No match / ambiguous → say so and
  fall back to selection (steps 1–3).
- **Branch on status:** `open` → go to claim (step 4); `active` → Resume (step 6); `resolved`/`parked`
  → confirm before reopening to `active`.
- Skip the shortlist and `AskUserQuestion` (the user already chose). Steps 4–7 still apply unchanged.

  **Naming an item skips *selection*, not the claim — and the claim is still its own turn.** This is
  the easy-to-miss trap: a named item (especially a `type:decision`) tempts you to dive straight into
  reading, grounding, and presenting the substance. Do **not**. For an `open` item the *only* action
  this turn is `claim` (step 4) — which STOPs to emit the rename slug — and the work begins next turn.
  **Treat the claim as the literal first tool call**: do **not** `Read` the item body, run grounding
  shell, or present any substance before the claim STOP.

  Two distinct anti-paths, only one of which is mechanically caught:
  - **Pre-claim *edit*** — caught. `backlog.mjs claim` refuses when the item's own file is dirty
    (the claim-first guard; scoped to that one file, `--force` overrides). Without it, claim would
    *silently bundle* your pre-claim edits into the claimed file — it doesn't error, which is worse,
    so the guard turns that into a hard refusal.
  - **Pre-claim *read + present*** — **NOT** catchable. Reading the body and presenting a stance in
    chat leaves no on-disk trace, so no CLI can gate it. The harm is real anyway: you form and publish
    a recommendation before the item is flipped, collapsing the two-go arc (a *selection* go vs a later
    *ratification* go) and racing concurrent sessions on an unclaimed, unlabelled item. This is exactly
    the failure the claim-first STOP exists to prevent — discipline is the only guard, so honour it.

  Claim first, ground/edit/present after.

**0b. Invocation is the keyword `decision`/`review` → decision-mode.** The caller wants the
highest-leverage *call to make*, not an agent-ready build. **Invert the Tier-A bias**: skip the
agent-ready ranking and run *backlog-workflow.md → When nothing is agent-ready — surface the one
highest-leverage blocker* directly, even if Tier-A items exist:

- **Gather** `status: open` items as in step 1, but keep only `type: decision`/`review` (and any open
  item explicitly blocking others). Same concurrency guards (`git status --short`, re-read before
  committing).
- **Rank by downstream-unblock leverage** per that section: most dependents wins (items that name it,
  roll under it via `parent`, or sit in its chain); break ties by size of gated work, then prefer the
  smallest/cheapest decision (a one-nod Tier-B ratification over a wide-open fork).
- **Claim before discussing** — a decision discussion *is* claimable work; an unclaimed,
  never-flipped, unlabelled discussion is exactly the race this guards against. Claim per step 4,
  *before* presenting the decision's substance.
- **Re-validate currency BEFORE presenting — the stale-prep rule, `backlog-workflow.md` → *A stale prep is
  re-prepared before the first presentation* (#1935).** `preparedDate` certifies the research was current
  *when stamped*, nothing more; a card prepared months ago may rest on a premise the tree has since moved.
  This step is not optional and not a skim — it is the first thing after claiming, before any substance
  reaches the user. Three checks, cheap and mechanical:
  1. **`npm run check:item -- <NNN>`** — structure plus whether every cited `file:line` still resolves.
  2. **`npm run check:health`, then read the item's own flags** — especially **G8** (a `## Fork` leaning on a
     still-**open** sibling decision with no `blockedBy` edge: the default rests on an unratified premise, so
     the card its argument depends on must be ruled *first* or the default re-grounded), plus G4/G5.
  3. **Statutes ratified since the stamp.** `grep -n '^\*\*Ratified' docs/agent/platform-decisions.md`, take
     anything dated after `preparedDate`, and read the ones on the card's turf. This half is **judgment, not a
     gate** — a tag-overlap heuristic was prototyped and rejected as tautological, so nothing will flag it for
     you. A card cannot cite a statute that postdates it, so silence here is *never* evidence of currency.
  Present the findings *with* the decision, never after. A card that fails any check is re-prepared in place
  first — never repaired mid-ratification, which reintroduces the divergence the source-of-truth rule forbids.
  *(This step exists because it was skipped: a batch of three was presented as ready, and two of them were
  not — one leaning on an unruled sibling, one predating a statute on its own turf.)*
- **Then present exactly one (next turn) per the decision rule below.** The user picking off the
  shortlist — a `go`, or naming an item — is the trigger to **claim + present for discussion**, *never*
  ratification authority. There are **two distinct `go`s**: the *selection* go (claim + STOP + present)
  and a later *ratification* go (resolve + close), separated by the discussion and red-team. Claiming is
  its own turn (claim, emit the slug, STOP per step 4); the discussion + red-team are the next turn(s);
  ratify + close (step 7) **only on a separate, explicit go** after the fork is actually discussed. Do
  **not** collapse claim → present → discuss → red-team → ratify → commit into the pick turn — this is
  the exact trap the step-0 named-item note warns of, and it applies to a shortlist pick just as much.
  If the user redirects to a different decision, **release the claim** (`active → open`) and claim the
  one they want instead.
- **The item is the source of truth.** As the discussion exposes a clear new element (a finding, a
  reframed fork, a dissolved option, a changed recommendation), write it into the decision item first
  — update by default, no permission needed — then ratify against the item; never ratify chat-only
  content. Pause to ask before writing only when the conclusion is genuinely ambiguous. See
  *backlog-workflow.md → The decision item is the source of truth*.
- **Before you resolve, red-team the default** (*backlog-workflow.md → Red-team the default*): argue
  the strongest case for the main alternative and try to name the principle the chosen branch violates
  (impl-is-not-a-standard, npm-scope-mirrors-layer, the A–E catalog). Attack fails → ratify; attack
  lands → amend and re-attack. Inline for every call. For a high-leverage / high-`gates` fork, add a
  **real independent skeptic — through `judgePanel`, never the `Agent` tool** (#3145): a subagent
  inherits this session's `CLAUDE_CODE_SESSION_ID`, so a "throwaway skeptic sub-agent" refuting your
  own default is you refuting yourself by the test `we:scripts/lib/review-independence.mjs` applies.
  One tool-free headless seat, judging the fork as prose:

  ```bash
  # $PAYLOAD: { subject: "decision-prose", subjectNoun: "decision", materialFile: "<the fork's prose>",
  #             jurors: [{ id: "skeptic#1", lens: "skeptic",
  #                        mandate: "Refute this default. Default REJECT; reject on any uncertainty.
  #                                  Name the principle it violates or state plainly that you found none." }] }
  node skills-src/jury/panel-fanout.mjs --payload-file="$PAYLOAD" \
    --depth=0 --max-depth=2 --max-total-budget-usd=2 --run-id="ratify-<NNN>"
  ```

  Write the fork's prose to a file and point `materialFile` at it — the seat is tool-free and reads only
  its stdin, so it never opens the item itself. `ok: false` is a skeptic that **did not run**, and an
  unrun red-team never ratifies: re-run it or say plainly that the call was made without one.

  > **Coordinate with #3033 before calling this settled.** The prepare-side skeptic pass hit the identical
  > bug, and the design discussion there is to mechanize ratify as a declared operation with a `judge`
  > step — which would fix this site structurally (the engine suspends and the caller must make a real
  > `judgeSpawn`/`judgePanel` call between two `advance` calls). If #3033 ships that, this block becomes
  > the operation's `judge` step rather than a second, divergent fix — do not leave both standing.
- **Once the call is made, close out the decision item itself** per step 7 (`active → resolved` +
  `dateResolved` + record the ruling, `graduatedTo` if it became an entity). The gated work then turns
  agent-ready — continue the arc or re-run selection. If the open-decision pool is empty, say so plainly
  rather than inventing a decision.

With no item named, run the full selection flow below.

1. **Get the ranked list through the OPERATION — `node scripts/operations/run.mjs suggest-next --json`**
   (don't re-tier by hand, and don't reach past it to the raw CLI). It declares over the same loader
   `npm run check:readiness -- --select` prints, so tier/batchable/leverage are identical — but it answers
   as data, and it takes a **scope** (#xhhsfnq), which the raw CLI does not:

   ```
   node scripts/operations/run.mjs suggest-next --tier=A --limit=5 --json      # the ranked pool
   node scripts/operations/run.mjs suggest-next --parent=<NNN> --json          # what is left in ONE epic
   node scripts/operations/run.mjs suggest-next --tag=<tag> --json             # one theme
   node scripts/operations/run.mjs suggest-next --locus=<repo> --json          # one gate home
   ```

   **Reach for a scope before you reach for `grep`.** "What is left in this epic" and "what else is tagged
   `gate`" are the two questions that used to send an agent grepping `parent:` across `we:backlog/` and
   reading cards by hand — a second read of the board, and how two views of it drift apart. A scope that
   matches nothing says so (`empty.note` — *"the pool is NOT empty, your scope is"*) and is never widened
   back to the unscoped list, so an empty answer is never a silently broader one.

   The scope only NARROWS; it never re-ranks. Your added judgment is the body-fork pre-flight on the
   **shortlist** plus the dependency/concurrency re-read before committing. Then follow
   *backlog-workflow.md → Selecting the next item to work on*. Do **not** re-glob and re-score all 100+
   items in prose.
2. **Bias to Tier A — agent-ready first.** Prefer `issue`/`idea` items with a concrete, bounded build
   against proven infra and no open design fork. De-prioritize `decision`/`review` items; surface them
   for discussion rather than picking them. **Tie-break toward proof (#2949):** between otherwise-similar
   candidates, prefer the one already carrying an `## Acceptance` section (older cards: `Done when`) with a tier-1/2
   entry (*backlog-workflow.md → Acceptance criteria*) — less review-cost ambiguity to resolve later.
3. **Present, then offer clickable options.** Output a short ranked shortlist (top 3–5, grouped by tier,
   one-line rationale each) plus the recommended item with its reasoning — the discussion context. **Use
   each candidate's digest** (lead paragraph / `summary`) as that one-line rationale; if a shortlisted
   item's digest is stale, **fix it on the spot** (*backlog-workflow.md → The digest*). **Then call
   `AskUserQuestion`** so the user can pick with one click: one question (header e.g. `Next item`), the
   recommended item as the **first** option labelled `#NNN <slug> (Recommended)`, each runner-up its own
   option, one-line rationale in each `description`. The tool's auto-added "Other" lets the user redirect
   in prose — selecting is the fast path, not a constraint (the one place we trade discussion-style for
   click-to-pick, because it's a bounded selection among concrete items, not an open design fork). **Every
   offered item carries two links** (*backlog-workflow.md → Output*): its **live page**
   `http://localhost:3000/backlog/<NNN-slug>/` (Vite `:3000` proxies `/backlog/` to 11ty `:8080`) and its
   **source file** `backlog/<NNN-slug>.md` — keep these in the prose shortlist (chips are for the pick,
   links live in the text). **Remember the runner-ups** (`#NNN <slug>` + rationale) — that shortlist is
   the carry-forward list step 8 re-offers without re-analyzing the backlog.

   **3a. Recommended item is a `decision`/`review` (Tier B/C) → present the decision, don't offer a
   build.** Claim it first (per step 4 — discussing a fork is claimable work). *Then*, next turn, **skip
   `AskUserQuestion`** and present per the decision rule in step 0b (planning-as-discussion: open fork /
   human judgment, options + tradeoffs, recommendation + reasoning; keep live + md links). **First run the
   fork-readiness pass** (*backlog-workflow.md → step 3a's Fork-readiness pass*): **research the fork first**
   — a greenfield/standard-authoring decision must run *design-first.md step 1* and materialize a
   `reports/…md` linked via `relatedReport` *before* forming any stance — then confirm the item has a
   concrete example, names its options with tradeoffs, and is concise; **fix the item on the spot** if it
   falls short (same rule as the digest). If the user redirects, release the claim (`active → open`) and
   claim that one. Once the call is made, close out the decision item (step 7); its successor build then
   becomes agent-ready.

   **3b. No Tier-A item exists** (ready pool empty — all that's left needs a design call): do **not** dump
   a menu. Per *backlog-workflow.md → When nothing is agent-ready*, surface the **single** highest-leverage
   blocker, claim it first (step 4), and present it per step 3a. Resolving it (step 7) turns work
   agent-ready; then re-run selection.

   *(The `AskUserQuestion` fast-path in step 3 is **only** for a bounded pick among ready Tier-A items,
   never for a design fork.)*

Once the user says go, **track it in the item, not just in your head** (*backlog-workflow.md → Working
an item*). The backlog file is the durable, resumable record — the item body *is* the contract.

4. **Claim it on start — claiming is its own turn; do not start work in it.** This step runs whenever you
   flip an item to `active`, **including decision-mode** (0b/3a/3b), where the claimable work is the
   discussion itself. Run **`node scripts/backlog.mjs claim <NNN> --stop-for-rename`**.

   **The flag is what asks for the stop, and `/next` is the only caller that passes it** (#xd0hvsg). The
   two-turn stop guards the SELECTION hand-off — a human renames the chat and re-prompts — so it belongs to
   THIS flow, not to claiming in general. A batch labels its session once and a directed claim owns its own
   turn structure; both proceed in the same turn. Omit the flag and the claim will not stop.

   Also note WHY this step names the CLI and not the operation, because the rule is easy to get backwards
   (this exact step was rewired to `run.mjs claim` and the correctness juror on PR #1508 caught it as a
   regression):

   > **`backlog.mjs claim` ALREADY DELEGATES to the declared `claim` operation** (`claimViaOperation`, #3034)
   > — and then does three things the operation deliberately does not own: it clears any cross-session soft
   > reservation (#083 invariant 2), records the `.claude/skills/batch-backlog-items/claims.json` attribution
   > baseline that `check:standards --scope=<session>` reads, and (given `--stop-for-rename`) prints the
   > rename slug + two-turn stop block
   > that the rest of THIS step depends on. Calling the operation directly silently drops all three.
   >
   > **The rule, stated once:** name whichever caller COMPOSES the other. Where the CLI wraps the operation
   > (`claim`), the CLI is the fuller caller and the skill names it. Where the operation wraps the CLI
   > (`verify` over `we:scripts/verify-lane.mjs`), the operation is the fuller caller and the skill names
   > that. "Skill mentions a raw home" is therefore NOT automatically a miswiring — check which way the
   > delegation runs before rewiring anything.

   It wins the race (refuses if no longer `open`, if the item is queued or prepare-held, or if the item's own
   file has uncommitted edits — the claim-first guard, `--force` to override), flips `open → active` + stamps
   `dateStarted` (today) in one splice, and prints the rename slug. (`check:standards` does not backfill
   `dateStarted`, so the stamping command is the point; `dateResolved`/`graduatedTo` come later, at step 7.)

   > Two properties of the underlying operation worth knowing anyway: it has **no `--dry-run`** — there is no
   > way to inspect it without causing the write — and its guards do **not** include `blockedBy`, so it will
   > claim blocked work. The readiness check in steps 1–3 is what prevents that, not the claim.

   Then **STOP that turn immediately** —
   the claim edit and the label prompt are the *only* things that turn does. Do **not** chain reads,
   planning, or any other tool call after the flip; if you keep working, the label prompt gets buried and
   silently skipped. End the turn with a "Claimed #NNN — starting next" note, then the label prompt (Claude
   can't rename programmatically): tell the user to rename the chat via the tab menu, and emit the bare
   `<NNN-slug>` in its **own fenced code block** (inline code gets no copy button). For example:

   > Rename this chat via the tab menu to label this session — copy:
   > ```
   > 089-monetization-tiers
   > ```

   Begin the actual work on the *next* turn.
5. **Keep it in sync as you go.** Maintain the `## Progress` block (Status / Branch / Done / Next / Notes)
   *as work happens*, not at the end — if the session is lost, that block is all the next one has. Flip back
   to `open` if you abandon it unfinished. Also keep **one** `in_progress` TodoWrite entry phrased as a
   present-tense status — it's surfaced live as this card's *currently-doing* on the /backlog Active-work
   tab (*backlog-workflow.md → Working an item → Keep it in sync*); let it double as your progress channel
   instead of narrating in prose. At claim, also **re-evaluate this item's `blockedBy` edges**
   against its body (*backlog-workflow.md → Keep the blocker DAG honest*): lift any prose prerequisite
   ("after #NNN", "blocked on…", "needs X from #NNN") into the field, drop any spurious edge — do this
   *with* the claim edit, not a separate turn.
6. **Resume, don't re-pick, an `active` item.** Asked to continue one (or finding a stranded claim): read
   its `## Progress`, check out its branch, continue from **Next**.
7. **Close it out when done — mark it `resolved`** (*backlog-workflow.md → Closing out a completed item*).
   Confirm done — prove any guard `## Acceptance` criteria (older cards: `Done when`) fail under mutation via `node scripts/operations/run.mjs mutation-check --checkout=<lane> --target=<file> --find="<pattern>" --replace="<pattern>" --suite=<suite>` (see *Prove a guard fails — mutation-check* below), then verify with `node scripts/operations/run.mjs verify --checkout=<lane> --json`, whose `verdict.ok` is true
   only when every check PASSED (an `unrun` check is not a pass; see *backlog-workflow.md → Closing out*) — take a **careful last look for leftovers** and capture
   each as its **own new item** via the OPERATION — **`node scripts/operations/run.mjs scaffold
   --title='…' --workItem=… --size=… --digest='…' [--parent=NNN] [--blockedBy=NNN,xhash] --json`** (#xrrpfo7).
   It refuses with a NAMED reason rather than writing a malformed card: `bad-kind`, `no-title`,
   `story-needs-size`. `--blockedBy` and `--parent` take numbers OR hashes and normalize each correctly —
   a number pads, a hash does **not** (padding `xvatzyf` corrupts it into an id that resolves to nothing).
   **The flag is `--workItem`, camelCase.** The operation's flags are derived from its declared input
   fields, and the parser matches them case-sensitively, so a lowercase `--workitem=` is refused as an
   unknown flag — a claim that "the legacy spelling still resolves" was in an earlier draft of this line and
   is false (PR #1511 juror). What IS preserved is the legacy kind PRECEDENCE over the values: an explicit
   `--kind` wins, else `--type=decision` wins, else `--workItem`. `we:scripts/backlog.mjs scaffold` is
   unchanged and still takes the lowercase spelling, so existing invocations of THAT keep working (**single quotes** — item text in a double-quoted value
   still runs `` ` `` / `$(…)` through bash; *backlog-workflow.md → Authoring an item → The quoting rule*).
   **Both front doors mint the SAME id, and it is not a number.** Under JIT numbering (#2288) a new item is
   born `backlog/xNNNNNN-<slug>.md` — a collision-free **hash** — and the drain, the sole serial writer to
   `main` (#2290), assigns the real sequential `NNN` at land. Neither the operation nor the CLI allocates
   `max+1` at birth; that race is exactly what #2288 removed, so **you never hand-pick a number** and a
   hand-authored file is born hash-keyed too (the "re-`ls backlog/`, yield to the next free number on
   collision" ritual is the demoted #2291 collision-heal backstop, not the birth rule). Either way you get
   a `check:standards`-shaped skeleton that validates green pre-merge.
   **Never renumber an existing item** — `NNN` is immutable for life
   (*backlog-workflow.md → Adding an item* / *Rules*). Each new item needs a `workItem` (story/epic/task)
   and, if a story or unstoried epic, a Fibonacci `size` (*backlog-workflow.md → Agile sizing*); set its
   `blockedBy` correctly (*backlog-workflow.md → Keep the blocker DAG honest*) so it doesn't enter as a
   falsely-ready Tier-A item; open it with a real digest (≤100-word "what + why" lead — *backlog-workflow.md
   → The digest*). Then run the OPERATION —
   **`node scripts/operations/run.mjs resolve --ref=<NNN> [--graduatedTo=<entity>] [--codifiedTo=<anchor>] --json`**
   (#xrrpfo7, `claim`'s sibling at the close of the lifecycle). It flips `active → resolved`, stamps
   `dateResolved`, sets `graduatedTo`/`codifiedIn` if passed — then re-run `check:standards`.

   It REFUSES rather than writing a contradiction, and each refusal names itself so you can act on it:
   `open-children` (#658 — an epic cannot close over live slices), `uncodified-decision` (#911 — a decision
   must carry its rule into the statute layer first), `scope-drift` (#2803 — an item that edited a UI surface
   its `scope:` never declared), `not-in-flight` (only an in-flight item resolves). `--force=true` steps over
   the first and third **and the verdict records which** (`forced`, `steppedOver`) — so a batch close-out can
   refuse to proceed over a forced resolve, which the old stderr warning made impossible.

   `verdict.scopeUnchecked` is a THIRD state, not a flavour of clean: it means the item declared no `scope:`
   so the #2803 reconciliation could not run at all. Do not read it as "checked and fine". The file stays (`resolved` items drop from selection, hidden by default on
   `/backlog/`) — an audit trail, not clutter. Do **not** delete the file.
8. **Hand off the next pick — emit the carry-forward list.** Re-present the runner-ups held from step 3
   (drop any now `active`/`resolved`) as a **plain bullet list, not `AskUserQuestion`** — one bullet per
   item: `#NNN <slug>` + one-line rationale. A cheap shortcut, not a fresh ranking. Lead the top candidate
   with a copyable invocation in its **own fenced code block**, e.g.:

   > Next candidates (carried from this session's shortlist — not re-ranked):
   > - `/next 100-requirement-as-code` — extract requirements as first-class artifacts
   > - `/next 102-changelog-manifest-standard` — standardize the update manifest
   >
   > Copy to start the top one in a fresh session:
   > ```
   > /next 100-requirement-as-code
   > ```

   If the invocation came from step 0 (item named directly, no shortlist gathered), there is nothing to
   carry — skip this step.

## Prove a guard fails — mutation-check (#3219)

When an item's `## Acceptance` criteria (older cards: `Done when`) demand proving a guard actually fails when the bug it names returns, run the declared **`mutation-check`** operation (`we:scripts/operations/mutation-check.mjs`, #3219). It replaces ad-hoc shell or python heredocs with a safe, verified mutate → run → restore transaction in the target checkout:

```
node scripts/operations/run.mjs mutation-check --checkout=<lane> --target=<file> --find="<pattern>" --replace="<pattern>" --suite=<suite> [--json]
```

- **Why use it**: a green test suite proves the code passes the tests, not that the tests would catch the bug if reintroduced. Running vitest against a manually mutated file risks leaving mutants behind if the run dies or aborts. `mutation-check` captures the original bytes, runs the baseline suite first (must be green), applies the mutant, runs the named suite, and unconditionally restores the original file in a verified `finally` block.
- **Flags**:
  - `--checkout=<lane>` — the working tree / lane clone to mutate in (required; never defaulted to cwd for safety).
  - `--target=<file>` — file the bug goes back into, relative to `checkout` (required).
  - `--find="<pattern>"` — exact literal text in `target` to replace (required; literal, not regex).
  - `--replace="<pattern>"` — exact literal text to replace it with (required).
  - `--suite=<suite>` — the vitest suite expected to catch the mutant (required; passed to `vitest run <suite>`).
  - `--json` — optional JSON output including the full verdict and probe findings.
- **Outcomes**: three-valued — `killed` (the guard caught the mutant; passes), `survived` (the mutant stayed green; **blocking** defect — the guard is vacuous), or `unrun` (the pattern was not found, the baseline was red, or the runner crashed; also **blocking**).
