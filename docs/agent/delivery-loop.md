# The delivery loop, from the driver's seat

`/pr` opens a PR and `/review` performs one. Neither says how to **drive an item from card to merged**, and
the part that is genuinely non-obvious — getting review that is actually independent — is written down
nowhere else. This is that.

## The loop

```
claim → lane → build → mutate → gate → PR → spawn an INDEPENDENT reviewer → verdict → fix → re-spawn → merged
```

Two steps in that chain are the ones people skip, and they are the two that catch things: **mutate** and
**spawn**. Mutation discipline is written up on its own elsewhere; **spawn** is the one documented
nowhere but here, and it is the one whose wrong version looks right.

**A PR that folds in another open PR's fix says so in one line: `Supersedes: #N`** (several:
`Supersedes: #N, #M`). Write it as its own line of the PR body, not inside a sentence. Once your PR merges,
the fix daemon's supersede watch (`we:scripts/conveyor/supersede-watch.mjs`) reads that line and stands #N
down (a `superseded` stand-down plus label), so no fixer or reviewer is spent on work that already landed.
It never closes #N: closing stays an operator decision. The line counts only on a PR authored by the
automation or the operator; the same line on a PR from any other account is ignored. Prose such as "#N is superseded by this PR" is not
read (live: #4532 merged with that prose and `fix-4522` still launched, card 5586).

## You drive it to merged. The human is not a step in this loop.

**An approved item means build it, review it, and land it.** Every step above is yours, including the
verdict. Stopping mid-loop to ask "may I record this?" is not caution — it strands the item and it is the
failure this section exists to prevent. Which items reach a human is **script-decided, at PR-open**, by the
escalation rubric — never by how consequential the change feels to you:

```js
// we:scripts/lib/review-escalation.mjs#producerReviewLabel
if (humanRequired) return REVIEW_LABELS.human;    // gate-self / statute — a HUMAN clears it
if (escalate)      return REVIEW_LABELS.pending;  // an independent review is owed — YOU are the actor
return null;                                      // no park at all; it lands
```

`humanRequired` is `leashFiles.length > 0 || statuteFiles.length > 0` — the declarative-leash and statute
touches, nothing else. `escalate` is the ordinary blast-radius / size / cross-repo / dismissed-findings
signals. So **`review:pending` is not "waiting for the operator"** — it is *"an independent verdict is owed,
and you are entitled to record it"*. `review-pr`'s confirm step says the same thing structurally:
`of: humanRequired ? HUMAN : AGENT`. `"of": "agent"` means **no human ceremony is required here**, not
"ask anyway".

What you may never do is **merge**: `#2290` makes the drain the sole writer to `main`. That is the real
containment, and it is what makes recording a verdict safe rather than final — an accept releases the PR to
a serialized writer, it does not push anything.

Only two things genuinely stop and wait for a person:

1. **`review:human` (gate-self / statute).** `--answer=accept` is REFUSED on it, by design. The one route is
   the `--to=clear-human` ceremony (#2895), which needs an operator instruction quoted verbatim as
   `--reason` — judgment, not a declared input. No instruction naming that PR: hand over the command line
   and stop.
2. **A genuine fork in the work itself** — two readings of the request that lead to materially different
   diffs. Ask about *that*, not about permission to run the loop.

**Which `review:human` PRs are worth opening — the `advisory:*` labels.** The independent advisory on a
`review:human` PR records no verdict (it cannot — see above), so it used to leave a clean review and a never-run one
looking identical (`review:human` + `review:pending`). The advisory path now applies a real, machine-maintained label:
`advisory:accepted` (no blocking findings on the current head) or `advisory:changes`, removes the opposite, and drops
`review:pending`. It never touches `review:human` and never sets `review:accepted`. Both labels are dropped when a new
commit lands (`we:scripts/conveyor/advisory-label-sweep.mjs`, on the runner tick), so they always describe the
current head. **The operator's rule: don't open a human PR until it carries `advisory:accepted` and has no
`review:changes` / `review:pending`.** `we:scripts/operations/operator-queue.mjs` is the sole authority on that list:
a hard label gate, cross-checked against the parsed advisory comment (any label/comment disagreement is reported in
NOT READY), with GitHub's transient `mergeable: UNKNOWN` re-polled and, if unresolved, shown in a separate PENDING
bucket rather than NOT READY. Definitions live in `we:scripts/lib/advisory-labels.mjs`.

> **Observed 2026-08-24, both directions in one session.** An agent recorded `accept` on its own
> `review:pending` PR (correct — that is this rule), then talked itself out of it, wrote the *inverse* rule
> into `vm-sessions.md`, and began asking the operator to clear every PR. The rule was in
> `review-escalation.mjs` and in a #2851 anchor, and in neither place a driver reads mid-loop — so it was
> re-derived from feel, twice, wrongly. It is stated here because *here* is where the driver is.

## Session-delegation trial logging

When opening work delegated to another provider, the orchestrating session passes
`--delegation=codex:gpt-6-astra:bugfix` (substitute the actual provider, model and task type) to
`pr-land.mjs`. The PR body carries the explicit `delegation` marker alongside the author stamp;
commits and labels cannot recover this metadata reliably. Omitting the flag leaves ordinary work
unmarked. Malformed flags fail before publishing; an existing marker is preserved on re-runs.

After the declared `review-pr` operation completes an `accepted` label swap and comment,
`review-set-label.mjs` records a session-delegation trial only for a valid, unambiguous marker whose
exact triple has not met #3690's bar. The gate reads the live scorecard store: five trailing clean
Claude-verified trials plus an earlier informative finding; other verifiers neither count nor break
the streak. Other channels and label targets do not log. Logging failures are non-fatal.

V1 records `outcome: landed` and `findings: null` at acceptance. It does not distinguish a first-round
clean accept from an accept after repairs; consulting verdict-ledger history is separate follow-up work.
Only accepted PRs with author-supplied delegation markers are auto-logged: rejected or abandoned
delegated tasks leave no row and cannot count against the streak. This survivorship bias means the
graduation signal sees only work that eventually succeeded, never work that failed outright. It is a
known v1 scope limit, not a bug; tracked as follow-up alongside the round-history distinction, with no
structural fix required for PR #2313.

## Spawning a reviewer that is actually independent

**A subagent is not a second actor.** It inherits the parent's `CLAUDE_CODE_SESSION_ID`, so the repo's
independence check (`we:scripts/lib/review-independence.mjs`) sees the author clearing their own PR.
`review-set-label.mjs` then refuses — though not unconditionally: the refusal needs the PR body's
`authored-by-actor` stamp to match, and `--to=clear-human` is exempt by design (#2895).

**A headless process is.** It mints its own session id whichever way you invoke it
(`judge-spawn.mjs:38` — three spawns carrying the parent's id in their environment each reported a
different one). That, on its own, is what makes it independent.

<a id="independent-judgment-spawn"></a>

### If the spawn is a JUDGMENT, shell the panel — never the `Agent` tool (#3145)

Everything below this heading is about a reviewer that **acts**: it checks the branch out in a lane, runs
commands, edits. Most independence-claiming spawns are not that. A panel reviewer, a validator jury, a
red-team, a skeptic-per-candidate — each reads material and returns findings. For those there is nothing to
hand-roll and no lane to acquire, because the fan-out already exists as a function,
[`judgePanel`](../../scripts/lib/judge-panel.mjs) (#3050) over
[`judgeSpawn`](../../scripts/lib/judge-spawn.mjs) (#3028), and a CLI that calls it:

```bash
# One JSON payload in, one seat-answer record out. Every juror is a tool-free headless `claude -p` with
# its OWN derived --session-id; `panelSeats` refuses a roster whose ids are not pairwise distinct BEFORE
# anything spawns. The three ceilings are REQUIRED and fail closed — never default one.
node skills-src/jury/panel-fanout.mjs --payload-file="$PAYLOAD" \
  --depth=0 --max-depth=2 --max-total-budget-usd=8 --run-id="$RUN_ID"
```

`$PAYLOAD` is `{ subject, subjectNoun?, round?, jurors: [{ id, lens, mandate }], material | materialFile }`.
Write it with a file tool or `node -e` + `JSON.stringify` — **never** by interpolating material into a shell
string, for the same reason `/converge` refuses observations through a variable: a diff routinely contains
`$(…)` and backticks. Point `materialFile` at the material on disk when it is large; the shim reads it and
puts the bytes on each juror's **stdin**, so there is no prompt fence for a payload to break out of.

Each seat comes back as `{ id, lens, sessionId, ok, findings, notes, error, costUsd }`. The shim **derives no
verdict** — reduce with `review-core-cli reduce` / `jury-core.mjs` exactly as before. A seat with `ok: false`
is a juror that DID NOT RUN, and a lens that did not run never reads as accept.

**Why this and not the `Agent` tool.** A subagent inherits its parent's `CLAUDE_CODE_SESSION_ID` (measured
#3006, re-measured #3048), which is the identity `review-independence.mjs` keys on — so a panel of N
subagents is **one actor wearing N hats** by this repo's own test, however the prompt describes them. Not
hypothetical: `/jury` shipped with exactly this defect and #3057 removed it. Read the limit honestly (#2895)
— a distinct session id is not an *unforgeable* actor signal. What it removes is the failure a subagent
juror has by construction and cannot argue its way out of.

**The editor is not a juror, and must not be routed here.** A revision round *authors*; independence is a
property of the judge. `judgeSpawn` grants tools only against a lane clone that is **not the driver's own**
(`assertLaneCwd`), which the in-lane editor of `/converge` can never satisfy — it exists to edit precisely
that tree. So an editor stays a spawned agent; what must hold is that it is a **different actor from every
juror that judged it**, which is true by construction once the jurors are headless. Giving the editor its
own headless, tool-bearing spawn is a real but separate change —
[#3159](../../backlog/3159-give-the-revision-round-editor-its-own-tool-bearing-headless.md).

### Prefer `review-dispatch.mjs` — reach for the bare pattern below only when it cannot cover the case

`we:scripts/operations/review-dispatch.mjs` already solves this exact problem for the common case: it spawns a
review session with the same independence property (a fresh, non-inherited session id — a random UUID rather
than a derived one, handed to `claude --bg --session-id=<uuid>`) and needs **no permission bypass at all**. It
achieves that by baking a hardcoded `--disallowedTools` deny list (`REVIEW_DISPATCH_DISALLOWED_TOOLS`: the whole
`gh` CLI, `review-set-label.mjs`, `apply-review-request.mjs`, `run.mjs`) into the dispatched session's own argv,
*ahead of* any caller-supplied flags, then runs under an ordinary (non-bypass) permission mode — `dontAsk`, per
`we:docs/agent/dispatcher-runbook.md`'s own confirmed guidance for `--bg`:

```bash
WE_DISPATCH_AGENT_ARGS='["--permission-mode","dontAsk"]' \
  node scripts/operations/review-dispatch.mjs --pr=<n> --repo=web-everything/web-everything
```

This is strictly safer than the bare pattern below — zero bypass, a harness-enforced deny list the model's own
judgment is never consulted on — and it is now the DEFAULT way to spawn an independent reviewer whenever the
review can run on its fixed, mechanized rubric: `review-loop-cli.mjs`'s own two-juror pass (correctness +
security), reduced to a verdict, auto-bounced or auto-cleared per the ratified policy
(`skills-src/review/review-agent-brief.md`).

**What it genuinely does not cover, and why the bare pattern below still exists.** `review-dispatch.mjs`'s brief
is fixed — it has no placeholder for a driver-authored mandate. The *Writing the mandate* section below (attack
priority order, the author's recurring defect, a named mutation instruction) is exactly the kind of
per-PR-specific judgment a fixed, mechanically-instantiated brief cannot carry, and neither can its `--model`/
`--effort` be tuned per dispatch the way the bare pattern's explicit `--model opus --effort high` can. When a
review genuinely needs that — not the routine case — the bare pattern is the tool, and it now MUST carry its own
explicit deny list rather than running with zero restriction (see step 3 below): mirror
`REVIEW_DISPATCH_DISALLOWED_TOOLS`'s intent via `--disallowedTools`, the same harness-enforced mechanism
`review-dispatch.mjs` already relies on — though NOT the identical list (see the note on step 3 for why this
reviewer's own documented `gh pr view` reads mean a wholesale `gh` deny would break its own workflow, unlike
`review-dispatch.mjs`'s brief, which never calls `gh` directly at all). See
`we:agent-memory-src/scoped-approval-beats-global-bypass.md` for why a scoped deny-list beats a global bypass in
general — this is that lesson applied here, not a new one.

The three lines below are the ACTING case — three SEPARATE properties, and it is worth not fusing them; an
earlier version of this page wrote them as one requirement and was wrong about two:

```bash
# 1. a lane of its OWN — never the driver's, and never the primary checkout.
#    This is tool isolation, not identity: two reviewers editing one tree rebase under each other.
#    The DRIVER runs this acquire, but the driver is NOT who edits in the lane — the headless
#    reviewer spawned in step 3, under a session id step 2 hasn't even derived yet, is. So the
#    driver must NOT pass --adopt here: --adopt stamps the CALLING process (the driver) as the
#    lane's occupant (workerSession), and a driver that adopts on its own session id arms
#    guard-lane.mjs's Edit/Write refusal against the reviewer it is about to spawn — the reviewer's
#    own first edit then gets refused as foreign (#3107 bounce). Leave this a plain acquire; the
#    reviewer declares itself the occupant in step 3, under ITS OWN session id, which is the
#    dispatcher → worker hand-off `adopt` exists for (#2997 r2).
node scripts/lane-pool.mjs acquire --purpose=review-1234 --json

# 2. a derived id. Independence does NOT depend on this — headless is already distinct. What the
#    derivation buys is DETERMINISM: the same seed names the same actor, so a re-review is traceable.
node --input-type=module -e '
  import {deriveSessionId} from "./scripts/lib/judge-spawn.mjs";
  console.log(deriveSessionId("rv-1234-r1"));'

# 3. the mandate on STDIN. `claude -p "text"` works fine — this page previously claimed it errors and
#    that was never tested. stdin is for size: a mandate has no ARG_MAX ceiling there, and argv stays a
#    fixed, assertable flag list (judge-spawn.mjs:60). The mandate's FIRST instruction — before any
#    Edit/Write — must have the reviewer adopt the lane itself, now running under its own (derived)
#    CLAUDE_CODE_SESSION_ID: `node scripts/lane-pool.mjs adopt --lane=<n>`. Only after that call does
#    guard-lane.mjs record the reviewer's OWN session as the occupant and start refusing every other one.
#
#    THE DENY LIST IS NOT OPTIONAL. `--permission-mode bypassPermissions` with zero `--disallowedTools` has no
#    safety net but lane isolation — see "Prefer review-dispatch.mjs" above. This list is NARROWER than
#    `review-dispatch.mjs`'s `REVIEW_DISPATCH_DISALLOWED_TOOLS` (which denies `gh` wholesale) because THIS
#    reviewer's own mandate legitimately runs read-only `gh pr view`/`gh pr checks` (see "Writing the mandate"
#    and the "Triage the previous round" guidance below) — `review-dispatch.mjs`'s brief never calls `gh`
#    directly at all, so it can afford the wholesale ban and this fallback cannot. What it denies instead is
#    every MUTATING gh verb (merge, edit, submitting a formal review, closing, and the raw `gh api` escape
#    hatch that reaches the same PUT-a-merge/label endpoint under a different name — the exact shape
#    `review-dispatch.mjs`'s own r1 self-review (#3433) found reachable through an under-scoped deny list) plus
#    the two scripts that stage a self-clear. If a specific mandate genuinely needs one of these, say so in the
#    mandate and narrow the deny list deliberately — do not just drop it. Confirmed live (2026-09-19): this
#    whole invocation is fully scriptable with no TTY — see `we:docs/agent/dispatcher-runbook.md`'s corrected
#    note on the `--bg`-only TTY requirement.
cd <that lane> && CLAUDE_CODE_SESSION_ID=<derived> \
  claude -p --session-id <derived> --model opus --effort high \
  --permission-mode bypassPermissions \
  --disallowedTools="Bash(gh pr merge:*),Bash(gh pr edit:*),Bash(gh pr review:*),Bash(gh pr close:*),Bash(gh api:*),Bash(gh release:*),Bash(node scripts/review-set-label.mjs:*),Bash(node scripts/apply-review-request.mjs:*),Bash(node scripts/operations/run.mjs:*)" \
  < mandate.txt
```

`--effort` is set here, explicitly, for the same reason `--model` is: a review verdict is judgment-shaped
work, and leaving effort at its inherited default is the same under-spend model routing exists to fix, on
the other axis — see *Effort routing* in `we:docs/agent/backlog-workflow.md#effort-routing`. A mechanical
spawn (a named one-file fix, a pointer check) wants `--effort low` instead; judgment wants `high`/`xhigh`.

Run it in the background and keep working; the verdict arrives on the PR. Several at once is normal —
see *Parallelism* below.

## Writing the mandate

A generic "review this PR" gets a generic review. Every mandate that found something real had four things:

1. **Setup as separate commands.** `git -C <lane> fetch`, then `reset --hard origin/<branch>`, then `clean`.
   A compound command trips the staleness guard.
2. **What to attack, in priority order** — named, specific, and pointing at the thing most likely to be
   wrong. "Find the sixth hole" produced a sixth hole.
3. **The author's recurring defect.** Telling a reviewer *"this author's pattern is a claim wider than the
   code"* or *"…a statistic computed over one population and applied to another"* turns a general read into
   a targeted hunt. This is the single highest-yield line.
4. **The mutation instruction**: for every guarantee stated in prose, break the guarded line and confirm a
   NAMED test reddens. A test that stays green with the behaviour removed is decorative and is a finding.

Also state the gate (`node scripts/verify-lane.mjs run`, FOREGROUND — the diff-selected tests; a bare full-suite
run is denied by the Bash guard, 4157, and CI runs the full suite anyway),
and that the findings body is **mandatory** on a bounce.

## What to do with a verdict

**Run the reviewer's own mutation before believing your fix.** A fix that does not redden the exact mutation
they ran has not fixed it. This has caught fixes-that-fixed-nothing repeatedly.

**Then hunt your own.** Break each behaviour the fix adds. Two of the worst defects found in one week were
tests that passed with the feature deleted — including one written in the same commit that added the rule
against them.

**Watch for the vacuous test.** Assertions inside an `if` that never runs, or a loop over an empty list, pass
silently. So does a bare `return` used as a conditional skip — use `ctx.skip()`, which reports as skipped.

## Explain PR holds before dispatching

Run `node scripts/operations/run.mjs pr-reconcile --repo=web-everything/web-everything --json`
before dispatching a review or asking for a human-approval pass. Read `verdict.prs`: one row per PR,
sorted by number, across open, merged and closed states. The scope is every PR in the named repo
(a superset of conveyor work, so missing labels cannot hide a hold); `--pr=N` narrows it.
`requiredCheck` reports the head-keyed `test` check used by the conveyor; `--requiredCheck=<name>`
selects another named check. This is not discovery of GitHub branch-protection rules.

`heldBy` is a summary, with precedence human → stand-down → conflict → dependency → advisory-pending
→ none; `holds` retains every detected reason and its evidence and unblock action. Current labels
`review:human`, `review:pending`, `review:changes`, and `blocked` are recognized. Comment evidence
includes the canonical conveyor stand-down marker and explicit hold statements (the drain's
`held — a review hold (...) stands` wording, human-review requirements, pending advisory review,
conflict and dependency statements). Quoted text and arbitrary mentions of label names are not holds.
Ordinary comment holds use the latest explicit hold/clear statement per category; an acceptance label
alone cannot date or override a comment-only hold. Stand-down markers remain terminal until removed, as the conveyor defines.
Closed/merged PRs report `heldBy: none`; their labels/comments remain visible as history.

Every hold carries a label or comment excerpt. Mergeability is reported independently: without a
recorded conflict hold it does not invent label/comment evidence. Unknown prose is preserved in
`comments` for the reading agent to interpret; this deterministic report is not a natural-language judge.
Diff `verdict` between calls: it contains no observation timestamps (the shared CLI envelope still
carries its normal run identity). This operation explains holds; it never clears, labels, or merges.
Choosing between rival PRs remains the reading agent's judgment.

## When to stand down instead of iterating

Three rounds on one defect **class** without convergence is the signal — not three rounds total, which is
often healthy. If each fix moves the defect one level finer rather than removing it, the model is wrong and
another implementation pass will not find it.

Standing down means: restore the previous correct-but-blunt behaviour, record both failed attempts and what
the next attempt needs settled *before* code, and close the PR. Shipping a subtly-wrong version of something
that feeds a decision is worse than shipping nothing. `#3071` is the worked example.

## Parallelism and lane hygiene

Run tracks concurrently only on **disjoint files** — a reviewer driving a file you are editing will rebase
under you. The gate is the bottleneck (roughly 4× slower with three concurrent reviewers), so wall-clock per
track degrades while total throughput improves.

`node scripts/lane-pool.mjs release --lane=N` when done. The pool is finite and an unreleased lane is
invisible to everyone else.

## Recording what only exists in the session

Before a context clear, the cards must hold anything the conversation holds: a ruling on a `decision` item,
why something was stood down, a measurement that justified a choice. PR review history is already durable on
GitHub; the backlog is the tracker. If a fresh session reading the backlog could not continue, something is
missing from it.

## What this page got wrong the first time

Kept deliberately, because the failure mode is the subject. Three claims shipped in the first version;
independent review caught two and the third fell out of testing it:

| claimed | actual |
| --- | --- |
| only a headless process *with its own derived id* is a distinct actor | headless is distinct either way; the derivation buys determinism |
| `claude -p "text"` errors | it does not — never tested. stdin is about size |
| `review-set-label.mjs` refuses it | conditional: needs the `authored-by-actor` stamp, and `clear-human` is exempt |

All three sat in the paragraph explaining why the mechanism is correct, which is where this kind of
error lives. Three genuinely separate properties — headless execution, a reproducible id, and a large
prompt — had been written as one requirement, so a reader dropping any one of them would have drawn the
wrong conclusion about why the remaining two mattered.

The instruction that follows from it: **a claim about a mechanism is worth exactly as much as the
command you ran to check it.** The false one here was the flat assertion, not the subtle one.
