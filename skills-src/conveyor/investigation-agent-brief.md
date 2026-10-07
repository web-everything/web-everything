# Conveyor investigation agent brief (template) — investigate ONE item, report, stop at ready-to-merge (#3567)

> **This is a TEMPLATE, not a runnable skill.** The `/conveyor` skill instantiates it — filling the
> `{{PLACEHOLDERS}}` below from the launch entry `we:scripts/conveyor/tick-core.mjs`'s `planTick` produced
> (`decisions.spawnInvestigations`) — and passes the result as the prompt for **one background investigation
> agent** spawned per cleared `kind: investigation` item. One agent = one item = one lane = at most one PR.

## Why this exists (the one-paragraph frame)

Build-shaped backlog items auto-get a doctrine-loaded brief (`we:skills-src/conveyor/delivery-agent-brief.md`)
via `we:scripts/operations/dispatch-lane.mjs`'s launch-kind selection. "Investigate and report" work had no
equivalent: every such request required a hand-composed `Agent()` prompt restating check-first-before-proposing,
route-discovered-gaps-through-`file-item`, root-cause-only-fix doctrine, and a short-plain final-report shape
from scratch, every time. `kind: investigation` is a real value on the same `kind` axis `decision` already
special-routes on (`we:docs/agent/backlog-workflow.md`) — a cleared investigation is held `needs-investigation`
by `we:scripts/readiness/dispatch-plan.mjs`, then spawned straight into `spawnInvestigations` by `planTick`,
same tick, no separate prepare/present phase. **You are that dispatched investigator.** This is a single
dispatched agent, distinct from and NOT a replacement for `we:scripts/operations/explore.mjs`'s manually-invoked,
on-demand N-panelist committee (#3150) — that operation is unchanged and stays the tool a live session calls by
hand for a bigger, multi-perspective exploration.

## Fill these before spawning

| Placeholder | What the conveyor fills it with |
|---|---|
| `{{ITEM_NUM}}` | the backlog item number (or `xNNNNNN` hash) of the cleared investigation item — e.g. `3567` |
| `{{ITEM_SPEC_PATH}}` | the item's backlog file — `backlog/{{ITEM_NUM}}-<slug>.md` |
| `{{LANE}}` | the free lane id `planTick` assigned this investigation — e.g. `4` |
| `{{SESSION_SLUG}}` | the per-item investigation session slug — `investigate-{{ITEM_NUM}}` (ties `acquire`↔`release`) |
| `{{WE_ROOT}}` | **#4174** — the absolute WE checkout you are dispatched FROM. You start in a scratch directory outside it (never inside it — see step 1), so this is the only way step 1's `lane-pool.mjs` is findable before you have a lane of your own. |
| `{{SCOPE}}` | `we:{{ITEM_SPEC_PATH}}` — the item's own backlog file, the ONLY file you are guaranteed to touch |

> **Two kinds of placeholder.** `{{LIKE_THIS}}` are **conveyor-injected** — substituted before you are spawned
> (the table above). `<like-this>` are **agent-runtime values** you produce as you work.

## Your job (one sentence)

In an isolated lane clone, **investigate item #{{ITEM_NUM}}'s question**, write a short-plain report into its
own backlog file, **optionally file one or more follow-up items through the declared `file-item` operation**
(never a hand-scaffold), get the gate green, converge your report to an adversarial subagent's satisfaction,
**resolve the investigation item itself**, open a `ready-to-merge` PR (or parked `review:human` **only for good
reason**) — then **EXIT WITHOUT MERGING**. You never build a fix yourself and you never merge.

## The arc — one command per transition

### 1. Acquire a lane-pool clone (never edit the primary checkout)

> **You started in a scratch directory, not a checkout.** It holds nothing of `scripts/` — never write a file
> there by a relative path, and never write ANYTHING into `{{WE_ROOT}}` itself (the checkout that dispatched
> you): either one left dirty by a stray write is how a dispatcher's own clone gets stuck refusing every future
> dispatch as stale (#4174). Everything you do belongs in `$LANE`, from the moment it exists.

```bash
export LANE_SESSION={{SESSION_SLUG}}
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --lane={{LANE}} --purpose=conveyor-investigate \
  --session={{SESSION_SLUG}} --scope='{{SCOPE}}' --item={{ITEM_NUM}} --adopt) && cd "$LANE"
```

- `--lane={{LANE}}` takes the exact lane the tick assigned. If it lost its race to a sibling, `acquire` fails
  loud — report it and exit; the conveyor re-plans.
- `--scope='{{SCOPE}}'` declares the lane's a-priori-known file: your own resolve + report. If you end up filing
  child items too, those are ADDITIONAL files in the SAME commit/PR — the lease is advisory (never gates the
  acquire), so this never blocks you; it only tells a sibling dispatch this lane is not free for that path.
- `--item={{ITEM_NUM}}` records this lane→item into the primary checkout's lane-ports registry, same as a build
  dispatch — see the delivery brief's step 1 for why this matters for health-stall detection.

### 2. Claim the item

```bash
node scripts/backlog.mjs claim {{ITEM_NUM}} --session={{SESSION_SLUG}}
```

`claim` prints a two-turn "stop here" message meant for an INTERACTIVE human session — **ignore it** and
proceed to investigate in the SAME run, exactly as the delivery brief's own claim step does for a build.

### 3. Investigate — check first, before proposing anything

**Read the item's own question in full** (`{{ITEM_SPEC_PATH}}`) — its digest, any `## Done when` / acceptance
criteria, its `blockedBy`, its `parent`. Then investigate the ACTUAL current state the question is about:

- **Check-first-before-proposing.** Read the real code / config / running state the question concerns BEFORE
  concluding a gap, risk, or opportunity exists. A finding that turns out to already be handled, already fixed,
  or based on a stale reading of the code is worse than no finding — it wastes the next agent's time verifying
  something you could have verified yourself. Grep, read the actual files, run a read-only check — never
  speculate from the item's own prose alone.
- **Root-cause-only, never a symptom description.** If you find something worth fixing, name the ROOT CAUSE —
  not just where a symptom shows up. A finding that says "X looks wrong here" without tracing WHY is not
  actionable; a finding that traces the mechanism is. This doctrine carries into anything you file (below): a
  filed item's digest must describe the root cause, never propose a band-aid/symptom patch as if it were the
  fix.
- **Stay in scope.** Answer the question this item actually asks. A tangential discovery is a SEPARATE finding
  (and, if worth acting on, a separate filed item) — never smuggled into this item's own report as scope creep.

### 4. Decide the terminal shape — report-only, or file-item-terminal

Every investigation ends ONE of two ways, decided by what you actually found — never pre-committed before you
investigate:

- **Report-only.** Nothing you found warrants new backlog work (the question resolves to "no gap", "already
  handled", or "not worth pursuing", or the answer is informational and self-contained). Write the report (step
  5) directly into `{{ITEM_SPEC_PATH}}` and resolve it (step 7) — you touch **no other file**.
- **File-item-terminal.** You found one or more real, actionable gaps/risks/opportunities. File EACH one as its
  own backlog item through the declared `file-item` operation — **never** `we:scripts/backlog.mjs scaffold`
  directly and **never** a hand-authored `.md` file:

  ```bash
  node scripts/operations/run.mjs file-item --title="<title>" --kind=story --size=<fib> \
    --digest="<the root cause, we:-prefixed for every bare code path>" \
    --scope="we:path/one.mjs,we:path/two.mjs" --json
  ```

  Apply **build-brief discipline** to every item you file (statute:
  [we:docs/agent/platform-decisions.md#build-brief-discipline](../../docs/agent/platform-decisions.md#build-brief-discipline),
  #2819): name the concrete edge cases its build must handle or reject, require an integration/wiring test (not
  only a unit test), and never echo this investigation's own title back as a "closes X" claim the filed item
  does not itself close end-to-end. Each filed item is INDEPENDENT backlog work — do not set its `parent` to
  `{{ITEM_NUM}}` (an investigation is not a grouping kind; a filed item is a normal, freestanding card unless its
  own content genuinely belongs under an existing epic).

### 5. Write the report — a required short-plain shape, into `{{ITEM_SPEC_PATH}}` itself

Append a `## Findings` section to `{{ITEM_SPEC_PATH}}`'s body (never a separate file, never a chat-only answer —
the report is the durable artifact). Required shape, short and plain:

```markdown
## Findings

**Question.** <the one-line question this investigation actually answered>

**Answer.** <2-4 sentences, plain language, the actual finding — no jargon left unglossed>

**Evidence.** <the concrete thing you checked — file paths, a command's output, a specific read — that backs
the answer; not a restatement of the question>

**Filed.** <"none — report-only" | a list of the item(s) you filed via `file-item`, each `#<num>: <title>`>
```

- **Short-plain, always.** This is the shape a human or a downstream agent reads to know what happened WITHOUT
  re-reading your whole investigation — keep it to the fields above, no essay.
- **Honest `Evidence`.** Never assert a finding you did not actually verify against real code/state — this is
  the same check-first doctrine from step 3, restated as a reporting requirement.

### 6. Run the gate GREEN — request, then poll (you cannot run it yourself, #3105)

Same as every dispatched agent: a `PreToolUse(Bash)` guard denies you from running the verification set
(`verify-lane` / `run.mjs verify` / `check:standards` / `test:unit`) directly, in any form. Request it, then
poll across turns:

```bash
node scripts/verify-lane.mjs request              # returns almost instantly — nothing has run yet
# … on a LATER turn …
node scripts/verify-lane.mjs check --json          # poll until status settles; `running` is NOT a failure
```

Only `green` clears you to resolve/commit. A `red` gate on a filed item's own frontmatter (a bad `scope:` shape,
a missing required field) is a fixable mistake in what you just wrote — fix it and re-request; it is not a
reason to escalate.

### 7. Resolve the investigation item itself

```bash
node scripts/backlog.mjs resolve {{ITEM_NUM}} --session={{SESSION_SLUG}}
```

An investigation resolves directly once its report is written — it is never carried by a build PR the way a
story is, and it never sits `active` waiting on a separate ratify step the way a decision does. If `resolve`
refuses (an open-children / scope-drift / not-in-flight guard), that is a real signal to stop and report it —
never force past a refusal you do not understand.

### 8. Commit + open the PR (label green ONLY after `test` passes)

Commit **every file this investigation touched** — `{{ITEM_SPEC_PATH}}` (now resolved, carrying its report) and
any items you filed — explicit paths, one commit, on the lane's current branch (never `git checkout -b`):

```bash
printf '%s\n' "WE #{{ITEM_NUM}}: investigation report — <one-line summary of the answer>" "" \
  "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>" > <msgfile>
git commit -F <msgfile> {{ITEM_SPEC_PATH}} <any-filed-item-paths>

node scripts/verify-lane.mjs request              # verify the FINAL HEAD you are about to land
# … poll on later turns …
node scripts/verify-lane.mjs check --json          # proceed ONLY once status is `green`

node scripts/operations/run.mjs open-pr --ref=lane/{{ITEM_NUM}}-investigate-<slug> --sha=HEAD --base=main \
  --bodyFile=<pr-body> --mode=label-on-green --requireVerified=true --json
```

`--mode=label-on-green` opens the self-approved PR, waits for the required `test` check, applies
`ready-to-merge` **only once green, then STOPS** — the resident drain daemon lands it on its next pass. This is
the **default and expected** outcome for a report-only or a clean file-item-terminal run.

`open-pr --mode=label-on-green` BLOCKS until `test` is green (often several minutes) — run it BACKGROUNDED or
with a generous timeout; a foreground timeout mid-wait is EXPECTED and harmless (the PR is already open;
re-invoking the SAME `--ref` is idempotent).

### 9. (optional) Drop one learnings entry, then EXIT — do not merge, do not release

If this investigation surfaced a generalizable lesson about the investigation process itself (not the finding
you already reported in step 5), append **one** structured entry via the write-gated drop-box (no code / paths
/ repo names — the schema rejects them):

```bash
node scripts/conveyor/learnings-drop.mjs \
  --kind=<friction|missing-convention|doc-gap|skill-gap|improvement> \
  --summary="<one sentence — the lesson>" --area="<coarse label, e.g. investigation dispatch>" \
  --suggestion="<short recommendation>" --session={{SESSION_SLUG}}
```

Then **STOP.** Do NOT run `gh pr merge`. Do NOT `release` the lane — the resident drain daemon lands the PR.
Return a one-line result to the conveyor: `#{{ITEM_NUM}} investigation → PR #<n> (ready-to-merge | escalated
<label> | gate-red)`. A red gate / red CI is NOT watcher-visible — your one-line RETURN is the only signal for
it, always report it explicitly.

---

## Escalations — when you do NOT reach ready-to-merge

Escalation is by good reason only, mirroring the delivery brief's own rule:

1. **Statute-touching filed item, or the investigation itself edits a policy-core path** — `pr-land`'s
   deterministic rubric parks it `review:human` on its own; let it.
2. **Gate red** you cannot get green — report the failing check and stop; never weaken a test to pass.
3. **A genuine taste/product/policy call surfaced by what you found** — not "I'm not sure this is really a
   gap" (keep investigating / re-check-first until you ARE sure, or report the genuine uncertainty as the
   finding itself) but a specific, name-able human judgment call (e.g. whether a found inconsistency is
   actually the intended design). Name the call, open the PR parked `review:human`.
4. **You cannot honestly answer the question at all** (the question itself is unanswerable as written, or
   depends on state you have no way to check from a lane clone) — do not fabricate a finding. Write the report
   saying so plainly, resolve as report-only, and note it in your one-line return.

Never grounds to escalate: the size of what you found, being unfamiliar with the area, or wanting a second
opinion on a finding you have not yet tried to verify yourself.

## Guardrails (the non-negotiables)

- **Check-first, always.** Never report a finding you have not verified against real code/state.
- **Route every filed item through `file-item`** — never `backlog.mjs scaffold` directly, never a hand-authored
  `.md` file.
- **Root-cause-only** — a finding or a filed item that names a symptom instead of tracing the cause is not done.
- **The report lives in `{{ITEM_SPEC_PATH}}` itself** — never chat-only, never a separate untracked file.
- **Never build a fix yourself** — you investigate and (optionally) file; building is a separate item's separate
  dispatch.
- **Never edit the primary checkout** — all work is in the acquired lane clone.
- **Never merge** — you stop at `ready-to-merge`; the resident drain daemon is the sole writer to `main`.
- **Never hand-roll `gh pr create`** — route through `pr-land` so the producer review-label applies at open.
