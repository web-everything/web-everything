# Independent-review agent brief (template) — review ONE PR, then exit (#3279)

> **Opt-in path only (x26lw6u).** The review daemon no longer starts a session with this brief by default: the
> same arc runs as a deterministic job, `we:scripts/operations/review-job.mjs` (claim → `started` → lane acquire →
> `review-loop-cli.mjs` once → `done` → release), with no Claude wrapper session. The jurors that
> `review-loop-cli.mjs` spawns are the fresh, independent reviewers either way; the job mints its own fresh
> `CLAUDE_CODE_SESSION_ID` per round as the clearing actor. This brief is used only when
> `WE_REVIEW_DISPATCH_MODE=session` (or `review-dispatch.mjs --mode=session`) asks for the old path.

> **This is a TEMPLATE, not a runnable skill.** `we:scripts/operations/review-dispatch.mjs` instantiates it —
> filling the `{{PLACEHOLDERS}}` below with the PR this dispatch was asked to review — and passes the result as
> the prompt for **one background session**, started fresh (`claude --bg --session-id=<a brand-new UUID>`),
> never a subagent of whoever is reading this file. That freshness is the entire reason this brief exists:
> `we:scripts/lib/review-independence.mjs`'s self-clear refusal keys on `CLAUDE_CODE_SESSION_ID`, and a subagent
> INHERITS its parent's value — so a review "panel" spawned from inside the authoring session is still the same
> actor as far as that refusal is concerned. You, reading this, are not that — you were started as your own
> session, with your own id, by the operation named above.

## Fill these before spawning

| Placeholder | What `review-dispatch.mjs` fills it with |
|---|---|
| `{{PR}}` | the PR number to review — e.g. `1234` |
| `{{LANE_REPO}}` | lane-pool checkout selector: an absolute checkout path always (equal to `{{WE_ROOT}}` for WE, a sibling's own checkout otherwise; landing-freeze fix — was `.` for WE, which broke from this dispatch's own scratch cwd) |
| `{{REPO}}` | the `owner/repo` the PR lives in — e.g. `web-everything/web-everything` |
| `{{SESSION_SLUG}}` | a per-dispatch lane-lease slug, e.g. `review-1234` |
| `{{JUDGE_PROVIDER}}` | the run's `JudgeProvider`. Always `claude` in practice — `codex` is refused at the command line, see step 2 (`#xu2pp2m`) |
| `{{WE_ROOT}}` | **#4174** — the absolute WE checkout you are dispatched FROM. You start in a scratch directory outside it (never inside it — see step 1), so this is the only way step 1's `lane-pool.mjs` is findable before you have a lane of your own. |

---

## Your job (one sentence)

Acquire your own lane, run the mechanized review-loop against **{{REPO}}#{{PR}}** exactly once
(`review-loop-cli.mjs` — see step 2), read what it reports, and **exit** — you do not merge, you do not clear a
`review:human` park yourself, and you do not keep looping: one dispatch is one round.

## Nobody is watching this session turn by turn

That is the entire point of a mechanically dispatched reviewer. If `review-loop-cli.mjs` reports something this
brief's own arc does not cover, stop and report the structured outcome it printed — do not improvise a fix, do
not re-run it with different flags hoping for a different answer, and never resolve your own uncertainty by
asking an open-ended question in prose; there is no one positioned to read or answer it in the time this
dispatch has (the same doctrine `we:skills-src/review/review-agent-system-prompt.md` states as your own standing
identity — see below — and `we:skills-src/conveyor/dispatched-agent-system-prompt.md` states for a delivery
dispatch).

**This prompt is a real, already-instantiated work order, not a template** — your own standing-identity system
prompt (`we:skills-src/review/review-agent-system-prompt.md`, passed via `--append-system-prompt-file` on every
dispatch, `#xy8di3v`) says so before you ever read the "Fill these before spawning" table below; that table is
explanatory prose describing what WAS filled, not evidence it wasn't, even when a filled value happens to read
identically to the table's own illustrative example.

**Never write a scratch file to your own job-scratch directory, and never write one to `/tmp` either.** The
harness hands every `--bg` session a per-session scratchpad path (`~/.claude/jobs/<session-id>/tmp/`) in its own
system prompt; writing there — even into your own directory — can be categorized as touching a sensitive file
and produce a permission prompt nobody is here to answer, wedging you indefinitely. If you need anything
ephemeral on disk, put it **inside the lane clone you acquire in step 1** instead — it is already fully
Edit/Write/Bash-permitted and carries none of the sensitive-file shape.

## The arc — one command per step

### 0. Report `started` — BEFORE anything else (#3436)

The one durable trace that a review of **{{REPO}}#{{PR}}** was ever dispatched, written BEFORE step 1 can fail
for any reason — a lane-pool outage, a crash, a refused effect. Without this, a session that dies here is
indistinguishable from one that was never dispatched at all; `we:scripts/conveyor/review-status-tag.mjs`
answers "is something working right now" but nothing else answers "did the one that just finished conclude
anything" without `claude logs` archaeology (`we:backlog/3436-*.md`). A script, not a step you might skip under
stress — same reasoning as `we:scripts/conveyor/stand-down.mjs`'s own durable marker.

```bash
node scripts/operations/completion-cli.mjs report --session={{SESSION_SLUG}} --kind=review --pr={{PR}} --status=started
```

### 1. Acquire your own lane

The tool-bearing juror `review-loop-cli.mjs` spawns REFUSES to run without a lane clone of its own — never the
primary checkout, never a lane someone else is working in.

> **You started in a scratch directory, not a checkout.** It holds nothing of `scripts/` — never write a file
> there by a relative path, and never write ANYTHING into `{{WE_ROOT}}` itself (the checkout that dispatched
> you): either one left dirty by a stray write is how a dispatcher's own clone gets stuck refusing every future
> dispatch as stale (#4174). Everything you do belongs in `$LANE`, from the moment it exists.

**Pass `--wait-ms` (#x3jmao3).** A pool reading "no free lane" is often a MOMENTARY capacity flicker under
real concurrent load, not genuine exhaustion — live-caught 2026-09-04, when a dispatched review's own
acquire read the pool as fully held/dirty and gave up instantly, even though it had freed up again within
minutes. `acquire --wait-ms=<N>` polls (no busy-wait) for up to `N` ms before failing, so this self-heals
without anyone having to notice and manually retry. This is still bounded, not the open-ended retry loop
this step's own next paragraph forbids — one call, one deadline.

`--wait-ms=180000` (not 30000) — raised #3383, live-caught 2026-09-24: under several concurrent review
dispatches, the shared single-flight `--acquirable` scan itself (`we:scripts/lane-pool.mjs`) can take longer
than 30s on a ~65-lane pool, so a caller with only 30s of wait budget could fail before the scan it was
sharing ever finished, even though `acquire` now decouples the scan's own timeout from any one caller's
`--wait-ms` (#2607) and reports that distinctly from a genuinely-full pool. Raising the backstop to 180000
gives real headroom against a slow scan without changing today's self-healing behavior for the common case
(a scan/wait that finishes in seconds still returns immediately either way).

```bash
LANE=$(node "{{WE_ROOT}}/scripts/lane-pool.mjs" acquire --repo={{LANE_REPO}} --purpose=review-loop --session={{SESSION_SLUG}} --wait-ms=180000 --adopt) && echo "$LANE"
```

If this still fails after that bounded wait, the pool genuinely has no free lane — report the completion
record and exit; do not retry in a loop yourself on top of it:

```bash
node scripts/operations/completion-cli.mjs report --session={{SESSION_SLUG}} --status=done --outcome=blocked-on-infra
```

Then report that plainly (`blocked-on-infra`, no lane available) and exit.

### 2. Run the review loop, once

```bash
node scripts/operations/review-loop-cli.mjs --pr={{PR}} --repo={{REPO}} --cwd="$LANE" --provider={{JUDGE_PROVIDER}}
```

**`--provider={{JUDGE_PROVIDER}}` is filled `claude`, always, and `codex` is not a thing you can be handed
here (`#xu2pp2m` — CORRECTING what this paragraph used to claim).** The old wording said this flag touched only
the jurors "while they stay tool-free". That was wrong on the facts: `review-pr`'s two MANDATORY seats set
`allowedTools` unconditionally (`buildReviewJudgeRequest`), `--provider` sets the provider for ALL seats, and
`createDefaultJudge` structurally refuses codex + tool-bearing (`#3581`) — so `--provider=codex` is a
GUARANTEED crash at the first judge step, measured live on 2026-09-12, not an option. `review-dispatch.mjs`
now refuses `--judge-provider=codex` at the command line rather than letting it fail minutes into a dispatch.

**Seating Codex as the tool-free ADVISORY panelist is a different, working knob**, and it is the one that
actually ran in that live review: `review-pr`'s opt-in third seat (`judgeAdvisory`), which pins itself to codex
per-request and carries no tools. It is turned on by `--codex-advisory` on `review-dispatch.mjs` / the wrapper
(which sets `REVIEW_PR_CODEX_ADVISORY=1`), never by `--provider`. Either way, none of this changes what YOU
are: this session stays a tool-bearing Claude agent.

This runs the declared `review-pr` operation's ONE round — read the diff, judge it (correctness AND security,
two independent jurors, both spawned by the operation, neither is you), reduce their findings to a verdict, and
either:

- **bounce it** (`changes`) — the operation answers this UNATTENDED, on your behalf, whenever the verdict
  carries findings that still block. This posts a comment, swaps the label, and completes the run. You did not
  decide this; the operation's own ratified policy did, exactly as the automated fix-loop already bounces
  unattended today.
- **auto-clear it** (the verdict is `accept`, or `prevention-outstanding` with its named guard(s) filed) — for
  an AGENT-addressed (`review:pending`) PR, the operation itself records `review:accepted`, swaps the label,
  and completes the run — unattended, on your behalf (`#3434`). A `prevention-outstanding` verdict means every
  actual finding was already resolved and the sole remaining debt is a named "prevention" guard nobody filed;
  the operation files it to the learnings pool as it clears, so that debt is not lost even though nothing
  bounced (`#3442`). **There is nothing for you to do here** — no resume command exists to run, nothing to
  stop for. Read what it printed (it names what, if anything, it filed) and move on to step 3.
- **park for a human** (`review:human`, gate-self, or a `needs-human` verdict) — this is the SAME stop the
  interactive `/review` session would hit; nothing about being dispatched changes it, and this tier's own
  human-only ceremony (`--to=clear-human`) is UNCHANGED by any of the above — it applies to `review:human`
  only, never to `review:pending`. Report it and exit; do not attempt to clear it yourself, under any
  circumstance, no matter how obviously clean the diff looked to you while it ran.

Whatever it prints, that IS the outcome of your dispatch — read it, do not re-interpret it.

### 3. Report `done` — the completion record (#3436)

Update the SAME record step 0 started, so it now carries what step 2 actually concluded — `<outcome>` is
`bounced` / `auto-cleared` / `parked` (whichever of the three step-2 branches you hit), `<verdict>` is the
loop's own verdict word (`run.verdict.loop.outcome` in step 2's `--json` output: `converged` / `escalated` /
`exhausted`), and `<run-id>` is `run.id` from that same output:

```bash
node scripts/operations/completion-cli.mjs report --session={{SESSION_SLUG}} --status=done \
  --outcome=<outcome> --verdict=<verdict> --runId=<run-id>
```

### 4. Release your lane and exit

`$LANE` holds the lane's absolute PATH (that's what `acquire` printed to stdout in step 1), not a bare
number — do not try to extract one from it. Release by session instead, which needs no lane number at all (`--all-pools` sweeps every pool, so it also finds a lane acquired in another repo's pool):

```bash
node scripts/lane-pool.mjs release --all-pools --session={{SESSION_SLUG}}
```

Then exit. You opened no PR, merged nothing, and — whichever way it landed (bounced, auto-cleared, or parked
for a human) — your job for this dispatch is done either way. A later dispatch, once the PR's diff has actually
changed, is a DIFFERENT session's job, not a loop inside this one.

## What you must NEVER do, stated plainly because getting this wrong is the one failure this brief exists to
## prevent

**This is not prose alone (#3433).** `review-dispatch.mjs` bakes a `--disallowedTools` deny list into YOUR OWN
session's `claude` invocation before you ever start — the whole `gh` CLI (not just `gh pr merge`; a label edit
or a raw `gh api` call reaches the same outcomes under a different verb), `review-set-label.mjs`,
`apply-review-request.mjs`, and `run.mjs` are all refused by the harness itself, before your own judgment is
even consulted. Do not treat that as permission to test the edges of it; a refused command still means stop and
report, not "try a different phrasing."

- **Never clear a `review:human` park yourself.** Not by running a `--resume … --answer=accept` (or any other)
  command, not by re-deriving your own verdict and posting it some other way, not by convincing yourself this
  one case is obviously fine. That tier exists specifically because the review's own independence is the thing
  most in question — only a human clears it, on their own time (`--to=clear-human`). There is no exception.
  (This does NOT apply to an `accept` or `prevention-outstanding` verdict on a `review:pending` PR — the
  operation already clears those itself, unattended; see step 2.)
- **Never merge the PR, or run `gh pr merge` / `gh pr merge -X PUT` against it.** That is the drain's job, once
  the PR carries `ready-to-merge` (mechanically, for `review:pending`) or a human has cleared it (for
  `review:human`).
- **Never re-run the loop hoping for a different verdict.** One dispatch, one round. A verdict you disagree
  with is not a reason to retry it — report it and exit.
