# Conveyor prepare-scope agent brief (template) — author ONE item's `scope:`, stop at ready-to-merge (#2613)

> **This is a TEMPLATE, not a runnable skill.** The `/conveyor` skill (#2613) instantiates it — filling the
> `{{PLACEHOLDERS}}` below — and passes the result as the prompt for **one background prepare-scope agent** it
> spawns per `unshaped-no-scope` item (a cleared item the dispatcher is holding because it has no predicted
> `scope:`). One agent = one item = one lane = one PR that authors that item's scope. This is the AUTO-PREPARE
> half of the corrected design (Nicolas, 2026-07-22): an unscoped cleared item is **never built blind** — the
> conveyor first prepares its `scope:`, then builds it normally once scoped.

## Why this exists (the one-paragraph frame)

The deterministic dispatcher (`scripts/readiness/dispatch-plan.mjs`) will **never launch an unscoped item to
build** — an item with no predicted `scope:` is "assume-overlaps-everything" (it might touch any file), so
building it blind is a merge hazard and it is held `unshaped-no-scope`. Predicted `scope:` is authored UPSTREAM
at readiness; the dispatcher only reads it. **You are that upstream step, run just-in-time:** you predict the
item's touch-set and write its `scope:`, so on a later tick the now-scoped item dispatches to BUILD. You do the
JUDGMENT (predict the touch-set); every script-decidable step around it is a script you shell, per
[we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment).

## Fill these before spawning

| Placeholder | What the conveyor fills it with |
|---|---|
| `{{ITEM_NUM}}` | the backlog item number (or `xNNNNNN` hash) of the held unshaped item — e.g. `2613` |
| `{{ITEM_SPEC_PATH}}` | the item's backlog file — `backlog/{{ITEM_NUM}}-<slug>.md` (the ONLY file you edit) |
| `{{LANE}}` | the free lane id the skill assigned this prepare (from the free-lane set) — e.g. `4` |
| `{{SESSION_SLUG}}` | the per-item prepare session slug — `prepare-{{ITEM_NUM}}` (ties `acquire`↔`release`) |
| `{{WE_ROOT}}` | **#4174** — the absolute WE checkout you are dispatched FROM. You start in a scratch directory outside it (never inside it — see step 1), so this is the only way step 1's `lane-pool.mjs` is findable before you have a lane of your own. |

> **Two kinds of placeholder.** `{{LIKE_THIS}}` are **conveyor-injected** — the skill substitutes them before
> spawning you (the table above). `<like-this>` are **agent-runtime values** you produce as you work — the
> `<slug>` in the lane ref, the `<pr-body>` file you write, the `<n>`/PR number `pr-land` reports back.

> **Your PR's scope is KNOWN A PRIORI.** You edit **exactly one file** — `{{ITEM_SPEC_PATH}}` — and nothing
> else. That is why every prepare is **parallel-safe** with every other prepare AND with every running build:
> each prepare touches a *different* single story file, disjoint from the code any builder is touching. Your
> lane's `--scope` is that one file, so the dispatcher's scope-lease board already knows this lane can never
> collide. Do **not** widen the edit beyond the frontmatter of `{{ITEM_SPEC_PATH}}`.

---

## Your job (one sentence)

In an isolated lane clone, **predict item #{{ITEM_NUM}}'s touch-set** (the directories/files its build will
modify, coarse and module-level), write that as `scope:` frontmatter in `{{ITEM_SPEC_PATH}}` (and **only** that
file), get the gate green, **review your own scope prediction to convergence with an adversarial subagent**,
open a `ready-to-merge` PR through the canonical producer — then **EXIT WITHOUT MERGING**. The resident drain
daemon lands it; the now-scoped item builds on a later conveyor tick. You do **not** claim, build, or resolve
the item — you only author its scope.

## The arc — one command per transition

### 1. Acquire a lane-pool clone (never edit the primary checkout)

> **You started in a scratch directory, not a checkout.** It holds nothing of `scripts/` — never write a file
> there by a relative path, and never write ANYTHING into `{{WE_ROOT}}` itself (the checkout that dispatched
> you): either one left dirty by a stray write is how a dispatcher's own clone gets stuck refusing every future
> dispatch as stale (#4174). Everything you do belongs in `$LANE`, from the moment it exists.

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --lane={{LANE}} --purpose=conveyor-prepare-scope \
  --session={{SESSION_SLUG}} --scope=we:{{ITEM_SPEC_PATH}}) && cd "$LANE"
```

- `--lane={{LANE}}` takes the exact lane the skill assigned. If it lost its race to a sibling, `acquire` fails
  loud — report it and exit; the skill re-dispatches.
- `--scope=we:{{ITEM_SPEC_PATH}}` declares this lane owns **one backlog file** — the a-priori-known scope. All
  work happens in `$LANE`, never the primary.

### 2. Read the spec + the code the build will touch (this is the prediction)

- Read `{{ITEM_SPEC_PATH}}` **in full** — the story, its `## Progress`, its tags/locus, any `blockedBy`.
- Read the **code the story describes touching**: grep/skim the modules, directories, and files the spec names
  or plainly implies. You are not building it — you are locating **where** it would build.
- Form a **coarse, module-level** touch-set: the directory or file **prefixes** a builder would modify.
  Same kind of prediction the /workflow lane's touch-set probe makes — err toward the **enclosing directory**
  (`we:scripts/readiness/`, `we:skills-src/conveyor/`) rather than guessing exact filenames, and toward **slightly
  wider** when unsure (a scope that is too narrow risks a build touching an undeclared path; a coarse directory
  prefix is the safe, honest prediction). **Every** entry is repo-qualified — a WE path is `we:...`, a cross-repo
  path is `fui:...` / `plateau:...`; never a bare prefix (a bare path is rejected by the locus hook and the
  lease engine reads it as repo `null`, so it never matches an observed `we:`-qualified file).

### 3. Write `scope:` into the story frontmatter — edit ONLY `{{ITEM_SPEC_PATH}}`

Add a `scope:` key to the YAML frontmatter of `{{ITEM_SPEC_PATH}}` — an array of repo-qualified path prefixes:

```yaml
scope:
  - we:scripts/readiness/
  - we:skills-src/conveyor/
```

- **Scope entries MUST be repo-qualified (`we:...`)** — bare prefixes are rejected by the locus hook (#883) and
  break lease matching (the scope-lease engine reads a bare path as repo `null`, which never matches an observed
  `we:`-qualified file, so overlap detection silently fails).
- **Edit that one file only.** No code, no other backlog item, no docs. Writing `scope:` is a frontmatter/card
  mutation — it flows through the normal backlog write path and the lane guard, which is exactly why it must ride
  a lane→PR (committed frontmatter, authored upstream). Because you are in the lane clone, the write is allowed.
- **Never author an EMPTY `scope: []`** — the gate ERRORS on it (an empty scope reads as unscoped, which would
  just re-hold the item). List real prefixes, or if you genuinely cannot predict any, escalate (below) rather
  than write `[]`.

### 4. Run the gate GREEN

The scope shape is enforced by `check:standards` (array of non-empty strings; empty/`[]` is an error). Run it in
the item's own locus (a WE item is `check:standards`; a cross-locus item runs `LOCI[item.locus]`'s gate):

```bash
npm run check:standards
```

A red gate is a hard stop — fix your frontmatter (usually a bad YAML shape or an empty array) until it is green.

### 5. Review your own scope prediction — spawn an adversarial review subagent (converge BEFORE the PR)

A green gate proves the scope frontmatter has a **valid shape**; it does **not** prove the prediction is
**right** — that the listed prefixes actually cover what a builder would touch, are honestly repo-qualified, and
are not so narrow that the build spills onto an undeclared path. That is judgment a script cannot do (the gate
is the deterministic core, this review is the judgment, per
[we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)).
**This step is the operator invariant (#2629): NO PR reaches a human review gate without an automated
AI-reviewer convergence pass first.** A scope PR is normally auto-landing, but it **can** be human-routed — a
statute-touching item is parked `review:human` by `pr-land`'s rubric, and a human may sample any open PR (that
is exactly what happened to a scope PR bounced with no prior AI pass). So run the review **unconditionally**,
here, before the PR opens — never skip it because "scope PRs usually auto-land".

Spawn **one adversarial review subagent** on your predicted `scope:` + the spec it was predicted from, and
**AWAIT its completion — its final report (return value) IS the verdict.** The harness delivers a spawned
subagent's final report to its spawner automatically, so you read that returned report directly; nothing can
lose it in transit.

- **Read-only, scope-focused.** It reviews the one-line-of-truth of this lane: the `scope:` array against
  `{{ITEM_SPEC_PATH}}`'s story. It checks the prediction is **complete** (every module the build plainly implies
  is covered), **honest** (no invented path the spec does not support), **correctly repo-qualified** (`we:` /
  `fui:` / `plateau:`, never a bare prefix), **coarse but not too narrow** (err to the enclosing directory), and
  **non-empty**. It reports findings; it does not edit the frontmatter.
- **The verdict rides the RETURN, never a name-addressed message.** Instruct the review subagent to put its
  FULL verdict — converged / the findings list / any blockers — in its **final report/return**, NOT to
  `SendMessage` it back to you by name. A name can be unreachable once an agent completes, which would stall the
  converge-before-PR handshake (#2624). Read the verdict off the returned final report.
- **Address every finding to CONVERGENCE — don't rubber-stamp, don't silently drop.** Fix a real gap by
  widening / correcting the `scope:` in `{{ITEM_SPEC_PATH}}` (still that ONE file only). A finding you judge
  not-real is **dismissed with a one-line reason** (never dropped in silence). Re-run the review after any
  nontrivial change, until a pass comes back clean (or with only dismissed-with-reason findings). **Only then**
  proceed to the PR. If a finding needs human judgment you cannot self-clear (e.g. the spec is genuinely too
  vague to scope honestly), escalate per *Escalations* rather than ship an unreviewed guess.

### 6. Commit on the lane's current branch + publish HEAD to the `lane/...` ref + open the PR (ready-to-merge)

Commit **only** `{{ITEM_SPEC_PATH}}` (explicit path, never `git add -A`; one commit) on the lane's **current
branch** (its local `main`) — do **NOT** `git checkout -b lane/...`; the single-branch hook blocks branch
creation even inside a lane clone. You never create the `lane/...` branch locally: `pr-land` **publishes HEAD**
to that ref for you via `--ref=... --sha=HEAD`. Then open the PR through the canonical producer — **never a
hand-rolled `gh pr create`**:

```bash
# Write the commit message to a file, then commit -F it. Do NOT put the message
# in a bash heredoc: backticks in a heredoc (e.g. `scope:`) run as a subshell
# (`bad substitution`). A message file has no such footgun.
printf '%s\n' "WE #{{ITEM_NUM}}: author scope: for #{{ITEM_NUM}}" "" \
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > <msgfile>
git commit -F <msgfile> {{ITEM_SPEC_PATH}}

node scripts/operations/run.mjs open-pr --ref=lane/{{ITEM_NUM}}-scope-<slug> --sha=HEAD --base=main \
  --bodyFile=<pr-body> --mode=label-on-green --json
```

`--mode=label-on-green` opens the self-approved PR, waits for the required `test` check, applies `ready-to-merge`
**only when green, then STOPS** (the resident drain lands it). This is the **default and expected** outcome:
your diff is **one backlog file** — low-risk and bounded — so it **auto-lands with no human in the loop**. There
is **no review escalation** for a scope-only PR unless the item itself is **statute-touching** (`pr-land`'s
deterministic rubric, #2307, applies `review:human` on its own if so — you do nothing extra). Do **not**
blanket-park a scope PR.

`open-pr --mode=label-on-green` BLOCKS until the required `test` check is green (often several minutes). Run it
BACKGROUNDED (or with a generous timeout) — a foreground call may hit the tool timeout mid-wait, which is
EXPECTED and harmless: the PR is already open (`checking`), and re-invoking `open-pr` with the SAME `--ref` is
idempotent (it targets the existing PR and applies the label, never a duplicate).

- End the commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

### 7. (optional) Drop one learnings entry, then EXIT — do not merge, do not release

If preparing this item surfaced a generalizable lesson (a friction, a missing convention, a doc/skill gap),
append **one** structured entry via the write-gated drop-box (no code / paths / repo names — the schema rejects
them):

```bash
node scripts/conveyor/learnings-drop.mjs \
  --kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --summary="<one sentence — the lesson>" --area="<coarse label, e.g. scope prediction>" \
  --suggestion="<short recommendation>" --session={{SESSION_SLUG}}
```

`--summary` is capped at 240 chars (over-length is rejected) — keep it to one tight sentence.

Then **STOP.** Do NOT run `gh pr merge`. Do NOT run a drain. Do NOT `release` the lane — the resident drain
daemon lands the PR, and when it does the item is scoped, so the conveyor dispatches it to **build** on a later
tick. Return a one-line result to the conveyor: `#{{ITEM_NUM}} scope → PR #<n> (ready-to-merge | escalated
<label> | gate-red | could-not-predict)`. A red gate / red CI is NOT watcher-visible, so your one-line RETURN is
the only signal for it — always report it explicitly.

---

## Escalations — when you do NOT reach ready-to-merge

Escalation is **by good reason only** — a scope-only PR normally auto-lands. Escalate ONLY when:

1. **Cannot predict a real scope** — the spec is too vague to name any honest path prefix (a readiness gap, not
   a scope gap). Do **not** invent a scope and do **not** write `[]`. Leave the frontmatter unchanged, open **no**
   PR, and return `#{{ITEM_NUM}} scope → could-not-predict — needs readiness shaping` so the operator shapes it.
2. **Gate red** — `check:standards` fails from your frontmatter and you cannot get it green. Report the failing
   check and stop; do not weaken a test to go green.
3. **Statute-touching item** — if the item is statute-touching, `pr-land`'s rubric parks it `review:human` on
   its own. Let it — do not try to clear it yourself. **You still run the step-5 review first** (#2629): the
   invariant is that even a parked scope PR reaches the human only *after* an AI convergence pass.
4. **A review finding you cannot self-clear** — the step-5 adversarial review surfaced a gap you fixed what you
   could of, but one issue needs a human call (e.g. the spec is genuinely too vague to scope honestly). Do
   **not** ship an unreviewed guess: either return `could-not-predict` (case 1) if no honest scope exists, or
   open the PR parked `review:human` (`--park=review:human`) — never leave a scope PR to auto-land with an
   unresolved review finding.

## Guardrails (the non-negotiables)

- **Edit exactly one file — `{{ITEM_SPEC_PATH}}`'s frontmatter.** No code, no other item, no docs. That single
  known-a-priori file is the whole parallel-safety guarantee.
- **Never build, claim, or resolve the item** — you only author its `scope:`. Building happens later, on its own
  conveyor tick, once the item is scoped.
- **Never edit the primary checkout** — all work is in the acquired lane clone (#104/#2183).
- **Never merge** — you stop at `ready-to-merge`; the resident drain daemon is the sole writer to `main`.
- **Never hand-roll `gh pr create`** — route through `pr-land` so the #2307 producer review-label applies at
  open.
- **Never write `scope: []`** — the gate errors on it and it re-holds the item; list real prefixes or escalate.
