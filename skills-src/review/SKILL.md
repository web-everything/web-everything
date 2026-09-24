---
name: review
description: Review a parked pull request and record the human verdict — pull the PR's diff + the drain's escalation reasons, run the shared review core (findings + verdict), present them, and on your OK swap the review label (review:human/review:pending → review:accepted, or review:changes to bounce the fix back to the author lane). Use when the user asks to "review PR #N", "clear the parked PR", "look at the review:human PR", or give a human verdict on a drain-parked PR. NOT for reviewing your own working diff (that is /code-review) and NOT for opening a PR (that is /pr).
---

# Review a parked PR — the human verdict (#2326)

The drain (`/drain`) **parks** a blast-radius or gate-self PR with a `review:*` label and waits for an
independent verdict before it may land (#2171/#2262/#2285). `/review <PR>` is that verdict.

**The flow is a declared operation, not a procedure you follow.** `review-pr`
(`we:scripts/operations/review-pr.mjs`, #3035) declares five steps — `read` → `judge` → `reduce` → `confirm` →
`record` — and the command line is derived from that declaration (#3031's statute
[`#operations-declared-once-callers-generated`](../../docs/agent/platform-decisions.md#operations-declared-once-callers-generated)).
Your job is to **invoke it and present its output**. Do not re-derive the diff, the mandate, the verdict or the
label swap by hand: each is a step, and a hand-rolled one drifts from the console's copy (#3036) by construction.

## Run it

**Read the touch-set FIRST, and derive the shape from it (#3335).** Not the park comment's echo of the file
list — that can lag the head. The shape command is the derivation, not a taxonomy you apply by hand:

```
gh pr view <PR> --repo=<owner/name> --json files --jq '[.files[].path]' \
  | node scripts/review-core-cli.mjs shape --json
```

It prints `{careLevel, reasons, humanRequired, earnedLenses, mandatoryFloor, subject, rounds, jurorsPerLens,
seatLens}` — composed from `scoreEscalation` + `panelRigorForCareLevel` (via #3309's subject router), so it
agrees with `review-core-cli.mjs rigor --reasons=<those reasons>` by construction. Then run the review with the
`careLevel` it gave you, and the `--lens` it names:

```
JUROR_LANE=$(node scripts/lane-pool.mjs acquire --purpose=review-juror)
node scripts/operations/run.mjs review-pr --pr=<PR> --repo=<owner/name> \
  --careLevel=<the shape's careLevel> --lens=<the shape's seatLens> --cwd="$JUROR_LANE" --json
# …and when the review is done, hand the lane back (the slug is on acquire's stderr):
node scripts/lane-pool.mjs release --lane="${JUROR_LANE##*lane-}" --session=<the holder slug acquire printed>
```

**`--careLevel` is a DECLARATION that gets checked, not a dial.** It cannot add a seat — the step list is fixed
at registration (#3319), so declaring `high` does not seat five lenses. What it buys is two refusals and one
honest sentence: an escalated declaration **refuses** an advisory `--lens`; `read` re-derives the shape over the
**net** file list and refuses an **under**-declaration (declaring more care than the net diff earns proceeds —
`gh`'s three-dot list is routinely inflated by sibling-lane content); and the durable comment states what the
touch-set **earned** beside what actually **sat**, with the shortfall named lens by lens. Omitting it is still
legal and changes nothing — which is precisely why deriving it is step one of this flow rather than a habit.

**`--cwd` is REQUIRED, and it is a lane of the JUROR's own** (#3151). `review-pr`'s juror is tool-bearing — it
runs gates, reproduces defects and mutates source to test a claim — so `assertLaneCwd` refuses to spawn it
without a lane, rather than letting it inherit whatever tree you are standing in. `acquire` prints the lane's
path on stdout and its holder slug on stderr; the lane must not be the primary checkout and must not be the
lane you are driving from (`assertLaneCwd` refuses both, by inode identity rather than by spelling). It is the
juror's WORKING directory, **not** the checkout the PR is read from — `read` still runs against this repo, so
pointing it at another repo's clone does not make a cross-repo review work (#3137).

`--model=<alias>` overrides the juror's model, and `--help` lists both. (`JUDGE_LANE_CWD` in the environment
still works as a fallback — it was the ONLY way until #3151, which is why older dispatch prompts thread it by
hand.)

### On a host where `gh` cannot authenticate — stage the view first (#xhqqy9j)

`read` makes exactly one network call: `gh pr view --json`. On a cloud VM that call fails and the whole review
stops before it starts. The transport for that case is a view **staged on disk**, which `review-pr-io.mjs`
reads instead of calling `gh` whenever `WE_PR_VIEW_DIR` is set. **CI produces that view; you do not** (#xaoja7a):

```
node scripts/operations/run.mjs stage-pr-view --pr=<PR> --repo=<owner/name> --fromTransport --dir="$WE_PR_VIEW_DIR" --json
```

That pushes a `{repo, pr}` request to `ops/pr-views`, waits for `we:.github/workflows/stage-pr-view.yml` to run
`gh pr view --json` with a token and commit the answer back, and reads it with
`git show origin/ops/pr-views:…`. Expect ~1–2 minutes on a cold request. If it times out, the request is
already pushed and nothing is lost — check the `Stage PR view` run and issue the same command again. If it
refuses the view as **stale**, the PR's head moved after CI produced it: add `--refresh` to ask for a new one.

**Why you must not supply the view yourself.** `--from=<path>` still exists and is **refused on any repo whose
`ops/pr-views` branch exists**. That is not manners, it is the fix. On PR #1542 a reviewing session staged a
paraphrase of the body in its own voice plus a comment it had written itself, stamped
`authorAssociation: OWNER`, that is not on the PR at all — inside the evidence its own juror then read. A juror
weights an owner's word above a drive-by by design, so a synthesized one inverts the signal. Every completeness
check passed; completeness was never the property in question.

Those completeness checks still hold. A view assembled by hand from another API's response drops a field by
omission, and the reader DEFAULTS every field it consumes rather than failing: an absent `labels` makes a
`review:human` PR read as unlabelled and clearable, an absent `comments` hides the escalation and the last
verdict, an absent `body` loses the park's disposition. None of that throws — you get a completed review of a
PR that was never fully read. The operation refuses an **absent** field by name and believes an **explicitly
empty** one (`"labels": []` is a claim; omission is not), writes under the reader's own injective name, refuses
a view whose `headRefOid` is not the head the judged diff will come from, and stamps `_stagedFrom` into the
staged bytes so the artefact records where its evidence came from.

### On a host where `gh` cannot authenticate — the VM write path (#3539)

The staged view solves reading only. `review.advisory-note` and `review.label-swap` both call `gh`; either can
halt after judging with its outcome **UNKNOWN**. Before recording on this host, read
*What still needs you → A host that cannot authenticate to GitHub* below: use
`node scripts/operations/record-verdict-cli.mjs --runId=<run-id> --to=accepted --json` for an ordinary accept,
or `--to=clear-human --operatorInstruction="<quoted instruction>"` for the authorized human ceremony.
That transport runs the real CLI in CI and preserves its guards; it is the preferred write route (#3540).

If an effect has already halted, read
[docs/agent/vm-sessions.md → When an effect halts with its outcome UNKNOWN](../../docs/agent/vm-sessions.md#when-an-effect-halts-with-its-outcome-unknown)
before `--resume`. Check the live PR's comments and labels through the credentialed channel to establish what
actually happened. Only then resolve that effect's entry in `.operations/runs/<run-id>.json`: `applied` for a
verified completed effect, with a `result` naming the fallback and its evidence; `failed` only when verified
not applied. If still uncertain, leave it unresolved. A `failed` entry permits retry; it does not give this
host a `gh` credential. Complete a missing effect through the working channel, verify it on GitHub, mark it
`applied`, then run `node scripts/operations/run.mjs review-pr --resume=<run-id>`. Never replay blindly.

**Keep the juror's words.** If `review.advisory-note` did not post, its findings remain local. Transcribe the
juror's findings and verdict verbatim from the run record through the credentialed channel, label the comment
as a transcription with the run id, and retain the advisory-only / human-ceremony-required notice. Do not
substitute the session's retelling or present the transcription as an automatically posted juror comment.

**A connector label swap is unguarded.** If the guarded transport is unavailable and the authorized clearance
must use the connector, first read
*docs/agent/vm-sessions.md → What the credential-less fallback silently drops*. In the durable clearance
record, say plainly that the swap bypassed `we:scripts/review-set-label.mjs` and ALL its guards: the actor
independence check, the `reviewed-sha` / `reviewed-diff` / `reviewed-contribution` markers and the write ordering.
Do not describe them as passed. Preserve the human ceremony's PR-specific instruction verbatim and identify
the actual judging actors; a shared git login is not an independence test. This fallback does not authorize
an agent to clear its own diff or turn an advisory verdict into a human instruction.

### Present the verdict and record the decision

The operation reads the PR, judges the diff, reduces to a verdict, and then **suspends** for the decision.
On `review:human` it also attempts the automatic advisory note described below; a VM write halt needs the
recovery above before continuing. Present its `verdict` (the findings and the reduced verdict), its `findings.read` (the escalation
reason, the disposition, the net changed-file list, any advisory comment), its `spend` (what the juror cost —
the operator is on a constrained model budget, so report the dollar figure, never omit it) and its
`pending.asks` to the operator, then stop.

**Lead with the resolution basis when there is one (#2447).** A backlog-only PR that resolves its item via
`graduatedTo` — the deliverable already landed in an earlier commit — reads like a hollow resolve if you present
its file list first. Before the findings, check for the basis: `node scripts/review-detail.mjs <PR>
--repo=<owner/name> --json` carries it as `resolutionBasis` (and prints its banner under the title), and the drain's
park comment opens with the same `📦 Resolution basis: graduatedTo: <sha> — no code change — deliverable already
landed in <sha>` line. Present that line first, then the rest. When you render a comment through
`review-core-cli.mjs comment`, pass `changedFiles` plus the PR `body` (or `graduatedTo`) in its input and the banner
heads the comment for you — it fires only for an all-`backlog/` diff, so a code resolve renders unchanged. What
you are still judging on such a PR is whether the cited commit really delivers the item's acceptance; the banner
says where to look, it is not a verdict.

**A run seats TWO jurors, and `--lens=` steers only the first (#3319).** There are two declared `judge` steps:
`judge`, whose lens comes from `--lens=` and defaults to `correctness` (`MANDATORY_LENSES[0]`), and
`judgeSecurity`, pinned to `MANDATORY_LENSES[1]` and **deliberately not reachable from the command line**. Both
run on every PR, so you will answer **two** judge suspends, not one. `--help` lists the valid lenses.

**Read `--lens=` as "what the first seat judges", never as "which single lens judges".** The older reading is
the one that burns people: pointing `--lens` at an *advisory* lens does not narrow a panel to that lens, it
**replaces the mandatory correctness seat with an advisory one**, and the run's blocking floor quietly drops. Two
sessions were caught by that in a single day, from opposite directions. If you want a specific advisory lens
looked at, ask for it in addition — not by pointing `--lens` at it.

**So for one caller-chosen seat there are TWO bands, not four — and the shape command tells you which (#3335).**
The care dial does not produce "the mandatory pair for code": at `low`, `elevated` and `high` alike it asks for
the **whole five-lens set**, and only `rounds` and `jurorsPerLens` change. `none` asks for **no panel at all**.
Hence:

| the shape's `careLevel` | what to spend the seat on |
| --- | --- |
| `none` | the floor lens is proportionate — the dial asked for no panel, so `--lens` may go where you like. |
| `low` / `elevated` / `high` | a **`MANDATORY_LENSES`** value — the shape's `seatLens`. One seat cannot deliver the fan-out the dial asks for, so the seat must be able to block and the shortfall is recorded. An advisory `--lens` here is **refused** by name. |

Choosing an advisory lens on an escalated PR must be a stated choice, never a default nobody notices — that was
PR #1569 round 2, which sat `claim-accuracy` alone on a declarative-leash change.

**Two `judge` steps are still not a `judgePanel` fan-out**, and the distinction is load-bearing. `judgePanel`
(#3050) omits `allowedTools` from its per-seat call object, so every panel seat would run `--tools ''` — that is
**#3158, still open** — and today's juror is tool-bearing because, as `we:scripts/lib/judge-spawn.mjs` puts it,
*"the tools ARE the finding mechanism."* Two declared steps buy two distinct tool-bearing actors without paying
that bill.

Report the verdict as **the seats that actually judged** — the write-up's table lists what ran, not what
exists. Do not call it a panel verdict, and do not describe a run as single-lens. **And report what the PR
earned beside it (#3335):** the write-up's *Earned vs seated* line names the derived care level and the lenses
that were earned but did not sit, so "3 panel lenses did not run" can be read as proportionate or as a
shortfall. Carry both halves; neither sentence means anything without the other.

On the operator's explicit decision (on a VM, use the write path above):

```
node scripts/operations/run.mjs review-pr --resume=<run-id> --answer=accept    # → review:accepted
node scripts/operations/run.mjs review-pr --resume=<run-id> --answer=changes   # → review:changes, back to the author lane
node scripts/operations/run.mjs review-pr --resume=<run-id> --answer=changes --reason="<what must change>"   # required when the juror found nothing
node scripts/operations/run.mjs review-pr --resume=<run-id> --answer=abstain   # → records nothing at all
```

**`accepted` on a `review:human` PR is refused by `decideSetLabel` by design; on a VM where the guarded
`--to=clear-human` transport is unavailable, the connector is the only route for an authorized human clearance,
and disclosure that it bypasses `we:scripts/review-set-label.mjs` and all its guards is mandatory.**
Use the human ceremony under *What still needs you*; `--answer=accept` cannot replace it.

Five things you no longer have to remember, because the machinery holds them:

- **An override must say why (#3035).** When the juror returns **zero** findings and you record `changes`, you are
  bouncing on something the juror did not raise. `--reason` is then REQUIRED and the operation refuses without it;
  the reason is rendered in the durable comment, which is the only place the author lane can read it. A bounce that
  carries juror findings needs no `--reason` — those findings ARE the reason and are already rendered. See
  *Why the override refusal exists* below.
- **The stop is a suspend.** `--answer` without `--resume` is refused — you cannot answer a question that has
  not been asked, so there is no auto-proceed to resist.
- **The diff is on the net basis** vs current `main` (#2450/#2901), and the juror is told that file set as
  ground truth. `gh pr diff`'s inflated three-dot list never reaches it. A mis-shaped `exec` (#2952) is a hard
  refusal, not a quiet fallback.
- **Re-running skips applied effects.** A `--resume` refuses to guess at an UNKNOWN outcome; resolve it using
  *On a host where `gh` cannot authenticate — the VM write path* above before resuming.
- **The label swap goes through `we:scripts/review-set-label.mjs`** — the single home (#2644), with the
  `reviewed-sha` / `reviewed-diff` / `reviewed-contribution` markers and the #2964 write ordering. `accepted` on
  a `review:human` PR is refused in `decideSetLabel`'s pure core, so the operation cannot clear a gate-self PR
  either.

### Why the override refusal exists

The write-up's panel body is composed from the JUROR's findings while `Decision:` comes from your answer, so a
reasonless override posted *"✅ pass — no blocking findings"* directly above *"Decision: `changes`"*. A bounce the
author cannot act on buys another round by construction.

Counted 2026-08-26 by sweeping the live comments on PRs #1428–#1567 (140 PRs, 479 comments) for the shape this
operation emits — the line ``**Decision:** `x` — recorded by``:

| | count | PRs |
| --- | --- | --- |
| structured verdict comments | 106 | 59 (none below #1456) |
| …recording `changes` | 44 | 15 |
| **…over `### Findings (0)`** — the case the refusal binds | **18** | **8** (#1556–#1567) |
| …under the juror's own "✅ pass" line — the wider reading | 34 | 11 (#1556–#1567) |

`--reason` rides the **same `--resume` that carries the `--answer`**, not the opening call — an override is only
knowable once the juror has returned, so that is the first moment you could state one. Passing it without an
`--answer` is refused rather than ignored: a reason silently dropped is worse than none.

`--reason` is accepted on *any* answer, and only a decision that actually departs from the juror is captioned as an
override. Pass one alongside an answer the juror agrees with and it is still rendered — under **Operator note**,
which says in words that this was not an override.

> **Retracted — three times, all in this section.**
> 1. It read *"Eleven bounces across PRs #1428–#1567 did exactly that."* Eleven was the number of PRs in the wider
>    set, not the number of bounces; and none of them occurred below #1556, so the stated range implied 128 PRs of
>    history containing none.
> 2. It read *"(108 comments, 62 PRs): 45 recorded `changes`, and 17 of those … it is 33, across 11 PRs."* Re-running
>    the sweep gives 106 / 59 / 44 / 18 / 34. The 108 came from a looser match that also swept up 7 hand-written
>    operator comments carrying a `**Decision:**` line with no `— recorded by` — an operator's own prose, not this
>    operation's output.
> 3. It implied every `--reason` rendered as **Why this was overridden**. It did, and that was the defect:
>    `--answer=accept --reason="fyi"` posted a durable claim of disagreement where there was none.

## An automatic advisory note now posts itself on `review:human` — you don't have to (#xlw02hw)

Before this, the ONLY thing that ever posted anything to a PR was `record`, reachable only through a real
`confirm` answer — and on a `review:human` PR no session running an independent advisory pass (not the human
ceremony) had a legitimate one to give: `--answer=accept` is refused, `--answer=changes` would be the real
ceremony's bounce with no human behind it, and `--answer=abstain` records nothing. Twice live (PRs #1814/#1815)
a juror ran, found real findings, and nothing durable ever landed — the session had to `gh pr comment` by hand.

Now the `advise` step posts a clearly-marked **advisory-only** comment automatically the moment `reduce` has a
verdict, on every `review:human` PR — no `--resume`, no answer, no extra step of yours required. It happens
inside the SAME `node scripts/operations/run.mjs review-pr …` invocation you already run above, so you do not
call anything new. It is unmistakably NOT the real ceremony's comment: no `**Decision:**` line, no `review:*`
label ever touched, an explicit "advisory only — the human ceremony is still required" statement top and bottom.
A `review:pending` PR is completely unaffected — the step declares no effect at all for it.

**The `advisory:accepted` / `advisory:changes` label — the operator's at-a-glance signal.** Right after the note,
`advise` applies one of two machine-maintained labels, so a human-gated PR whose advisory came back clean no longer
looks identical to one nobody reviewed:

- `advisory:accepted` — the panel found **no blocking findings on the current head**.
- `advisory:changes` — it found blocking findings. Each label removes the other, and either one also drops
  `review:pending` (the advisory has now run). **It never touches `review:human` and never sets `review:accepted`.**
- The outcome is the panel's verdict with the human gate factored out (`deriveAdvisoryOutcome`), also written into
  the note as an `**Advisory outcome:**` line — the run's own verdict is `needs-human` on every gate-self PR, so it
  says nothing about the findings.
- **It describes the CURRENT head only.** The sink refuses to label a head that moved while the panel ran, and the
  runner's `advisory-label-sweep.mjs` drops both labels on any PR whose head moves past the advisory (next tick).
  A pushed commit therefore means no advisory label until the advisory re-runs.
- **It describes a `review:human` PR only.** The moment `review:human` comes off (`--to=clear-human`), the label no
  longer describes anything — `decideSetLabel`'s `clear-human` branch drops it in the same write going forward,
  and the runner's `review-hold-reconcile.mjs` sweeps the strays that predate that fix (also drops a stray
  `review:pending` left beside a still-live `review:human` — #x01u7az).

**The operator's rule** (2026-09-19): *do not open a `review:human` PR until it carries `advisory:accepted` and has
neither `review:changes` nor `review:pending`.* `node scripts/operations/operator-queue.mjs` enforces exactly that as
a hard gate for its NEEDS YOU list, and cross-checks the label against the parsed advisory comment (newest advisory
covers the live head and accepts) — any disagreement is listed in NOT READY with the disagreement as the reason.
GitHub's transient `mergeable: UNKNOWN` is re-polled and, if it never settles, reported in a separate PENDING bucket
("transient, re-run"), never in NOT READY.

On a host without `gh`, that automatic post can halt as UNKNOWN. Follow the VM write-path section above to
verify the outcome and, if missing, publish a labelled verbatim transcription before resuming.

## What still needs you

**The two shapes of a `review:human` park.** Read the drain's comment to tell them apart (`deriveReviewDisposition`,
#2285) — the operation reports which in `findings.read.disposition`:
- a **sensitivity** park (`gate-self`, `{ mode: converge, autoLand: false }`) — the drain may already have pushed
  an advisory FIX to the branch. The diff you are reading can carry agent-authored trust-chain edits. Scrutinize
  them; do not rubber-stamp.
- a **deadlock** park (`non-convergence` / `mandate-conflict`, `{ mode: human }`) — the loop could not agree and
  pushed nothing. You break the tie.

**Clearing a gate-self PR — the human ceremony (#2895).** `--answer=accept` is REFUSED on a `review:human` PR,
and that is the invariant working. The guarded human-ceremony command is:

```
node scripts/review-set-label.mjs <PR> --repo=<owner/name> --to=clear-human --actor="<operator>" --reason="<quoted instruction>" --body-file=<findings.md>
```

**Where `<findings.md>` goes, because the path is constrained (#2897).** Its contents are published to a public
PR and cannot be unpublished, so the CLI refuses a path outside the repo root, the OS temp dir, or `/tmp`.
Write it under `/tmp` — that works on every host, including a session scratchpad nested beneath it. Do NOT
route around a refusal by hand-rolling the comment: that is the bypass the single home exists to close, and
the refusal names the roots it will accept.

It is deliberately **not** a step of the operation: it demands an operator instruction quoted verbatim, which is
judgment, not a declared input. **You may run it ONLY on an explicit in-conversation instruction from the
operator naming that PR, and you must pass that instruction verbatim as `--reason`.** No instruction, or an
instruction about a different PR: hand the operator the command line and stop. Nothing in the tool checks who
ran it — #2895 ruled the unforgeable actor signal DEFERRED, so what stands in the way of a clearance nobody
asked for is that misuse takes a written lie. On a VM use the guarded transport below, or the disclosed
connector fallback in the VM write-path section when that transport is unavailable; neither relaxes the
ceremony's authorization, and there is no `--force`. Its durable comment says the clearance was a HUMAN CEREMONY, not an established-independent
review — never describe it as the latter.

**A self-cleared verdict (#2844).** `--answer=accept` also refuses when the clearing actor is provably the PR's
author. The id is `CLAUDE_CODE_SESSION_ID` and a subagent inherits its parent's, so a PR your session opened is
a self-clear by that measure. Two routes, both above the board: the human ceremony, or running the review from a
session that did not open the PR. Clearing `CLAUDE_CODE_SESSION_ID` out of the environment buys nothing — it
only downgrades the record to *"Independence NOT established"*.

**Re-accepting after a rebase.** `acceptanceCoversHead` keys on head-SHA identity, so a benign rebase invalidates
an accept. Do not re-run the panel: prove the net patch is byte-identical, then re-run the operation with a body
that says so. `reviewed-contribution` (#x9xqexm) already covers pure base movement.

**A host that cannot authenticate to GitHub — record through the guarded transport (#xrk6hmj).** On a
cloud VM no local process holds a GitHub credential, so `record`'s label-swap effect's shell-out to
`we:scripts/review-set-label.mjs` fails and the verdict has to travel as a file on the `ops/review-requests`
branch, which `we:.github/workflows/apply-review-request.yml` applies with the real CLI. That transport has a
caller now — use it, and use the SELF-SUFFICIENT one (#3540):

```
node scripts/operations/record-verdict-cli.mjs --runId=<run-id> --to=accepted|changes|clear-human [--operatorInstruction="<quoted instruction>"] --json
```

**Use `record-verdict-cli.mjs`, not the bare `run.mjs record-verdict`, on a host with no `gh` (#3540).** Before
this, the write-up `record-verdict` needs was staged ONLY by `review-pr`'s own `record` step — bundled with the
`gh`-needing label swap — so reaching it meant a separate, manual `review-pr --resume=<runId> --answer=accept`
first, which then halted on the label swap it could never complete: a clean, agent-reviewable accept recorded
as an indistinguishable `effect-halted` run. `record-verdict-cli.mjs` answers `review-pr`'s `confirm` and stages
its write-up (`stageVerdict`, the local half — no `gh`) as part of THIS SAME call, so `--runId=<run-id>
--to=accepted` is the whole thing: no prior `review-pr --resume` of your own. (`run.mjs record-verdict` still
works exactly as before for a host that already has the write-up staged some other way — e.g. re-recording a
verdict whose `review-pr` run already completed `record` in full.)

**There is deliberately no `--pr`.** The subject, the repo, the juror's session id and the staged write-up are
read back out of the run record the review itself wrote, because the failure mode here is not tedium — it is
retyping. A hand-assembled request restates the PR number in a fresh `JSON.stringify`, and a wrong one records
your verdict on somebody else's PR while every artefact still names yours. That is the class #1466 closed on the
reading side; this closes it on the writing side. Do not hand-roll the JSON, and do not `git checkout` the
transport branch over your lane — the operation pushes through its own worktree precisely because doing it by
hand takes your uncommitted work with it.

It refuses rather than inventing: a run that produced no verdict, a run that is not a review, and a run that
genuinely staged no write-up are all refused, because each would put a request on the transport branch
indistinguishable from a real review. The refusal now names WHY the write-up is missing (#3540) — a deliberate
`abstain`, a `confirm` that still needs an answer, or (unreachable in the ordinary case) a genuine defect — so
it no longer reads as "the review was defective" when a clean review simply had not been recorded yet.
`--to=clear-human` still carries every constraint of the ceremony above — the instruction goes in
`--operatorInstruction`, verbatim, and the applier refuses the target without it, and it names no `review-pr`
confirm answer, so `record-verdict-cli.mjs`'s pre-pass never touches the review-pr run for it.

## Invariant

A **`review:human` PR is never agent-cleared.** The core may render an advisory take; the `review:accepted` label
on such a PR is applied only by a human, via the ceremony above. Since #2771/#2785 (statute
[`#review-human-declarative-leash-only`](../../docs/agent/platform-decisions.md#review-human-declarative-leash-only))
`humanRequired` fires on the **declarative leash** plus any statute edit; the gate's derivation code parks
`review:pending` for the independent committee instead. Read the label, never infer "this needs me" from the
fact that a PR touches gate machinery.

## Independence is about the ACTOR, not the git login (#2439)

In a solo constellation every PR's git login is the same PAT, so login identity is a **useless** independence
signal — do not gate on it and do not warn the operator that "this is your own PR". What matters:

- **An agent must not clear a diff it produced.** Spawning your own review subagents does not make you
  independent. Review your own working diff before the PR (`/code-review`); never relabel a PR **you** authored.
- **A human clearing an AI-lane PR is exactly the independence — clear it without hesitation.** Raise no
  author-self-accept caveat.
- **…but the machine check is coarser than that judgement**, per #2844 above. Take the refusal at face value and
  use a route, never a workaround.
