# Conveyor prepare-decision agent brief (template) — prepare ONE decision's forks, stop at ready-to-merge (#2647)

> **This is a TEMPLATE, not a runnable skill.** The `/conveyor` skill (#2612) instantiates it — filling the
> `{{PLACEHOLDERS}}` below — and passes the result as the prompt for **one background prepare-decision agent** it
> spawns per **UNPREPARED** `needs-decision` item (a cleared `kind:decision` the dispatcher is holding because a
> decision is never a build). One agent = one decision = one lane = one PR that brings the decision's forks to
> "ready to ratify". This is the PREPARE half of the conveyor's decision lifecycle (#2647): an unprepared cleared
> decision is **never ratified blind** — the conveyor first prepares its forks, then PRESENTS them (a chat
> artefact + the #2565 ruling surface) for a human to ratify. You do the prepare; you never make the call.

## Why this exists (the one-paragraph frame)

The deterministic dispatcher (`scripts/readiness/dispatch-plan.mjs`) will **never launch a decision to build** —
a decision is not build work; its lifecycle is **prepare** (research + author its forks) then **present**
(surface the prepared forks to ratify), so it is held `needs-decision`. **You are the prepare step, run
just-in-time:** you do the autonomous half of a decision — the prior-art survey, the per-fork classification, the
authored forks with a bold default, the skeptic + two-confusion screens — and stamp `preparedDate`, so on a later
tick the now-prepared decision is PRESENTED for ratification. This is **pure agent work — no human judgment yet**
(the `/prepare` skill's exact mandate); the ratify call stays human. You do the JUDGMENT (research + author the
forks); every script-decidable step around it is a script you shell, per
[we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment).

## The method is the `/prepare` skill — do NOT restate it here

The full prepare method — the standing test, the prior-art survey, the per-fork classification, the prepared-fork
shape, the skeptic pass, the two-confusion screen, and the close-out (`prepare-stamp` → land one PR →
`prepare-release`) — lives in the **`prepare-decision-item` skill**
([`skills-src/prepare-decision-item/SKILL.md`](../prepare-decision-item/SKILL.md)) and the docs it points at
(`docs/agent/backlog-workflow.md` → *Fork-readiness pass* / *Per-fork classification pass* / *The prepared-fork
shape*; `design-first.md` → step 1; `research-workflow.md`). **Read that skill and follow it in full for the
authoring work.** This brief only wraps it in the conveyor's **background-agent arc**: acquire a lane, do the
`/prepare` work in that lane, review it to convergence, land ONE PR, exit without merging. Where the `/prepare`
skill assumes an interactive human picking an item and discussing — you skip that: your item is already chosen
(`{{ITEM_NUM}}`) and cleared, and you run the whole prepare autonomously in one pass. If the method changes, edit
the `/prepare` skill / the docs, never this brief.

## Fill these before spawning

| Placeholder | What the conveyor fills it with |
|---|---|
| `{{ITEM_NUM}}` | the backlog item number (or `xNNNNNN` hash) of the held unprepared decision — e.g. `2568` |
| `{{ITEM_SPEC_PATH}}` | the item's backlog file — `backlog/{{ITEM_NUM}}-<slug>.md` |
| `{{LANE}}` | the free lane id the skill assigned this prepare (from the free-lane set) — e.g. `4` |
| `{{SESSION_SLUG}}` | the per-item prepare session slug — `prepare-decision-{{ITEM_NUM}}` (ties `acquire`↔`release`, `prepare-hold`↔`prepare-release`) |
| `{{WE_ROOT}}` | **#4174** — the absolute WE checkout you are dispatched FROM. You start in a scratch directory outside it (never inside it — see step 1), so this is the only way step 1's `lane-pool.mjs` is findable before you have a lane of your own. |

> **Two kinds of placeholder.** `{{LIKE_THIS}}` are **conveyor-injected** — the skill substitutes them before
> spawning you (the table above). `<like-this>` are **agent-runtime values** you produce as you work — the
> `<slug>` in the lane ref, the `<pr-body>` file you write, the `<n>`/PR number `pr-land` reports back.

---

## Your job (one sentence)

In an isolated lane clone, **bring decision #{{ITEM_NUM}}'s forks to the "Definition of Ready"** by running the
`/prepare` method (research + author each fork's options + bold default + skeptic + screen), `prepare-stamp` its
`preparedDate` **in the lane**, get the gate green, **review your prepared forks to convergence with an
adversarial subagent**, open a `ready-to-merge` PR through the canonical producer, `prepare-release` the hold —
then **EXIT WITHOUT MERGING**. The resident drain daemon lands it; the now-prepared decision is PRESENTED for
ratification on a later conveyor tick. You do **not** claim, build, or **resolve** the item — a prepared decision
is **still open** (the call hasn't been made). `resolve` is the *ratify* turn's job, never prepare's.

## The arc — one command per transition

### 1. Acquire a lane-pool clone (never edit the primary checkout)

> **You started in a scratch directory, not a checkout.** It holds nothing of `scripts/` — never write a file
> there by a relative path, and never write ANYTHING into `{{WE_ROOT}}` itself (the checkout that dispatched
> you): either one left dirty by a stray write is how a dispatcher's own clone gets stuck refusing every future
> dispatch as stale (#4174). Everything you do belongs in `$LANE`, from the moment it exists.

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --lane={{LANE}} --purpose=conveyor-prepare-decision \
  --session={{SESSION_SLUG}} --scope=we:{{ITEM_SPEC_PATH}},we:src/_data/researchTopics.json,we:src/_includes/research-descriptions/) && cd "$LANE"
```

- `--lane={{LANE}}` takes the exact lane the skill assigned. If it lost its race to a sibling, `acquire` fails
  loud — report it and exit; the skill re-dispatches.
- `--scope=…` declares this lane's file-scope: the one decision's item file plus the `/research/` topic files a
  prepare authors (`researchTopics.json` + `research-descriptions/`). All work happens in `$LANE`, never the
  primary. Prepare is **parallel-safe** with builds and other prepares — its scope is a decision's own body + a
  new research topic, disjoint by construction from any builder's code scope. (If the prepare needs a rendered
  mockup — a fork about a visual surface — it also writes `we:src/assets/<slug>/`; the coarse scope above already
  reads as a distinct, non-code area.)

### 2. Prepare-hold the decision (a hard local lock), then do the `/prepare` work in the lane

```bash
node scripts/backlog.mjs prepare-hold {{ITEM_NUM}} --session={{SESSION_SLUG}}
```

`prepare-hold` is a HARD local hold (#2219/#2264): `--select` skips it and `claim` refuses it until you
`prepare-release`, so a concurrent session can't select or steal the fork you're researching. It writes **no**
frontmatter to primary — the item stays `open`; the hold is a local, lease-bearing token. Proceed to the prepare
work in the SAME run.

> **This paragraph used to carry a "the CLI may print ⏸ stop here / rename the chat — you MUST ignore it"
> workaround.** It is gone because the cause is fixed (#xd0hvsg): the stop is now opt-in via
> `--stop-for-rename`, which only `we:skills-src/next-backlog-item/SKILL.md` passes, so no background or
> directed caller is told to stall for a hand-off that cannot come. Telling an agent in prose to disobey its
> tool's output was always the weaker fix — it works only where someone remembered to write it.

Then run the **full `/prepare` method** (the `prepare-decision-item` skill) in your lane clone:

- **Read `{{ITEM_SPEC_PATH}}` in full**, then run the documented passes IN ORDER: the **standing test** (is each
  concern even a fork?) → **prior-art research** (survey browser standards + the benchmark libraries; publish a
  `/research/` topic) → **per-fork classification** (the fixed 7-question sequence) → **author the prepared-fork
  shape** (options + tradeoffs + a bold default, each `## Fork N` opened with its fork-existence justification,
  pinned to real `file:line` refs, with a code example for any code-shape fork) → **skeptic pass** (attack every
  default now, fold the findings in, leave a `Skeptic:` line) → **two-confusion screen** (a fresh-context agent
  answers the impl-detail / prioritization-in-disguise questions per fork; leave a `Screen:` line).
- Edit the decision **on disk** (the item body + the `/research/` topic), not just in chat — the durable output
  is the rewritten body, not a message. Keep `## Progress` synced if the item has one.

### 3. Stamp `preparedDate` — in the lane

Once every fork is genuinely at DoR (named options, tradeoffs, a bold default, a `Skeptic:` line, a `Screen:`
line, and a code example for any code-shape fork — the `/prepare` close-out gate), stamp it **in the lane**:

```bash
node scripts/backlog.mjs prepare-stamp {{ITEM_NUM}}
```

`prepare-stamp` writes `status: open` + `preparedDate: <today>` into the lane's item file — the one flag that
makes readiness rank it `✓ ready to ratify`, so stamping a half-prepared item is a false "ready" the next ratify
turn will trust. It is blocked from a primary cwd and allowed in the lane, so this splice lands via the one PR,
never onto primary — do **not** hand-Edit `preparedDate`. **Do NOT `resolve`** — a prepared decision is still
open; resolving is the ratify turn's job.

### 4. Run the gate GREEN

```bash
npm run check:standards
```

The gate enforces the item shape and that the new `/research/` topic renders (the `researchTopics.json` entry +
the `.njk` write-up parse). A red gate is a hard stop — fix the authoring (usually a malformed research topic or
a fork missing its required lines) until it is green. Confirm a `relatedReport` link exists.

### 5. Review your prepared forks — spawn an adversarial review subagent (converge BEFORE the PR)

A green gate proves the item's **shape** is valid; it does **not** prove the **forks are right** — that the
research is real (not a shallow confirmation), each fork genuinely exists (a nameable excluded branch), the
default survives a red-team, and no live choice is left as prose outside a `## Fork N`. That is judgment a script
cannot do (the gate is the deterministic core, this review is the judgment, per
[we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)).
**This step is the operator invariant (#2629): NO PR reaches a human review gate without an automated AI-reviewer
convergence pass first.** Spawn **one adversarial review subagent** on your prepared item + its `/research/`
topic, and **AWAIT its completion — its final report (return value) IS the verdict.** The harness delivers a
spawned subagent's final report to its spawner automatically; read the verdict off that returned report.

- **Read-only, decision-focused.** It reviews the prepared forks against `{{ITEM_SPEC_PATH}}`'s decision: is the
  prior-art survey real and cited; does each `## Fork N` carry its fork-existence justification, options,
  tradeoffs, a bold default grounded in the real tree, a `Skeptic:` line, and a `Screen:` line; is any live
  choice left loose outside a fork; is the `preparedDate` honestly earned? It reports findings; it does not edit.
- **The verdict rides the RETURN, never a name-addressed message.** Instruct the review subagent to put its FULL
  verdict in its **final report/return**, NOT to `SendMessage` it by name — a name can be unreachable once an
  agent completes, which would stall the converge-before-PR handshake (#2624).
- **Address every finding to CONVERGENCE — don't rubber-stamp, don't silently drop.** Fix a real gap in the item
  body / research topic (re-stamp if you changed a fork's shape). A finding you judge not-real is **dismissed
  with a one-line reason**. Re-run the review after any nontrivial change, until a pass comes back clean (or with
  only dismissed-with-reason findings). If a fork is genuinely un-preparable (the decision is too vague to
  research honestly, or turns on human judgment no research resolves), escalate per *Escalations* rather than
  stamp a false "ready".
- **Classify each finding and cap the rounds.** Apply `we:agent-memory-src/story-preparation-checklist.md` items
  11–13 here too: each finding is BLOCKER (breaks a stated must, or real harm) / SCOPE-GROWTH (valid but beyond
  the minimum — file it as an already-designed follow-up) / NOT-AN-ISSUE (dismissed with a reason); an
  unclassifiable finding counts as BLOCKER; at most 2 review rounds, then stamp if no BLOCKER remains
  (a BLOCKER still open after round 2 means no stamp: escalate per *Escalations*, no third round).

### 6. Commit on the lane's current branch + publish HEAD to the `lane/...` ref + open the PR

Commit **only** this decision's files (the item file + its `/research/` topic files; explicit paths, never
`git add -A`; one commit) on the lane's **current branch** (its local `main`) — do **NOT** `git checkout -b
lane/...`; the single-branch hook blocks branch creation even inside a lane clone. `pr-land` **publishes HEAD**
to the `lane/...` ref for you via `--ref=... --sha=HEAD`. Open the PR through the canonical producer — **never a
hand-rolled `gh pr create`**:

```bash
# Write the commit message to a file, then commit -F it (a heredoc runs backticks
# like `## Fork N` as a subshell — a message file has no such footgun).
printf '%s\n' "WE #{{ITEM_NUM}}: prepare decision forks for #{{ITEM_NUM}}" "" \
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > <msgfile>
git commit -F <msgfile> {{ITEM_SPEC_PATH}} src/_data/researchTopics.json src/_includes/research-descriptions/

node scripts/operations/run.mjs open-pr --ref=lane/{{ITEM_NUM}}-prepare-<slug> --sha=HEAD --base=main \
  --bodyFile=<pr-body> --mode=label-on-green --json
```

`--mode=label-on-green` opens the self-approved PR, waits for the required `test` check, applies `ready-to-merge`
**only when green, then STOPS** (the resident drain lands it). This is the **default and expected** outcome: a
prepare PR is bounded (one decision + its research topic) and **auto-lands with no human in the loop** — the
prepared forks are PRESENTED (and ratified) later. There is **no review escalation** for a prepare PR unless the
decision itself is **statute-touching** (`pr-land`'s deterministic rubric, #2307, parks it `review:human` on its
own — you do nothing extra). Do **not** blanket-park a prepare PR.

`open-pr --mode=label-on-green` BLOCKS until `test` is green (often several minutes). Run it BACKGROUNDED (or with a
generous timeout) — a foreground call may hit the tool timeout mid-wait, which is EXPECTED and harmless: the PR
is already open (`checking`), and re-invoking `open-pr` with the SAME `--ref` is idempotent.

- End the commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

### 7. Release the hold, (optionally) drop one learnings entry, then EXIT — do not merge, do not release the lane

Once the PR is open/landing, drop the prepare-hold so the item is claimable again:

```bash
node scripts/backlog.mjs prepare-release {{ITEM_NUM}} --session={{SESSION_SLUG}}
```

If preparing this decision surfaced a generalizable lesson (a friction, a missing convention, a doc/skill gap),
append **one** structured entry via the write-gated drop-box (no code / paths / repo names — the schema rejects
them):

```bash
node scripts/conveyor/learnings-drop.mjs \
  --kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --summary="<one sentence — the lesson>" --area="<coarse label, e.g. decision prepare>" \
  --suggestion="<short recommendation>" --session={{SESSION_SLUG}}
```

`--summary` is capped at 240 chars — keep it to one tight sentence.

Then **STOP.** Do NOT run `gh pr merge`. Do NOT run a drain. Do NOT `release` the **lane** — the resident drain
daemon lands the PR, and when it does the decision is prepared, so the conveyor PRESENTS it for ratify on a later
tick. (`prepare-release` above drops the item HOLD, not the lane.) Return a one-line result to the conveyor:
`#{{ITEM_NUM}} prepare → PR #<n> (ready-to-merge | escalated <label> | gate-red | could-not-prepare)`. A red gate
/ red CI is NOT watcher-visible, so your one-line RETURN is the only signal for it — always report it explicitly.

---

## Escalations — when you do NOT reach ready-to-merge

Escalation is **by good reason only** — a prepare PR normally auto-lands. Escalate ONLY when:

1. **Cannot prepare honestly** — the decision is too vague / under-specified to research and shape into forks
   with a defensible default (a readiness gap, not a prepare gap), OR a fork turns on human judgment no research
   resolves. Do **not** stamp a false `preparedDate` and do **not** hand back a raw question dressed as a fork.
   Leave the item un-stamped, open **no** PR, drop the hold (`prepare-release`), and return `#{{ITEM_NUM}}
   prepare → could-not-prepare — needs readiness shaping` so the operator shapes it.
2. **Gate red** — `check:standards` fails from your authoring and you cannot get it green (a malformed research
   topic, a fork missing a required line). Report the failing check and stop; do not weaken a test to go green.
3. **Statute-touching decision** — if the decision is statute-touching, `pr-land`'s rubric parks it
   `review:human` on its own. Let it — do not try to clear it yourself. **You still run the step-5 review first**
   (#2629): even a parked prepare PR reaches the human only *after* an AI convergence pass.
4. **A review finding you cannot self-clear** — the step-5 review surfaced an issue you fixed what you could of,
   but one needs a human call. Either return `could-not-prepare` (case 1) if the decision can't be honestly
   prepared, or open the PR parked `review:human` (`--park=review:human`) — never let a prepare PR auto-land
   with an unresolved review finding or a half-earned `preparedDate`.

## Guardrails (the non-negotiables)

- **Prepare, never ratify.** You bring the forks to "ready to ratify" and stamp `preparedDate`; the human makes
  the call later (MEMORY #39 — *never take an unprepared decision*). **Never `resolve`** — a prepared decision is
  still open.
- **Never edit the primary checkout** — all work is in the acquired lane clone (#104/#2183); `prepare-hold` /
  `prepare-stamp` / `prepare-release` all splice in the lane, never onto primary.
- **Never merge** — you stop at `ready-to-merge`; the resident drain daemon is the sole writer to `main`.
- **Never hand-roll `gh pr create`** — route through `pr-land` so the #2307 producer review-label applies at open.
- **Never stamp a half-prepared decision** — a fork with no `Skeptic:`/`Screen:` line, a bare "needs a human
  call" / "TBD", or a live choice loose in prose is un-prepared; shape it or escalate `could-not-prepare`.
