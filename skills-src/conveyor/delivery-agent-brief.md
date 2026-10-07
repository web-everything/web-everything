# Conveyor delivery-agent brief (template) — build ONE item, stop at ready-to-merge (#2608)

> **This is a TEMPLATE, not a runnable skill.** The `/conveyor` skill (#2613) instantiates it — filling the
> `{{PLACEHOLDERS}}` below with the launch entry the dispatch-plan script (#2609) produced — and passes the
> result as the prompt for **one background delivery agent** spawned per launch entry. One agent = one item =
> one lane = one PR. The agent does the JUDGMENT work (build the item); every script-decidable decision around
> it is a script it shells, per
> [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)
> (#2607).

## Fill these before spawning

| Placeholder | What the conveyor fills it with |
|---|---|
| `{{ITEM_NUM}}` | the backlog item number (or `xNNNNNN` hash) from the launch entry — e.g. `2608`. **Never substitute any other number here** (a PR number, an issue you noticed in passing, a guess) — the drain's resolve-on-land bookkeeping reads this exact leading digit run off the branch name as a claim that this PR delivers that card, and a mismatched number wrongly resolves an unrelated card on merge (incident 2026-09-26 03:14Z, #2779: a hand-run `/pr` outside this brief named its branch after an open PR number instead of a card and did exactly this). |
| `{{ITEM_SPEC_PATH}}` | the item's backlog file — `backlog/{{ITEM_NUM}}-<slug>.md` |
| `{{LANE}}` | the free lane id the dispatch plan assigned this launch (`launch[].lane`) — e.g. `4` |
| `{{SESSION_SLUG}}` | a stable per-item session slug, e.g. `conveyor-{{ITEM_NUM}}` (ties `acquire`↔`release`, `claim`↔`resolve`) |
| `{{SCOPE}}` | the item's predicted `scope:` frontmatter, repo-qualified & comma-joined — e.g. `we:scripts/conveyor,we:.claude/skills/conveyor` |
| `{{ATTEMPT_TAG}}` | **#3110** — empty on a first attempt, a letter (`b`, `c`, …) on a retry of this same item. Fold it in EXACTLY where step 8 shows, right after `{{ITEM_NUM}}` in the branch name — this is what lets the observer tell your attempt's PR apart from a sibling retry's. Never invent your own retry marker in its place. |
| `{{DELIVERY_BASE}}` | **#3637** — the branch this item forks from and lands on. `main` for almost everything (then every step below is exactly as written). A **registered POC branch** (e.g. `lane/mechanical-dispatcher`) when the item's `deliveryTarget:` names one — and then step 8 changes: **no PR at all**, see *“If `{{DELIVERY_BASE}}` is not `main`”* there. |
| `{{WE_ROOT}}` | **#4174** — the absolute WE checkout you are dispatched FROM. You start in a scratch directory outside it (never inside it — see step 1), so this is the only way step 1's `lane-pool.mjs` is findable before you have a lane of your own. |

> **Two kinds of placeholder.** `{{LIKE_THIS}}` are **conveyor-injected** — the skill substitutes them from the
> launch entry before spawning you (the table above). `<like-this>` are **agent-runtime values** you produce as
> you work — the `<slug>` you pick for the lane ref, the `<pr-body>` file you write, the `<n>`/PR number
> `pr-land` reports back. Do not expect the conveyor to fill a `<...>`; that's your job at the moment it's used.

---

## Your job (one sentence)

Build backlog item **#{{ITEM_NUM}}** to spec in an isolated lane clone, get its gate green, **review your own
diff to convergence with an adversarial subagent**, resolve the card in the lane and commit it with the work (the
claim and the resolve ride the PR — step 8), open a PR (`ready-to-merge`, or parked `review:human`
**only for good reason**), drop a learnings entry — then **EXIT WITHOUT MERGING**. The resident drain daemon
(`plateau:tools/drain-daemon/`) is the single landing serializer; it lands green couples and parks escalations
`review:human` for the main session. You never run `gh pr merge`.

## The arc — one command per transition

### 1. Acquire a lane-pool clone (never edit the primary checkout)

> **You started in a scratch directory, not a checkout.** It holds nothing of `scripts/` — never write a file
> there by a relative path, and never write ANYTHING into `{{WE_ROOT}}` itself (the checkout that dispatched
> you): either one left dirty by a stray write is how a dispatcher's own clone gets stuck refusing every future
> dispatch as stale (#4174). Everything you do belongs in `$LANE`, from the moment it exists.

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --lane={{LANE}} --purpose=conveyor-delivery \
  --session={{SESSION_SLUG}} --scope={{SCOPE}} --item={{ITEM_NUM}} --base={{DELIVERY_BASE}} --adopt) && cd "$LANE"
```

- `--adopt` stamps YOU (the process running this acquire) as the lane's declared occupant
  (`workerSession`) — you are self-acquiring and self-editing in the same run, the exact topology
  `--adopt` was built for, so `we:scripts/guard-lane.mjs`'s `Edit`/`Write` refusal is armed against every
  OTHER session from the moment you acquire (#2997 r2 / #3107). It degrades to a no-op when
  `CLAUDE_CODE_SESSION_ID` is absent from your env (`workerSession` stays null, matching today's
  unchanged fail-open behavior) — nothing else to do here.

- `--lane={{LANE}}` takes the exact lane the dispatch plan assigned (it was in the free-lane set at plan time).
  If that lane lost its race to a sibling, `acquire` fails loud — report it and exit; the conveyor re-plans.
- `--scope={{SCOPE}}` declares this lane's predicted file-scope into the lease marker. It is **advisory** — it
  NEVER gates the acquire (the whole-clone lease is the real lock), but the scope-lease collector reads it so
  the dispatch plan won't launch an overlapping sibling. All work happens in `$LANE`, never the primary.
- `--base={{DELIVERY_BASE}}` (#3637) forks the lane from the branch this item delivers to. It is `main` for
  almost every item, which is exactly what `acquire` already did before this flag was passed — so nothing
  changes for a normal build. When it names a POC branch, the lane's CONTENT comes from that branch while its
  local branch is still *named* `main` (`acquire` does `checkout -B main <baseRef>`), so never infer your
  target from the local branch name — it is `{{DELIVERY_BASE}}`, full stop. The base is persisted into the
  lease marker, so it survives the acquire.
- `--item={{ITEM_NUM}}` records **this lane → this item** into the primary checkout's lane-ports registry
  (`we:.claude/lane-ports.json`), the SAME map `conveyor-state.mjs`'s health-stall scan reverse-derives lane→num
  from (#2616). A delivery agent leases its OWN lane and claims its OWN item, so nothing else maps it — without
  this flag the registry stays `{}`, no lane carries a num, and `assessHealth` is permanently `ok` (a stalled
  lane never alarms). It runs at acquire time in the primary checkout (not the lane clone), so the main-session
  tick reads it; the entry is cleared when the lane is next reset/recycled. Advisory — a write hiccup never fails
  the acquire.

### 2. Claim the item (the claim rides the PR — never left `active` on main)

```bash
node scripts/backlog.mjs claim {{ITEM_NUM}} --session={{SESSION_SLUG}}
```

Claim flips `open → active` + stamps `dateStarted` **in the lane clone**. (You are a background agent — do the
claim, the readiness pre-check, and the build in the same run; the two-turn human arc does not apply here.)
**The `claim` CLI prints a two-turn "⏸ stop here / let the chat be renamed" message meant for INTERACTIVE human
sessions — you MUST ignore it and proceed to the readiness pre-check + build in the SAME run** (as this brief's
arc directs). Obeying it literally would STALL a background delivery agent.
**Before writing any code, run the readiness pre-check (step 3)** — that step owns the full re-read of
`{{ITEM_SPEC_PATH}}` and the `blockedBy` re-check.

### 3. Readiness pre-check — is this card still worth building? (a LIGHT gate, not a deep analysis)

State drifts between when the operator cleared this item and when your lane picked it up: a blocker can
**re-open**, other work can land the **same** change, a spec can go **stale**. So **before writing any code**,
re-confirm the item is still buildable **as written, against the fresh `main` your lane just reset to**. This
enacts the **Definition-of-Ready lens** (#2618 — the durable home of what "ready" means) at *claim* time —
the same "still holds against the current tree, no reopened fork, no reappeared blocker" re-read the delegation
rule already requires, and the "re-evaluate `blockedBy` at every seam" discipline
(`we:docs/agent/backlog-workflow.md`). Keep it **proportionate**: read the item + take a quick look at `main`,
**NOT** a full audit that doubles the build cost. Check four things:

- **Still ready** — re-confirm on the fresh clone that **every `blockedBy` edge is resolved**. A blocker cleared
  at prepare time can have **re-opened** since it was queued (read each blocker's current `status:`). → reason
  `re-blocked <num>`.
- **Up to date / not stale** — a quick sanity read that the spec **still makes sense against current `main`**: it
  wasn't **already done** or **superseded** by other work that landed while it queued (the "desynced — spec
  changed under it" case). A skim, not a deep diff audit. → reason `stale/superseded`.
- **Scope sane** — the item **carries a `scope:`** and it's **plausible for the spec** (auto-prepare authored
  it; just sanity-check it matches the described work, not obviously wrong). → reason `scope-wrong`.
- **Coherent** — **buildable as written**: not a placeholder / TODO-digest stub, not internally contradictory,
  the ask clear enough to implement. → reason `incoherent`.

**PASS** — all four hold → proceed to build (step 4 onward).

**FAIL** — any check trips → **do NOT build, and do NOT try to fix the item yourself.** Release the claim
cleanly so the item returns to the pool (not stranded), hand the lane back, and RETURN the one-line escalation
naming the reason:

```bash
node scripts/backlog.mjs release {{ITEM_NUM}} --session={{SESSION_SLUG}}   # active → open — back in the pool
node scripts/lane-pool.mjs release --lane={{LANE}} --session={{SESSION_SLUG}}
```

Return: `#{{ITEM_NUM}} → not-ready (re-blocked <num> | stale/superseded | scope-wrong | incoherent)`. **This is
a GOOD reason to stop** — the *escalate-by-good-reason-only* rule cuts both ways, and a card that drifted out
from under its spec is exactly the kind of thing worth surfacing. The conveyor hands it to the operator to
**re-prepare / re-check / drop**; it **never silently builds a stale card**. No PR is opened — nothing was
built (this is the one pre-build stop; see *Escalations*).

### 4. Build it to spec

Do the actual work in `$LANE`: implement `{{ITEM_SPEC_PATH}}`, keep `## Progress` synced, capture any
leftover work as new backlog items (`scaffold` with `blockedBy` + a digest) rather than half-doing them.

- **Fixing a bug? Reproduce it before you fix it — a green gate alone is not proof.** When
  `{{ITEM_SPEC_PATH}}` describes a defect to fix (not a fresh capability to add), the same before/after
  discipline the conveyor's fix-agent brief owes a bounced PR
  ([`fix-agent-brief.md`](fix-agent-brief.md) step 2/step 4) applies here too: before changing code, reproduce
  the bug with a test that FAILS for the stated reason — show it red — and, where the bug is observable on a
  real surface (a CLI dry-run, a read-only query, a page render), probe that surface and show the same failure
  there. After the fix, the same test is green and the same probe shows the fixed behavior. Put the trimmed
  red-then-green evidence in the PR body you write at step 8 — a reviewer must be able to SEE the fix work, not
  just infer it from `check:standards` passing. If you genuinely cannot reproduce the bug, say so explicitly,
  with the reason, in that PR body — never claim "fixed" without one.
- **Fixing a live daemon break specifically?** Add its real-world case to the daemon soak harness
  (`we:scripts/conveyor/soak/breaks/`, one module + its `.soak.test.mjs`, registered in that directory's
  `index.mjs` — [`SKILL.md#daemon-soak-harness`](SKILL.md)) or add `soak-waiver: <reason>` to the PR body. This
  is now mechanically gated (`soak-replay-gate`, #4075), not just written here — the CI check goes red if
  neither is present on a PR that touches daemon-soak scope and reads as a bug fix.
  If the soak break is sizeable, it can be handed to a specialist session: see
  [`role-test-soak-author-brief.md`](role-test-soak-author-brief.md) for WHEN to request that role (until the
  request mechanism exists, write the break yourself as above).
- **Any scaffolded item must itself pass build-brief discipline** (statute:
  [we:docs/agent/platform-decisions.md#build-brief-discipline](../../../docs/agent/platform-decisions.md#build-brief-discipline),
  #2819): name the edge-cases the new item's build should handle or reject, require an
  integration/wiring test (not only a unit test), and never echo the slice title as a "closes X" claim
  the item doesn't itself close end-to-end. This is exactly the class of gap `check:readiness`'s
  spec-gap proposer (`we:scripts/readiness/proposer.mjs`) now flags — write the scaffold so it wouldn't
  flag it.
- **Prefer small, single-responsibility, decoupled files; split god-files along their seams** (statute:
  [we:docs/agent/platform-decisions.md#small-file-preference](../../../docs/agent/platform-decisions.md#small-file-preference), #2678). This is a throughput default, not tidiness: a file
  many items must touch is a single scope-lease lock that serializes all of them. When your work would grow a
  file into (or deeper into) a god-file, split it along genuine responsibility seams instead. **Cohesion
  outranks line count** — never fragment a truly single-responsibility file just to hit a number; if a large
  file is genuinely cohesive, mark it `// @cohesive: <reason>` to silence the soft-warn. `check:standards`
  only *warns* (never blocks) on the size+collision composite, so this never gates your land.

- **Build-brief discipline — apply this even when the spec above is thin** (statute:
  [we:docs/agent/platform-decisions.md#build-brief-discipline](../../../docs/agent/platform-decisions.md#build-brief-discipline),
  #2819). Where the spec says "reject/handle X" without naming X's concrete shapes, name the edge cases
  yourself before writing the check — don't ship the first narrow guess. Cover the change with an
  integration/wiring test that exercises the real call path, not only a unit test of the isolated function.
  And never echo the item's own title or slice name back as a completion claim ("closes X") in a commit or
  PR unless the diff truly closes it end-to-end — say what you actually closed instead.

**Mid-work check — a targeted sanity check while you iterate, never the full gate (#4294).** Step 5's
`verify-lane.mjs request`/`check` cycle is the only terminal, landing-eligible signal, and it runs once, after
your work is done. That does not mean you fly blind between now and then: while you are still iterating
mid-task, sanity-check the files you have actually touched so far with a **targeted, admission-queued `vitest
related` pass**, instead of guessing or reaching for the full suite:

```bash
node scripts/readiness/heavy-admission.mjs run -- npx vitest related <touched-file-1> <touched-file-2> … --run --passWithNoTests
```

**Keep `--run --passWithNoTests` on it, always.** Without `--run`, `vitest` can drop into watch mode on a TTY
shell and hang inside the admission wrapper. Without `--passWithNoTests`, a touch-set with no covering tests at
all (a doc, a config, a helper nothing tests directly) exits non-zero — a false red on a harmless case, not a
real failure. The guard enforces the `--run` half mechanically: an admitted `vitest` command without it is denied.

This is the **admitted-wrapper** shape `we:scripts/guard-bash.mjs` already sanctions for a dispatched agent — its
head is `node heavy-admission.mjs run`, never the raw `npx vitest …` head `dispatchedAgentVerificationReason`
denies (only `verify-lane.mjs request`/`check`/`reset` are the other members of that allowlist, #3105) — so,
unlike a bare `node scripts/verify-lane.mjs run`, it is **not denied** to a mechanically-dispatched agent. It
also queues through the host's heavy-admission pool rather than skipping it (#3461). See
`scripts/__tests__/guard-bash.test.mjs`'s *"the admitted wrapper form of a targeted `vitest related` is NOT
denied to a dispatched agent, any kind"* test (sibling to the pre-existing one covering the `vitest run`
spelling) for the guard's own proof of this exact shape.
`vitest related <files>` runs only the tests that actually cover the source files you list — narrower and much
faster than `verify-lane.mjs`'s own diff-driven default, appropriate for a quick mid-work loop. Run it as often
as useful while you work; it is advisory only and **never** substitutes for step 5's terminal gate, `pr-land`'s
finish-guard, or CI's `test` check — none of which it satisfies.

### 4a. Catch up with `main` once, immediately before the gate — never speculatively mid-work (#4297)

**You get exactly ONE `origin/main` touch for the whole build — never two.** A speculative mid-work catch-up
that touches none of your own files still moves local HEAD, which invalidates the exact-sha-keyed verify marker
(#4296) and forces a wasted full re-run — the exact cost a mid-work merge produced live inside the #4294
daemon-fix session (a conflict entirely outside the lane's own touch-set).

**The normal case — do it here, right before step 5's gate:**

```bash
git fetch origin main
git merge origin/main
```

Resolve any conflict the `/finish` way — regenerate derived/generated artifacts rather than hand-merging them,
take-main for coordination JSON (`claims.json`, registries). A genuine same-line code conflict you cannot
safely resolve is a hard stop: do not push through it, and report it plainly in your one-line return (step 10).

**The sole exception — you already spent your one touch earlier, mid-work, because it genuinely blocked you.**
If `origin/main` advances while you are still editing and a real, PRESENT conflict (not a hypothetical future
one) blocks the file you are actively touching — never pre-empted "in case" one might appear later — resolve it
right then, the same `/finish` way. **If that already happened, skip this step entirely when you reach it: do
NOT run the merge above a second time.** The two paths are alternatives, not additive — whichever one fires is
the build's one and only merge.

### 5. Run the gate GREEN (in the item's own locus)

A WE item's gate is `npm run check:standards`. For a cross-locus item, run **that** locus's gate
(look up `LOCI[item.locus]` in `check-standards-rules.mjs`). **The gate must be green before you push** — a red
gate is a hard stop (see *Escalations*). **Do NOT `resolve` the card here** — the card is resolved in step 8, once
the diff has converged (steps 6–7) and just before the one commit, so the flip rides the PR (see step 8):

**You cannot run the gate yourself — request it, then WAIT for it (#3105/#4358).** The gate legitimately takes
150–350s, well past this tool's ~120s foreground window: a direct run (foreground OR backgrounded) gets silently
auto-backgrounded by the tool itself, and you stall with no error — the exact #2833 shape, just reached without
ever typing `&`. This is not just guidance: a `PreToolUse(Bash)` guard (`we:scripts/guard-bash.mjs`, #3105)
**DENIES** a dispatched agent from running the verification set (`verify-lane` / `run.mjs verify` /
`check:standards` / `test:unit`) directly, in any form. The runner's own long-lived process (unbound by your
turn's window) runs the gate for you:

```bash
node scripts/verify-lane.mjs request              # returns almost instantly — nothing has run yet — @operation-home-ok: #xab3jh7 — request has no operation-level equivalent yet; folding it in is #xab3jh7
node scripts/conveyor/await-verify.mjs mark --who={{SESSION_SLUG}} --item={{ITEM_NUM}} --ref=lane/{{ITEM_NUM}}{{ATTEMPT_TAG}}-<slug> --kind=delivery --attempt=1
```

**The harness owns the wait, not you (#5137).** `mark` records that you are waiting on THIS tree; then **end your
turn**: reply with one line (`awaiting verify for <sha>`) and stop. Never `check --wait`, never `sleep`, never
`run_in_background`, never read output files in a loop (#x36vidg), never `reset` or re-`request` yourself. The fix
daemon reads the verdict every tick and resumes THIS session with a message that starts
`[harness verify verdict — #5137]`; nothing is pushed for you (your own `open-pr` publishes the ref).
`mark` records the `--ref` only to bind your session; use the same `<slug>` you will pass to `open-pr` in step 8.

The resume message tells you which branch you are on, and it is the same verdict `verify-lane.mjs check` prints:
- `green` → the gate settled GREEN for exactly that tree: continue at the step after this gate (step 6). If you change
  any file after `mark`, `request` and `mark` again — a green is for the tree that was marked.
- `red` → the failing tests are in the message: repair, `request`, `mark` again with `--attempt=<n+1>`, and end your
  turn. On the third red the message tells you to take the gate-red hard stop (see *Escalations*).
- `infrastructure-failure` / no verdict → the harness re-requests on its own; after repeated failures the message tells
  you to report the stalled request with the blocked-on-infra exit (the signal/ceiling evidence, no test failure claimed).
- a moved lane (a new commit landed mid-wait) → `request` and `mark` again for the current HEAD.

Reading `check`'s `status`/`ok` yourself is only for diagnosing a stuck handoff, and then only a single bare
`node scripts/verify-lane.mjs check --json` (never a `--wait=` loop): `green` (ok — the only one that satisfies this gate) /
`red` / `infrastructure-failure` / `running` (not a failure) / `corrupt` (`request` again) / `absent` (nothing was
requested for this HEAD; `request` it) / `break-glass` (`ok:true` but an OVERRIDE — only with `WE_LAND_UNVERIFIED=1`).

### 6. Converge your diff — run `/converge` against the lane clone (BEFORE the PR)

A green gate proves the **checks** pass; it does **not** prove the **diff is correct**. Before you open the
PR, run the REAL bounded editor↔reviewer convergence loop — panel judges → editor revises → red-team ratifies
→ panel re-judges, capped by rounds — via the [`/converge`](../converge/SKILL.md) skill (#2971/#2969). The
loop's control flow, panel composition, round cap and ledger all live in the tested core
(`we:scripts/lib/converge-core.mjs` / `we:scripts/lib/jury-core.mjs`); this step **drives** that core, it never
re-derives any bound the core already owns (per [we:docs/agent/platform-decisions.md#deterministic-core-thin-judgment](../../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)).

Invoke `/converge` (or drive `we:scripts/converge-cli.mjs` directly, per its `SKILL.md`) against **this lane's
absolute root** — never the primary checkout:

```bash
STATE=<somewhere inside $LANE, e.g. $LANE/.converge-state.json>   # keep this path for the whole run
node scripts/converge-cli.mjs init --lane="$LANE" --state="$STATE" --care=elevated \
  --goal="<one sentence from #2969's lead paragraph — what this lane's work is trying to do>"
```

- **Pick `--care` deliberately.** #2954 (deriving it from the touch-set) is not yet landed, so **you** choose
  the band explicitly — never omit it. `elevated` (the default) is right for ordinary work; step up to `high`
  for anything touching a trust boundary, a gate, a contract, or a shared derivation.
- **Loop `init`/`step` to `land` or `escalate`, exactly as `SKILL.md`'s action table directs** — seat every
  `panel`/`red-team` juror through `judgePanel` (never the `Agent` tool, #3145), spawn the one `edit` subagent
  a `step` calls for, and stamp every observation with the printed `round`. Do not hand-run a round cap, a
  panel size, or a ledger yourself — that is exactly the un-bounded prose loop this step replaces.
- **`land`** — a non-author panel accepted the final diff and an independent red-team failed to break it;
  proceed to the PR.
- **RISKY code PRs MUST have a receipt — `open-pr` refuses without one** (`prePrReview.mode` in
  `we:scripts/pre-pr-review-settings.json`: `off`|`advise`|`enforce`; this repo is `enforce`). A PR is risky when
  ANY of: more than 264 lines, more than 2 subsystems, more than 5 files, no prepared card in the diff, or an
  operator-agent builder. A card-only PR, or a small prepared conveyor PR, is unaffected. **Run `/converge`
  WHILE the step-5 verify is running** (the verify wait is 4-9 minutes anyway), fix its findings in this session,
  commit, then on the final committed head stamp the receipt:
  `node scripts/converge-cli.mjs receipt --lane="$LANE" --state="$STATE"` (it only stamps a run that ended in `land`
  and a clean tracked tree; any later edit changes the tree and voids it). This ADDS to the post-PR review gate; it
  never replaces it. A bypass is `--skipPrePrReview=<reason> --actor=<name> --operatorInstruction="<quoted operator instruction>"` on `open-pr`, interactive sessions only (a dispatched worker can never bypass); it is recorded in the PR body and `.operations/pre-pr-bypass/<day>.jsonl`.
- **Outside that gate this step stays ADVISORY — an `escalate` never blocks PR-open.** Blocking would gate every drain lane,
  doc-only lane, and the lane shipping this very change (the reason #2971 dropped its `pr-land` refusal).
  `escalate` is **terminal for this run** — the core already spent its round budget resolving what it could
  before landing on it, so do not hand-invoke another `init`/`step` cycle hoping for a different answer. On
  `escalate`, carry the printed escalation packet's reason into the PR: if it names a taste/product/policy call
  a reviewer can't resolve, open the PR parked `review:human` naming that call (*Escalations* #3/#4 below);
  otherwise treat it like any other step-6 finding — fix it and re-run `/converge` as a fresh run over the
  revised diff.

### 7. Visual self-review — render the surface, READ the screenshot, diff it against the baseline (UI-locus items ONLY)

Step 6 proves the **diff** is correct; it does **not** prove the **rendered surface looks right**. Code-correct-but-visually-off is exactly how the console-board cluster (#2587 / #2588 / #2604 / #2660) shipped — a large visual delta from its design mock that no code review caught. So **for a UI-locus item** — one that renders a surface a human looks at (a `plateau-app` or `frontierui` page / board / panel / console) — add a **visual** self-review AFTER the `/converge` run of step 6 and BEFORE the PR, enforcing the SAME converge-before-PR discipline. **A non-UI item — a script, a doc, a standard definition, a skill/brief edit — has no rendered surface; it SKIPS this step and goes straight to step 8.**

1. **Render + screenshot the built surface.** Capture the surface against the running dev server with the #2670
   Playwright harness (`plateau-app:tests/visual/capture.mjs`; regenerate a baseline set with
   `render-baselines.mjs`). Do **not** kill or restart a dev server you did not start — detect the running
   instance (`plateau-app` on `:4000`) and capture against THAT, or let the harness serve.
2. **READ the screenshot yourself — you are sighted.** Read the captured PNG and *look at it*. This by-eye pass
   is the review that ALWAYS runs, baseline or not: is the layout, spacing, colour, and content what the spec /
   design mock describes? A comparator can only measure drift from a target; only your eye catches "the target
   itself is wrong".
3. **Run the #2670 comparator against the committed baseline.** Call `compareToBaseline({ shotPath, baselinePath })`
   from `we:scripts/lib/visual-comparator.mjs` — the ONE shared diff engine (#96) — against the surface's
   committed baseline PNG (they live at `plateau-app:tests/visual/baselines/<surface>.png` — e.g.
   `baselines/board.png` / `baselines/console-grammar.png`). It returns
   `region-shift` findings (each with a bounding box, so you know WHERE it drifted) plus a scalar `delta`;
   `{ match: false, … }` is a real visual regression, not noise (the engine is tolerant of antialiasing / hinting).
4. **Iterate to visual convergence.** Fix the surface in the lane and re-capture until the comparator matches
   AND your by-eye pass is clean — the same "converge before the PR" step 6 already enforces. A visual delta you
   cannot self-clear (a genuine design call that needs a human) escalates like any step-6 finding: open the PR
   parked `review:human` (*Escalations* #3).

**No committed baseline? By-eye pass only — a DOCUMENTED skip, never a false-fail.** `compareToBaseline` returns
`{ skipped: true, match: null, … }` when the baseline PNG is absent (the enabler is operator-provided baselines,
exported from the design artifact). A brand-new surface with no target must **not** red the gate just because
nobody has drawn its baseline yet — you STILL Read the screenshot and do the by-eye pass (2), and note the
documented skip on the automated diff. The automated layer only bites once a baseline is committed.

### 8. Resolve the card in the lane, commit, publish HEAD to the `lane/...` ref + open the PR (label green ONLY after `test` passes)

**Resolve the card FIRST — here, in the lane clone, just before the commit, and never earlier.** Resolving is the
CLOSE of the claim/resolve lifecycle (`we:scripts/operations/resolve.mjs`). The claim rode this PR (step 2) and the
resolve rides the SAME PR — `claim`/`release`/`resolve` all run in the lane clone and land in the item's own PR
(`we:docs/agent/backlog-workflow.md`, *Working an item*), so the card reads `resolved` on `main` only when the
daemon merges the PR, and an item that fails in-lane is never left `resolved` (or `active`) on `main`. It comes
AFTER the gate (step 5), the `/converge` run (step 6) and the visual self-review (step 7), because those can still
change the diff and whether the card is really done, and BEFORE the commit so the flip is part of it (and of the
final-HEAD verification below). Resolve **only if every `## Done when` item of `{{ITEM_SPEC_PATH}}` holds**; if one
does not, the card is not done — leave it `active`, do not resolve over it, and say so in your one-line return
(step 10). Never resolve to make a stop look finished, and never on a step-0 not-ready / gate-red stop.

```bash
node scripts/operations/run.mjs resolve --ref={{ITEM_NUM}} --json   # --ref= is a FLAG, not a positional
```

**`resolve` is declared too, and its shape differs from the raw CLI's.** `we:scripts/backlog.mjs resolve`
takes the item as a positional and spells its options kebab-case (`--graduated-to`, `--codified-to`); the
operation takes `--ref=<NNN>` and camelCase (`--graduatedTo`, `--codifiedTo`), and refuses an unknown flag
rather than dropping it. Both run the same four refusals — `open-children` (#658), `uncodified-decision`
(#911), `scope-drift` (#2803), `not-in-flight` — but the operation *names* the one that fired in
`verdict`, so a delivery agent branches on a value instead of parsing stderr, and a `--force=true` that
steps over one is recorded rather than warned about. The drain's own post-land flip
(`resolveLandedItem`) is only the fallback for a producer that did not pre-author it; you are the producer,
so you author it.

Then commit only this item's files — **including the item's own `backlog/` card, which now carries the claim and
the resolve** (explicit paths, never `git add -A`; one commit) on the lane's **current branch**
(its local `main`) — do **NOT** `git checkout -b lane/...`; the single-branch hook blocks branch creation even
inside a lane clone. You never create the `lane/...` branch locally: `pr-land` **publishes HEAD** to that ref
for you via `--ref=... --sha=HEAD`. Then open the PR through the canonical producer — **never a hand-rolled
`gh pr create`** (that skips the #2307 producer review-labeling). **Cross-locus item?** This step opens a
**couple** — two PRs, impl-first / WE-last, manifest on the WE PR — see *Cross-locus items — the two-PR couple*
below in place of the single-PR steps 8–10:

```bash
# Write the commit message to a file, then commit -F it. Do NOT put the message
# in a bash heredoc: backticks in a heredoc (e.g. `scope:`) run as a subshell
# (`bad substitution`). A message file has no such footgun.
# <msgfile> MUST live inside $LANE (e.g. $LANE/.commit-msg.txt) — never under your own
# job-scratch directory (~/.claude/jobs/<id>/tmp/) or /tmp. A write there can be flagged as
# touching a sensitive file and produce an unanswerable permission prompt with nobody watching
# (the standing rule in dispatched-agent-system-prompt.md). The lane clone is already fully
# Edit/Write/Bash-permitted and is where this file belongs anyway. Leaving it there is fine —
# `.commit-msg.txt` (and its `.pr-body.md`/`.pr-body.txt`/`review-*-output.json`/
# `commit-msg-fix-*.txt` siblings) is on the known-safe scratch-litter allowlist
# (`we:scripts/lib/lane-litter.mjs#LANE_RELEASE_LITTER_ALLOWLIST`) that `release` reaps
# automatically (#3568) — you never need to clean it up yourself.
printf '%s\n' "WE #{{ITEM_NUM}}: <one-line summary>" "" \
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > <msgfile>
git commit -F <msgfile> <explicit-paths>

# #2833/#3105/#5137 — verify the FINAL HEAD you are about to land, keyed to this exact commit. Same request-then-hand-off
# shape as step 5 — you cannot run this yourself (guard-bash denies it); request it, record the wait with `mark`, and END YOUR
# TURN (`awaiting verify for <sha>`). The harness resumes this session with the verdict: a `green` means run the `open-pr`
# below; a `red` is repaired and re-marked (the third is a hard stop, see *Escalations*). A moved HEAD (something else
# committed) means `request` and `mark` again for the new HEAD. Never loop on `check`, never sleep-poll.
node scripts/verify-lane.mjs request              # targets HEAD as of the commit you just made — @operation-home-ok: #xab3jh7 — request has no operation-level equivalent yet; folding it in is #xab3jh7
node scripts/conveyor/await-verify.mjs mark --who={{SESSION_SLUG}} --item={{ITEM_NUM}} --ref=lane/{{ITEM_NUM}}{{ATTEMPT_TAG}}-<slug> --kind=delivery --attempt=1

# … END YOUR TURN HERE. After the harness's green resume message, and only then, publish: …

node scripts/operations/run.mjs open-pr --ref=lane/{{ITEM_NUM}}{{ATTEMPT_TAG}}-<slug> --sha=HEAD --base={{DELIVERY_BASE}} \
  --bodyFile=<pr-body> --mode=label-on-green --requireVerified=true --json
```

#### If `{{DELIVERY_BASE}}` is not `main` — do NOT open a PR (#3637)

A landing INSIDE a registered POC branch pays **no per-landing review of any shape** — no PR, no judge panel,
no `converge` pass, no escalation label. That is the whole point of the mode (the operator's ruling on `#3637`:
"we must not be slow by the same slow PR process, otherwise there is not benefit — real review will happen when
the POC graduate"). Your commit's own verification above is the ONLY gate. Replace the `open-pr` call with:

```bash
node scripts/operations/poc-land.mjs --branch={{DELIVERY_BASE}} --json
```

It takes that branch's own write lock, fetches its current tip, fast-forward-pushes when the tip has not moved,
and otherwise rebases onto the fresh tip, re-runs your tests and retries — bounded at 3 attempts. It **never**
forces. A `conflict` or `exhausted` result is a hard stop to report, not something to work around by pushing by
hand: you are never the writer of a POC branch, the lander is. Everything else in this brief (claim, converge,
learnings, release the lane) is unchanged — only the landing transport differs.

**`{{ATTEMPT_TAG}}` goes RIGHT THERE, between `{{ITEM_NUM}}` and your `-<slug>` — never anywhere else in the
ref.** It is empty on a first attempt, so the ref is byte-identical to before this note existed; on a retry it
is how the observer (`#3110`) tells your build's own PR apart from an earlier, still-unresolved attempt's —
without it, a later retry's merge can get credited to a dead earlier one, or vice versa.

`--requireVerified=true` (#2833) makes the home refuse to publish the lane ref unless the HEAD it is landing has a
fresh GREEN verification marker from the `verify-lane` run just above — so a lane that skipped or backgrounded
its verification is caught at the finish line instead of stranding silently. `WE_LAND_UNVERIFIED=1` is the
documented break-glass if you ever must land on CI alone.

**Disclose any rule deviation on the PR body's FIRST line** (#4502): whenever you take `WE_LAND_UNVERIFIED=1`, a
soak/gate waiver, or otherwise break a rule, make the very first line of the PR body `Deviation: <what and why>`.
The drain reads only that first line and parks the PR `review:human` for the operator — a deviating PR never
auto-merges on your say-so. A `Deviation:` on any later line does not count.

`--mode=label-on-green` is the **producer mode** you want: it opens the self-approved PR, **waits for the required
`test` check, applies the `ready-to-merge` label ONLY once it is green, then STOPS**. It does **not** trigger a
drain — the resident drain daemon lands the labelled PR on its next pass. The `ready-to-merge` label means
"fully checked, the drain may land" — it is applied by `pr-land` after CI is green, never eagerly at open, so a
red PR never enters the drain's queue.

`open-pr --mode=label-on-green` BLOCKS until the required `test` check is green (often several minutes). Run
it in the **FOREGROUND with an explicit Bash `timeout: 600000`** (the 10-minute max) — never
`run_in_background`, never a trailing `&`. If the tool still reports the command *"was moved to the
background"*, that is harmless: the PR is already open (`checking`). **Do NOT poll its `tasks/<id>.output`
file and do NOT loop on `gh pr view`/`gh pr checks`** (`we:scripts/guard-bash.mjs` denies both in an agent
session, #x36vidg) — re-invoke the SAME command once more in the foreground (same `--ref` ⇒ idempotent: it
targets the existing PR and applies the label, never a duplicate), then report whatever it returns and exit.

- End the commit message with:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- If the PR's CI ends up red, `pr-land` exits `check-red` (exit 2) having applied no label — that is an
  escalation, not a land, and **leaving it unlabelled does not hold it** (#2216). Park it explicitly:
  *Escalations* case 2 has the mechanism and the exact re-run.
- **`blocked-on-infra` (exit 4) — the ref PUSHED but PR-open failed on an outside dependency (#2659).** If
  `pr-land` pushed your `lane/*` ref but then `gh pr create` failed on a GitHub outage / network fault, it exits
  `blocked-on-infra` (exit 4) — **NOT gate-red, NOT a park**. Your built work is pushed and `pr-land` has already
  recorded the resumable handle in the conveyor infra-blocked state, which auto-retries with backoff and
  resume-opens the PR once infra recovers (the drain still lands it — nothing merges locally). This is **not**
  something you fix or retry yourself: **return `blocked-on-infra` and EXIT** (see *Escalations* #6). Do NOT loop
  `pr-land` by hand, do NOT `--fallback-git`, do NOT re-push.

**Which label — escalate `review:human` by good reason ONLY.** The escalation call is **judgment**, not a
script ([#deterministic-core-thin-judgment](../../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)).
**Default** is `--label-on-green` (opens `ready-to-merge`; the daemon lands it with no human in the loop) — a
clean, reviewed, non-statute PR whose `test` is green lands that way, and that is the norm, not the exception.
Open the PR **parked** instead — `--park=review:human` (#2622: the review label goes on **at open** and the
merge-hold blocks the land) — ONLY when an *Escalations* condition below applies. Do **NOT**
blanket-park a clean, reviewed PR "so a human can see it". `--park` is the only flag that holds
unconditionally; `--no-wait` and `--label=<name>` are **not** holds — why, and the measured cost, in
[[pr-land-dogfood-mechanics]].

### 9. Append a structured learnings entry to the session drop-box (#2614)

Append **exactly one** structured, generalized-lesson entry to the session drop-box — a friction hit, a missing
convention, a doc/skill gap, or an improvement idea from building this item. The drop-box (#2614) is
`scripts/conveyor/learnings-drop.mjs`; it is a **write-time-gated scrub** that REJECTS any entry carrying raw
code, diffs, secrets, absolute/repo-identifying paths, or PII (the schema is tenant-ready by construction), so
keep every field a short generalized lesson — **no** code, paths, or repo names:

```bash
node scripts/conveyor/learnings-drop.mjs \
  --kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --summary="<one sentence — the lesson>" \
  --area="<coarse label, e.g. lane gating / check:standards>" \
  --suggestion="<short recommendation>" \
  --session={{SESSION_SLUG}}
```

The flags are `--kind`/`--summary`/`--area`/`--suggestion` (all four required) plus an optional `--session`;
`--summary` is capped at 240 chars (over-length is rejected) — keep it to one tight sentence.
There is deliberately **no** `--item`/`--entry`/free-form field (the allow-list is the privacy boundary — a
disallowed key is rejected, never appended). If your entry is rejected, it named something it should not have —
generalize it and retry; do **not** try to force it through. Skip this step only if you genuinely hit no
generalizable friction. Distributed capture (every agent, cheaply, in the moment); the `/closing-session` sweep
curates centrally.

### 10. EXIT — do not merge, do not release, do not wait

**Stop here.** Do NOT run `gh pr merge`. Do NOT run a drain. Do NOT `release` the lane — the resident drain
daemon lands the PR. Do NOT wait for it to merge or for CI to finish — no `sleep` loop around `gh pr view` /
`gh pr checks` / `statusCheckRollup`, no `gh pr checks --watch` (denied in an agent session, #x36vidg). The **merge watcher** (`scripts/conveyor/pr-watch.mjs <pr-number>`) is spawned by the
**conveyor skill, not by you**, on the PR number `pr-land` reported for this item in step 8; its process exit
(merged / parked / closed) wakes the main session and re-dispatches the freed lane. Your OWN process EXIT is the
signal you are done. Return a one-line result to the conveyor: `#{{ITEM_NUM}} → PR #<n> (ready-to-merge |
escalated <label> | gate-red | blocked-on-infra)` — and add `, card left active: <which Done-when item does not
hold>` when step 8 did not resolve it. **A red gate / red CI is NOT watcher-visible** (it reads
only state/labels), and **`blocked-on-infra` has no PR to watch at all** — your one-line RETURN is the only
signal that surfaces either, so always report it explicitly.

## Cross-locus items — the two-PR couple (impl-first / WE-last)

Most items are single-locus: build **and** resolve both land in WE — one lane, one PR (the arc above). A
**cross-locus** item is the exception. Its implementation lives in an impl repo (`frontierui` or
`plateau-app`), but its **resolve** — the `active→resolved` flip, plus `claims.json` and the item file —
**always** lives in WE (#96). Such an item can't ship as one PR: it fans out into a **couple** — TWO coupled
PRs, one per repo — that the drain lands in order (impl-first, WE-last). This surfaced in #2539 (a `frontierui` impl PR plus its WE
PR): the delivery agent expected one PR and had no brief for the fan-out. **When your item's locus is not
`we`, use this in place of the single-PR steps 8–10** (steps 1–7 are unchanged — a cross-locus item with a UI
surface still gets the step-7 visual self-review; run the impl repo's locus gate in step 5).

- **One agent, two lanes, two PRs.** You still own ONE item. Acquire a SECOND lane for the impl repo — the
  pool is repo-parameterized (`node scripts/lane-pool.mjs acquire --repo=<impl-checkout> …`) — do the impl
  work in that lane and the WE resolve in your WE lane. Keep the halves scoped: impl files on the impl PR, the
  resolve (+ any WE docs/tests) on the WE PR. Do not fold impl changes into the WE half or vice-versa.

- **Impl-first / WE-last is the land order — and WE carries the resolve.** The drain merges the couple in
  `INTEGRATION_ORDER`: impl repos first (`frontierui`, then `plateau-app`), WE **last**. WE lands only after
  every impl half is green and merged, because the WE half carries the `active→resolved` flip — a failed impl
  merge must never leave a false `resolved` on `main`. A broken impl half therefore holds the whole couple; it
  never half-lands.

- **The lane manifest rides the WE PR — and ONLY the WE PR.** The couple's landing metadata is a
  `.lane-manifest.json` (built by `scripts/readiness/lane-manifest.mjs`): it names **every** repo's `lane/*`
  ref in merge order, plus cross-item `blockedBy` edges and `mergeRiskFiles`. Author it on the WE half and pass
  it to that PR's `pr-land` with `--manifest-file=<path>`; `pr-land` embeds it in the WE PR **body** (not a
  tracked file), and the drain reads it off the head ref to order the merges. `validateManifest` enforces the
  shape — WE must be present, and **exactly one** repo carries the resolve: WE. The impl PR carries **no**
  manifest; open it as a plain `pr-land` (no `--manifest-file`).

- **The WE half is review-parked; the couple's atomicity is the merge ORDER.** The WE PR carries the manifest,
  so `pr-land`'s producer rubric scores it `crossRepo` (`repos.length > 1`) and parks it — `review:pending`, or
  `review:human` if it also touches statute / gate-self. A coordinated multi-repo couple earns a second look.
  The impl PR is manifest-less, so it is **not** independently review-parked; the drain's couple-join (#2393)
  matches its `lane/*` ref against the WE manifest's `repos[]` and makes it inherit only the couple's
  **cross-item** `blockedBy` / `stackParents` (so it can't jump a dependency on *another* item). The atomicity
  that matters — **the WE resolve never lands ahead of its impl** — rests on three robust facts about the WE
  half: it is ALWAYS `crossRepo` review-parked, it orders LAST (impl-first / WE-last), and a human gates it. So
  the resolve waits on `review:accepted` on the WE PR, and the drain merges impl-first, WE-last. Be clear-eyed
  about the corollary of the impl half NOT being parked: with no cross-item blocker, the **impl half can land
  first — before a human clears the WE review** (impl code is additive; the item simply stays `active` until
  its WE half resolves). A human clears the WE PR's review label (via `/review` in the main session); the
  drain then lands any not-yet-landed impl half, then WE.

- **You still EXIT WITHOUT MERGING.** Open both PRs (`--label-on-green`, or parked for a good reason per
  *Escalations*), drop your one learnings entry, and stop — the drain lands the couple in order. Report BOTH PR
  numbers in your one-line return so the couple is visible:
  `#{{ITEM_NUM}} → PR #<we-pr> (+ impl #<impl-pr>) (ready-to-merge | escalated <label> | gate-red)`.

---

## Escalations — when you do NOT reach ready-to-merge

Escalation is **by good reason only** — a clean, reviewed, non-statute PR with a green `test` lands via the
daemon with **no human in the loop**, and that is the default. Escalate — the item does **not** auto-land and
is reviewed in the **main session**, never by you — ONLY when one of these holds. **Never blanket-park** a
clean PR "so a human can see it": over-parking makes the human the bottleneck the conveyor exists to remove
and dilutes what `review:human` means.

**Not grounds, on their own, ever: diff size, line count, or file count.** A big diff is not a reason to want
"a human eye" — that impulse is exactly what the size-weighted committee already exists to satisfy. The scored
rubric already prices size in: `CARE_WEIGHTS.size` (`scripts/lib/review-escalation.mjs`) raises the panel's
rigor — more jurors per lens, more rounds — the moment a diff crosses the size threshold, and the rubric caps
size at `review:pending` (agent-clearable, committee-reviewed), **never** `review:human`
(#2563, [`#blast-radius-advisory-care-not-a-gate`](../../docs/agent/platform-decisions.md)). AI review scales
with a large diff better than it does with a small one; a large, clean, reviewed diff auto-lands exactly like a
small one. If you find yourself reaching for case 4 below because a diff is large or touches an area you don't
know well, that is not a good reason — let the committee's already-elevated rigor do the work instead.

0. **Not ready — the readiness pre-check failed (a PRE-BUILD stop, no PR).** The step-3 gate found the card
   drifted out from under its spec: a `blockedBy` **re-opened**, the spec is **stale/superseded**, its `scope:`
   is **wrong**, or it's **incoherent**. This is the one case that opens **no PR** — you release the claim
   (`active → open`, back in the pool) and hand the lane back per step 3, then RETURN
   `#{{ITEM_NUM}} → not-ready (re-blocked <num> | stale/superseded | scope-wrong | incoherent)`. It is a **good
   reason to stop**: the conveyor surfaces it to the operator to re-prepare / re-check / drop. Do **not** try to
   fix the item yourself, and do **not** build a card that no longer holds.
1. **Statute-touching change** — the item edits a policy-core / gate-self path (see `scripts/lib/gate-config.mjs`).
   `pr-land`'s deterministic rubric (`scoreEscalation` → `producerReviewLabel`, #2307) applies **`review:human`**
   at PR-open, and the daemon parks it. Do not try to clear it yourself.
2. **Gate red** — three different stops. They do **not** share an exit code, and only the third leaves a PR
   behind. Never weaken or delete a test to go green in any of them.
   - **`check:standards` (or the locus gate) fails from your own work.** Caught at step 5, before `pr-land`
     runs at all — there is no PR and no exit code from `pr-land`. Fix it; if you cannot, report the failing
     gate and stop.
   - **The locus-prefix lint fails.** `pr-land` exits **3** with `reason:"locus-prefix"`, *before* the push and
     the create — again there is no PR. Prefix the bare code-path refs (`foo.ts` → `we:foo.ts`),
     `git commit --amend`, re-run.
   - **The PR's `test` check ends red.** `pr-land` exits **2** with `reason:"check-red"`, having applied no
     label. This is the only one of the three where a PR exists, and **leaving it unlabelled does not hold
     it**: the daemon's green reconcile labels *any* producer-owned AI PR `ready-to-merge` the moment CI reads
     green on a later run (`shouldLabelOnGreen`, #2216), which a flaky re-run or a rebase can produce, and it
     lands unreviewed. So park it: re-run `open-pr` on the SAME `--ref` with `--mode=park --parkLabel=review:human` (park mode
     skips the check-wait, so it labels a red PR immediately), **then confirm the label actually landed** (see
     the note below the list). Report the failing check and stop.
3. **A review finding that turns on human judgment** — the step-6 `/converge` run (or the step-7 visual
   self-review, for a UI item) surfaced an issue that is a **taste, product, or policy call**, not a code
   question — the review process itself has no way to resolve it. This is NOT "I'm not sure the code is
   right" or "the reviewer found something I couldn't fully verify" — that is a review question: keep
   converging (spawn another review round, reason it through) until it is resolved or you can name the specific
   non-code call left standing. Name that call in the PR. Open the PR parked `review:human`
   (`--park=review:human`).
4. **Genuine uncertainty about a taste/product/policy call — never about code correctness, unfamiliarity, or
   size.** You ran the review to convergence and the diff is clean, but one specific, name-able decision in it
   is a judgment call no review process resolves (which of two valid UX treatments the product wants, whether a
   naming/positioning choice is intentional, a policy tradeoff with no code-side right answer). Say what the
   call is in your park comment — "genuine uncertainty" with no named call is not a park reason, it is a hedge.
   This is never a stand-in for "the diff is large," "I'm not confident I found every issue," or "I want a
   second opinion because this touches unfamiliar code" — those are exactly what the step-6/step-7 review and
   the size-weighted committee (`CARE_WEIGHTS.size`, see above) already exist to handle, and a bigger or less
   familiar diff earns MORE committee rigor, never a human. Park it `review:human` only once you can point at
   the one taste/product/policy call a human, not a reviewer, must make.
5. **`review:changes`** — a human bounced a prior version of this diff. As a fresh delivery agent you normally
   will NOT see this (you build a NEW item; a bounce lands on an ALREADY-open PR after you have exited). When a
   conveyor-launched PR is bounced `review:changes`, the conveyor auto-re-dispatches a dedicated **fix agent**
   into that PR's lane to repair it and re-arm review — see
   [`fix-agent-brief.md`](fix-agent-brief.md) (#2630); that is the repair path, not this build arc. Repair
   before any land; the fix agent never self-clears the review, so a still-red fix stays parked.
6. **Blocked-on-infra — the ref PUSHED but PR-open failed on an OUTSIDE dependency (#2659).** `pr-land` pushed
   your `lane/*` ref but `gh pr create` then failed on a transient outside fault (a GitHub outage / network
   fault), so it exited `blocked-on-infra` (exit 4). This is **its own outcome** — NOT gate-red, NOT a park, and
   NOT a `not-ready` stop (you already BUILT). Your work is pushed and `pr-land` has already recorded the
   resumable handle in the conveyor infra-blocked state, which auto-retries with backoff and resume-opens the PR
   once infra recovers (the drain lands it — nothing merges locally, nothing is stranded). **Do not fix, retry,
   `--fallback-git`, or re-push it yourself** — just RETURN `#{{ITEM_NUM}} → blocked-on-infra (<cause>)` and EXIT.
   There is no PR yet to watch, so your one-line return is the only signal; the conveyor's recovery pass (§4b)
   drives it from here.

**After any park, CONFIRM the label — the park is not guaranteed to have happened.** A re-run of `pr-land` can
exit **3 before the park ever runs**: the #2833 verify finish-guard (and the step-8 command shape passes
`--require-verified`), the locus-prefix lint, and the lane push all sit ahead of it. And even when the park
block does run, a failed label apply still reports `reason:"parked"` with exit **0** — the `gh` warning is
suppressed under `--json`. So do not infer the hold from the exit code: read `gh pr view <pr> --json labels`
and check a `review:*` label is really there. If it is not, say so explicitly in your one-line return — an
unlabelled PR is exactly the state `shouldLabelOnGreen` heals to `ready-to-merge`.

In every **post-build PR** escalation case (1–5) the *intended* outcome is the same: **the PR ends up carrying a
`review:*` label — never merely "no label" — and it is reviewed in the main session** (`/review`). That is the
target, not a guarantee the seam enforces, which is why the confirmation above is part of the escalation. The
**pre-build** case (0) has no PR to park — you return the claim to the pool and surface the `not-ready` reason.
The **infra** case (6) has no PR yet either — the built + pushed work is recorded and auto-retried by the
conveyor. Either way you surface the reason in your one-line return and exit — you never merge, never override,
never self-clear a review, and never build a card that failed the readiness gate.

## Guardrails (the non-negotiables)

- **Never edit the primary checkout** — all work is in the acquired lane clone (#104/#2183).
- **Never merge** — you stop at `ready-to-merge`; the resident drain daemon is the sole writer to `main`.
- **Never hand-roll `gh pr create` + `gh pr edit --add-label`** — route through `pr-land` so the #2307
  producer review-label is applied at open.
- **One item, one lane, one PR** — do not fold unrelated work in; capture leftovers as new backlog items. (The
  **cross-locus couple** is the sole exception: one item, two lanes, two PRs — impl-first / WE-last, manifest
  on the WE PR; see *Cross-locus items — the two-PR couple*.)
- **Never resolve before the work is built, converged and about to be committed** — `resolve` runs once, in step 8,
  in the lane clone, and rides the same PR as the claim; it is never run at the gate (step 5) and never after the
  merge (you never merge).
- **Work only through the normal verbs** (claim → lane clone → build → resolve in the lane → one commit → PR →
  daemon merge; the claim and the resolve ride that PR) — those are exactly the channels the lane board reads, so state is reflected **for free**. No parallel
  state store, ever (#2612 ruling).
