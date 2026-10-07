# Conveyor prepare-item agent brief (template) — full prepare pass on ONE story/task, stop at ready-to-merge (#4504)

> **This is a TEMPLATE, not a runnable skill.** The `/conveyor` skill instantiates it — filling the
> `{{PLACEHOLDERS}}` below — and passes the result as the prompt for **one background prepare-item agent** it
> spawns per **scoped, unprepared** story/task the dispatcher is holding `needs-prepare` (#4470: a scoped
> story/task with no truthful `preparedDate` is never dispatched to build). One agent = one item = one lane = one
> PR that brings the item to "ready to build". This is distinct from the narrower **prepare-scope** agent
> (`we:skills-src/conveyor/prepare-scope-agent-brief.md`), which only authors a missing `scope:` field — a
> single-field mechanical edit. You do the FULL prepare pass: premise check, scope correction, and authoring
> `## Design` / `## MVP` / `## Test plan` / `## Proof plan` / `## Follow-ups`, then `prepare-stamp`. You do the
> prepare; you never build and never resolve.

## Why this exists (the one-paragraph frame)

The deterministic dispatcher (`we:scripts/readiness/dispatch-plan.mjs`) never dispatches a scoped story/task to
build unless it carries a truthful `preparedDate` — an unprepared one is held `needs-prepare` (#4470). Before
this brief existed, that hold had no route out: the item just sat stuck, because #4470's own MVP deliberately
stopped at the gate. **You are the route out, run just-in-time:** you do the autonomous half of "PREPARE FIRST"
— the premise check against current `main`, the scope correction, the Design/MVP/Test-plan/Proof-plan/Follow-ups
authoring — and stamp `preparedDate`, so on a later tick the now-prepared item is dispatched to BUILD normally.
This is **pure agent work — no human judgment yet**; a genuine product/policy call you find along the way is a
reason to escalate, never to guess. You do the JUDGMENT (read the item + the code it touches, write the plan);
every script-decidable step around it is a script you shell, per
[we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment).

## The method — premise check, scope check, then author the five sections

There is no separate skill for this yet (unlike decision-prepare, which delegates to
`we:skills-src/prepare-decision-item/SKILL.md`) — the method is stated here, and if it changes, edit this brief.

1. **Premise check against current `main`.** Read the code and every cited `file:line`, and check
   `git log` for `{{ITEM_NUM}}` or its `bornAs` hash. If the goal is already delivered, report
   `already-done` with the delivering commit, release the hold, and stop without editing, stamping,
   resolving, or opening a PR. A moved implementation or stale citation alone does not mean the goal
   is false or delivered.
2. **Correct factual drift** in the card itself: moved code, stale `file:line` citations, missing test
   paths, and narrower or wider `scope:` supported by the current code. Preserve the original goal
   and all other frontmatter except `size:` and the preparation stamps. You may change `size:` when file:line evidence grounds it (state old/new/evidence in `## Progress`). Never edit `blockedBy:`; propose edge changes in a `## Proposed blockedBy changes` section (`- add NNN — reason (we:path:line)` / `- remove NNN — …`), which an independent second actor (the PR reviewer, never you) must confirm; an add may never target a resolved card or create a cycle (ruling #4670). Record the old premise/scope, corrected
   premise/scope, and source evidence in `## Progress`, then continue the prepare pass. Scope breadth
   alone is not a stop reason. If a genuine unresolved judgment call / design fork remains after
   research (including changing the goal), report `could-not-prepare` with the specific choice;
   do not invent a goal or choose policy. See *Escalations* #1.
3. **Author the prepare into the item body**, each a short, concrete section — never a placeholder or a restated
   title:
   - `## Design` — the mechanism, in prose, grounded in real `file:line` references to the code the item touches.
   - `## MVP` — the explicit cut: **Musts only**. Name what is deliberately OUT of scope too (goes in Follow-ups).
   - `## Test plan` — each case named with what it asserts and why it fails RED before the fix.
   - `## Proof plan` — how the fix will be shown working live (a before/after on a real surface, a dry-run, a
     CLI probe), not just "tests pass".
   - `## Follow-ups` — anything beyond the MVP cut, each nameable as a future backlog item (do not file them
     yourself here — that is the eventual BUILDER's job, per the standard delivery-agent brief's step 4).
4. **Stamp `preparedDate`** (step 3 below) once every section above genuinely holds — a prepare pass that is
   thin, generic, or copy-pasted from the item's own summary is not done; keep working it or escalate
   *could-not-prepare* (*Escalations* #1) rather than stamp a false "ready".

## Fill these before spawning

| Placeholder | What the conveyor fills it with |
|---|---|
| `{{ITEM_NUM}}` | the backlog item number (or `xNNNNNN` hash) of the held `needs-prepare` story/task — e.g. `4491` |
| `{{ITEM_SPEC_PATH}}` | the item's backlog file — `backlog/{{ITEM_NUM}}-<slug>.md` |
| `{{LANE}}` | the free lane id the skill assigned this prepare (from the free-lane set) — e.g. `4` |
| `{{SESSION_SLUG}}` | the per-item prepare session slug — `prepare-item-{{ITEM_NUM}}` (ties `acquire`↔`release`, `prepare-hold`↔`prepare-release`) |
| `{{WE_ROOT}}` | the absolute WE checkout you are dispatched FROM. You start in a scratch directory outside it (never inside it — see step 1), so this is the only way step 1's `lane-pool.mjs` is findable before you have a lane of your own. |

> **Two kinds of placeholder.** `{{LIKE_THIS}}` are **conveyor-injected** — the skill substitutes them before
> spawning you (the table above). `<like-this>` are **agent-runtime values** you produce as you work — the
> `<slug>` in the lane ref, the `<pr-body>` file you write, the `<n>`/PR number `pr-land` reports back.

---

## Your job (one sentence)

In an isolated lane clone, **bring story/task #{{ITEM_NUM}} to "ready to build"** by running the premise check +
scope check + authoring the five prepare sections above, `prepare-stamp` its `preparedDate` **in the lane**, get
the gate green, **review your prepare pass to convergence with an adversarial subagent**, open a `ready-to-merge`
PR through the canonical producer, `prepare-release` the hold — then **EXIT WITHOUT MERGING**. The resident drain
daemon lands it; the now-prepared item is dispatched to BUILD normally on a later conveyor tick. You do **not**
claim, build, or **resolve** the item — a prepared story/task is **still open** (the work hasn't started).
`resolve` is the eventual BUILD delivery agent's job, never prepare's.

## The arc — one command per transition

### 1. Acquire a lane-pool clone (never edit the primary checkout)

> **You started in a scratch directory, not a checkout.** It holds nothing of `scripts/` — never write a file
> there by a relative path, and never write ANYTHING into `{{WE_ROOT}}` itself (the checkout that dispatched
> you): either one left dirty by a stray write is how a dispatcher's own clone gets stuck refusing every future
> dispatch as stale (#4174). Everything you do belongs in `$LANE`, from the moment it exists.

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --lane={{LANE}} --purpose=conveyor-prepare-item --base=origin/main \
  --session={{SESSION_SLUG}} --scope=we:{{ITEM_SPEC_PATH}}) && cd "$LANE"
```

- `--lane={{LANE}}` takes the exact lane the skill assigned. If it lost its race to a sibling, `acquire` fails
  loud — report it and exit; the skill re-dispatches.
- `--scope=…` declares this lane's file-scope: the one item's body. Prepare is **parallel-safe** with builds and
  other prepares — its scope is a single item's body, disjoint by construction from any builder's code scope.

The acquired lane must be fresh from fetched `origin/main`: verify
`git rev-parse HEAD` equals `git rev-parse origin/main` before editing. If unequal, stop and report it.
Never use `--no-reset`, base on a predecessor lane, or merge another lane into this prepare.
If another lane has needed work, wait for it to land and acquire a fresh lane from `origin/main`.

### 2. Prepare-hold the item (a hard local lock), then run the method in the lane

```bash
node scripts/backlog.mjs prepare-hold {{ITEM_NUM}} --session={{SESSION_SLUG}}
```

`prepare-hold` is a HARD local hold (#2219/#2264): `--select` skips it and `claim` refuses it until you
`prepare-release`, so a concurrent session can't select or steal the item you're preparing. It writes **no**
frontmatter to primary — the item stays `open`; the hold is a local, lease-bearing token. Proceed to the method
in the SAME run: read `{{ITEM_SPEC_PATH}}` in full, do the premise check and the scope check, then author the
five sections directly into the item body **on disk** (not just in chat). Keep `## Progress` synced if the item
has one.

### 3. Stamp `preparedDate` — in the lane

Once every section genuinely holds (see *The method*, step 4), stamp it **in the lane**:

```bash
node scripts/backlog.mjs prepare-stamp {{ITEM_NUM}}
```

`prepare-stamp` writes `status: open` + `preparedDate: <today>` into the lane's item file — the one flag that
clears `needs-prepare` and makes the item build-eligible again. It is blocked from a primary cwd and allowed in
the lane, so this splice lands via the one PR, never onto primary — do **not** hand-Edit `preparedDate`. **Do
NOT `resolve`** — a prepared item is still open; resolving is the eventual build agent's job.

Before proceeding, read `{{ITEM_SPEC_PATH}}` back from disk and verify its YAML frontmatter contains a
non-empty `preparedDate`. This is mandatory: authored sections alone are not a prepared result. If
`prepare-stamp` fails or the field is absent, stop with `prepare-unstamped`; do not publish a prepare PR.
Recheck the committed card at `HEAD:{{ITEM_SPEC_PATH}}` before `open-pr`, so the stamp is in the PR itself.
The daemon independently checks completed results on main and the attempt's open PR. If Design, MVP,
Test plan and Proof plan are present with content but the stamp is absent, it runs the sanctioned
`prepare-stamp` in an acquired lane and submits the change through `open-pr --mode=label-on-green`.
This mechanical recovery uses `prepare-stamp-pending`; it does not occupy an agent prepare slot.
Only missing sections retain `prepare-unstamped`. Both holds exclude only their own card before planning.
The Codex probation route already delegates stamping and committed-stamp verification to its runner.

### 4. Run the gate GREEN

Commit the card FIRST (the one commit — see step 6 for why it is explicit-path, on the lane's current branch),
then request the gate: the marker is keyed to HEAD, so a request made against the uncommitted tree is stale the
moment the commit moves HEAD and `open-pr`'s finish-guard refuses it.

```bash
printf '%s\n' "WE #{{ITEM_NUM}}: prepare — <short card title>" "" \
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > <msgfile>
git commit -F <msgfile> {{ITEM_SPEC_PATH}}

node scripts/verify-lane.mjs request --repo=.
node {{WE_ROOT}}/scripts/conveyor/await-verify.mjs mark --who={{SESSION_SLUG}} --item={{ITEM_NUM}} --ref=lane/{{ITEM_NUM}}-prepare-item-<slug> --kind=prepare --attempt=1
```

**The harness owns the wait, not you (#5137).** After `mark`, **end your turn**: reply with one line
(`awaiting verify for <sha>`) and stop. Never `check --wait`, never `sleep`, never `run_in_background`, never
`reset` or re-`request` yourself. The fix daemon resumes THIS session with a message that starts
`[harness verify verdict — #5137]`: `green` → continue at step 5; `red` → repair the card, commit (or amend), `request`,
`mark` again with `--attempt=<n+1>` and end your turn (the third red is a hard stop); no verdict → the harness
re-requests on its own and then tells you to report blocked-on-infra. Nothing is pushed for you.

This is the ONLY gate run for a card-only prepare. On a `backlog/`-only diff the gate takes its light path
(no Vitest, but an UNSCOPED `check:standards` — a `backlog/` path always keeps the whole-repo run, so expect it
to take longer than a scoped one) and stamps the marker `open-pr` requires. Do NOT also run
`npm run check:standards`, and do NOT run `verify-lane` again after `open-pr` (CI runs the light card-only
suite itself). Never pass `--help`/`-h` expecting a dry run: it prints usage only.

If step 5's review makes you change the card, fold the change into that same commit
(`git commit --amend --no-edit {{ITEM_SPEC_PATH}}`), `request` and `mark` once more (and end your turn again): the amended commit is a new HEAD,
so that is the gate for the HEAD you will open, not a second run of the same one.

The gate checks item shape; it does not replace the explicit `preparedDate` check above. A red gate is a
hard stop — fix the authoring until it is green.

### 5. Review your prepare pass — spawn an adversarial review subagent (converge BEFORE the PR)

A green gate proves the item's **shape** is valid; it does **not** prove the **prepare is right** — that the
premise check is real (not a rubber stamp), the scope is accurate, the MVP cut is genuinely Musts-only, each test
case would fail for the stated reason, and the proof plan is concrete rather than "tests pass". That is judgment
a script cannot do. **This step is the operator invariant: NO PR reaches a human review gate without an automated
AI-reviewer convergence pass first.** Spawn **one adversarial review subagent** on your prepared item, and
**AWAIT its completion — its final report (return value) IS the verdict.**

- **Read-only, prepare-focused.** It reviews the five sections against `{{ITEM_SPEC_PATH}}`'s own text and the
  real code the item names: is the premise check genuine; is the scope plausible; is the MVP cut Musts-only with
  real Follow-ups named; would each test case actually fail red before the fix; is the proof plan concrete. It
  reports findings; it does not edit.
- **The verdict rides the RETURN, never a name-addressed message.**
- **Address every finding to CONVERGENCE.** Fix a real gap; dismiss a not-real one with a one-line reason.
  Re-run after any nontrivial change. If the item is genuinely un-preparable, escalate (*Escalations* #1) rather
  than stamp a false "ready".

### 6. Commit on the lane's current branch + publish HEAD to the `lane/...` ref + open the PR

The commit is already made (step 4 — only this item's file, explicit path, never `git add -A`, one commit, on the
lane's **current branch**, its local `main`; do **NOT** `git checkout -b lane/...`). `pr-land` **publishes HEAD**
to the `lane/...` ref for you via `--ref=... --sha=HEAD`. Open the PR through the canonical producer — **never a
hand-rolled `gh pr create`**:

```bash
node scripts/operations/run.mjs open-pr --ref=lane/{{ITEM_NUM}}-prepare-item-<slug> --sha=HEAD --base=main \
  --title="WE #{{ITEM_NUM}}: prepare — <short card title>" \
  --bodyFile=<pr-body> --mode=label-on-green --json
```

The producer checks the full PR diff against `origin/main` before any publication. Any file other than
`{{ITEM_SPEC_PATH}}`, including another card, refuses the PR with the offending paths. A merge commit
in the lane also refuses publication. Stop on refusal; reacquire fresh and reapply only this card.
Use the card’s actual title as the subject, capped to about 70 characters including the stable prefix. Publication re-reads the card title.

`--mode=label-on-green` opens the self-approved PR, waits for the required `test` check, applies `ready-to-merge`
**only when green, then STOPS** (the resident drain lands it). This is the **default and expected** outcome: a
prepare PR is bounded (one item's own body) and **auto-lands with no human in the loop**. There is **no review
escalation** for a prepare PR unless the item itself is **statute-touching** (`pr-land`'s deterministic rubric
parks it `review:human` on its own — you do nothing extra). Do **not** blanket-park a prepare PR.

`open-pr --mode=label-on-green` BLOCKS until `test` is green (often several minutes). Run it BACKGROUNDED (or
with a generous timeout) — a foreground call may hit the tool timeout mid-wait, which is EXPECTED and harmless:
the PR is already open (`checking`), and re-invoking `open-pr` with the SAME `--ref` is idempotent.

- End the commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

### 7. Release the hold, (optionally) drop one learnings entry, then EXIT — do not merge, do not release the lane

```bash
node scripts/backlog.mjs prepare-release {{ITEM_NUM}} --session={{SESSION_SLUG}}
```

If preparing this item surfaced a generalizable lesson, append **one** structured entry via the write-gated
drop-box (no code / paths / repo names — the schema rejects them):

```bash
node scripts/conveyor/learnings-drop.mjs \
  --kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --summary="<one sentence — the lesson>" --area="<coarse label, e.g. item prepare>" \
  --suggestion="<short recommendation>" --session={{SESSION_SLUG}}
```

Then **STOP.** Do NOT run `gh pr merge`. Do NOT run a drain. Do NOT `release` the **lane** — the resident drain
daemon lands the PR, and when it does the item is prepared, so the conveyor dispatches it to BUILD on a later
tick. Return a one-line result: `#{{ITEM_NUM}} prepare-item → PR #<n> (ready-to-merge | escalated <label> |
gate-red | could-not-prepare)`, or, for the `already-done` exit (*The method*, step 1, no PR opened),
`#{{ITEM_NUM}} prepare-item → already-done — <delivering commit>`.

---

## Escalations — when you do NOT reach ready-to-merge

1. **Cannot prepare honestly** — a genuine unresolved judgment call / design fork remains after
   research, including an ambiguity that requires choosing a different goal. Factual drift alone is
   corrected in place (*The method*, step 2), not escalated. Do **not** stamp a false `preparedDate`. Leave the item un-stamped, open **no** PR, drop
   the hold (`prepare-release`), and return `#{{ITEM_NUM}} prepare-item → could-not-prepare — <reason>`.
1a. **Already delivered** — *The method*, step 1: return `#{{ITEM_NUM}} prepare-item → already-done — <delivering
   commit>`, release the hold, edit and stamp nothing, open no PR.
2. **Gate red** — `check:standards` fails from your authoring and you cannot get it green. Report the failing
   check and stop; do not weaken a test to go green.
3. **Statute-touching item** — `pr-land`'s rubric parks it `review:human` on its own. Let it — you still run the
   step-5 review first.
4. **A review finding you cannot self-clear** — return `could-not-prepare` (case 1), or open the PR parked
   `review:human` — never let a prepare PR auto-land with an unresolved review finding or a half-earned
   `preparedDate`.

## Guardrails (the non-negotiables)

- **Prepare, never build, never resolve.** Bring the item to "ready to build" and stamp `preparedDate`;
  the build lifecycle picks it up later. An already-delivered goal takes the `already-done` exit in
  *The method*, step 1, with its delivering commit; it is not another prepare pass.
- **Never edit the primary checkout** — all work is in the acquired lane clone; `prepare-hold` / `prepare-stamp` /
  `prepare-release` all splice in the lane, never onto primary.
- **Never merge** — you stop at `ready-to-merge`; the resident drain daemon is the sole writer to `main`.
- **Never hand-roll `gh pr create`** — route through `pr-land` so the producer review-label applies at open.
- **Never stamp a half-prepared item** — a thin or generic Design/MVP/Test-plan/Proof-plan, or a Follow-ups
  section that quietly hides a Must, is un-prepared; shape it or escalate `could-not-prepare`.

