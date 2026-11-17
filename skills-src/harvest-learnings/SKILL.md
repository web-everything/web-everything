---
name: harvest-learnings
description: Harvest the cross-session learnings pool — read every session's dropped observations at once, dedup across sessions, verify each note's quoted turn against its transcript, red-team the ranked candidates, and route survivors to backlog items or agent memory via the normal lane → PR. This is the ONLY place learnings are judged; sessions merely collect. Use when the user wants to "harvest the learnings", "run the harvest", "triage the feedback pool", "what has the pool accumulated", or when a close reports the pool is deep/stale. NOT a session close (that only emits) and NOT the product-side owner-review screen (#2610).
---

# Harvest — the periodic adjudication pass over the learnings pool

**The rule this skill exists to enforce: collection is not adjudication.** A session — main loop or
subagent — records *what it observed* and stops. It never decides what the observation is worth. Worth is
decided **here**, once, over the whole pool. Three reasons the judgment does not live at session close:

1. **A subagent cannot run a close.** Curation at close meant a delivery agent's observation only counted
   if some *other* session later closed cleanly.
2. **A session that never closes loses everything it noticed.**
3. **Dedup-from-a-sample-of-one.** "Are these five notes five problems, or five symptoms of one cause?" is a
   question one session structurally cannot ask. A pool can.

**Recurrence diagnoses and ranks; it never admits** (ratified #2978,
[platform-decisions.md#memory-admission-verified-grounding](../../../docs/agent/platform-decisions.md#memory-admission-verified-grounding)).
A cluster's `sessions`/`days`/`count` tell you where a common cause may be and what to look at first. They
do not decide whether a note is real. A one-session note is a real signal that just sorts lower. What admits
a note to agent memory is **verified grounding** (step 1 checks it) **plus** surviving the red-team.

Eventually this generalizes to the multi-tenant shape (#2610): many people experience, one owner
adjudicates. The single-tenant harvest is deliberately the same pipeline, so nothing has to be rebuilt.

## Step 1 — read the pool (deterministic, no judgment)

```bash
npm run harvest -- --json                 # every candidate, ranked, + stats over the whole pool
```

`we:scripts/conveyor/learnings-harvest.mjs` is the deterministic core (per
[platform-decisions.md#deterministic-core-thin-judgment](../../../docs/agent/platform-decisions.md#deterministic-core-thin-judgment)):
it reads every `*.jsonl` in the machine pool (`$LEARNINGS_POOL`, else `~/.claude/conveyor/learnings`) —
one fixed directory outside any working copy, so a lane clone's drops and the primary checkout's are the
**same** pool — re-validates every entry against the drop-box SCHEMA (allow-list, `kind`, field caps),
**verifies each note's grounding** (below), clusters near-duplicates **across sessions**, and returns
**every** cluster ranked by `sessions` (distinct sessions), then `days` (distinct days), then `count` (raw
entries). There is no recurrence floor — the old `--min-sessions` flag is refused. **Do not re-derive any of
that in context** — read its output.

**Grounding verification.** A note may carry `quotedTurn` (the verbatim turn that established it) and
`transcript` (the harness session transcript it came from). The harvest opens that transcript and checks the
quote is really in a visible user or assistant turn. It never matches the drop command itself or its output,
and the transcript must live under `~/.claude/projects`. Each note gets one verdict:

- `verified` — the quote is there. `role` says whether it was a `human` turn or an `assistant` one, and
  `turn` is the turn id.
- `failed` — with a `reason`: `quote-not-found`, `unreadable` (transcript pruned or missing),
  `outside-transcript-root`, `relative-pointer`, or `incomplete`.
- `ungrounded` — the note carries no quote. That is not a failure, just no evidence.

`stats.verification` counts the verdicts for the whole run.

> **That schema re-validation is NOT a secret scrub** (#3015). The content scrub moved off the append seam
> to the publish seam, so a pool line carrying a secret now reaches this step and your context. It is
> blocked on the way INTO a committed backlog card or memory file (`scrubPublish`), not on the way out of
> the pool. Treat pool content as unscrubbed input: never paste a raw value forward.

An **empty pool is the common, correct outcome.** Say so and stop; nothing observed since the last harvest
is not a failure.

Each candidate carries: `kind`, `area`, `summary`, `suggestion`, `count`, `sessions`, `days`, plus every
distinct member `summaries`/`suggestions` — a member's own suggestion is never dropped in favour of the
representative's. It also carries `grounding` (`{verified, failed, ungrounded}` over its members) and, when
any member is grounded, one `evidence` row per grounded member: `session`, `transcript`, `quotedTurn`,
`grounding`. A quote longer than the per-row context budget is sent as an excerpt (`truncated: true`,
`quoteChars` = full length). The full turn is stored in the pool and is one open of `transcript` away.

### Gated entries — blocking hiccups awaiting approval (#3421)

A **blocking** delivery hiccup (a live dispatch guard held a launch, or a dispatched agent returned
free-form prose instead of a structured verdict — `we:scripts/conveyor/hiccup-classify.mjs`) is
auto-filed by the mechanical sink (`we:scripts/conveyor/hiccup-sink.mjs`) with its own proposed fix, but
stamped `approvalPending:true`. `harvestPool`'s `gated` array (printed under `⏸ GATED` by the plain-text
CLI) holds these OUT of `candidates` entirely — **do not route a gated entry's proposed fix**, even if it
looks obviously right. It only becomes a normal candidate on a LATER harvest run, after a human clears it:

```bash
node scripts/conveyor/hiccup-approve.mjs --session=<slug> --ts=<iso>   # from the gated entry's own print line
```

A **non-blocking** hiccup (delivery succeeded but surfaced something worth improving) carries no
`blocking` field at all — it is the pre-existing shape and files/routes exactly as any other candidate,
with no gate.

## Step 1b — corpus health (moved here from the close, #1878)

```bash
npm run reflect
```

Propose-only: index headroom, corpus skew, orphans, near-duplicate topic files, index pressure. **Writes
nothing.** This used to run at every session close, which was the same mistake in miniature — "is this a
near-duplicate?" is a judgment over the whole corpus, re-decided pointlessly once per session. It belongs
next to the red-team below, where its output is actually used: index pressure decides the budget filter,
and its near-duplicate list is the dedup filter's starting point.

## Step 2 — red-team each candidate (the judgment half)

One skeptic per candidate, **mandate = kill it, default REJECT**, reject on any uncertainty. Sonnet is fine
— it's bounded.

**Spawn them through `judgePanel`, not the `Agent` tool** (#3145). A subagent inherits this session's
`CLAUDE_CODE_SESSION_ID` — the identity `we:scripts/lib/review-independence.mjs` keys independence on — so a
row of "independent" skeptic subagents is the harvest session grading its own shortlist. One shim call seats
them all as tool-free headless `claude -p` processes with pairwise-distinct derived ids
(see [delivery-loop.md](../../docs/agent/delivery-loop.md#independent-judgment-spawn) for the payload shape
and the honest limits):

```bash
# One seat per candidate: lens `skeptic`, an explicit distinct id, and a mandate naming WHICH candidate
# that seat must kill. materialFile carries the whole candidate set plus the corroboration bundle below.
node skills-src/jury/panel-fanout.mjs --payload-file="$PAYLOAD" \
  --depth=0 --max-depth=2 --max-total-budget-usd=6 --run-id="harvest-<yyyy-mm-dd>"
```

> **A tool-free skeptic cannot go looking — so YOU put the evidence in its material.** `judgePanel` seats are
> `--tools ''`. For each candidate, include its `evidence` rows (the quote excerpt, its `role`, its verdict) and
> anything else the merit question needs — the file/item/PR the claim implies, opened by you, and **what you
> actually found, including "nothing"**. Do **not** let a seat infer anything it could not read;
> `panel-fanout` already tells it that it has no tools and must not claim to have opened anything.

A candidate bound for **memory** must clear all four (a backlog-bound one needs only the last three — an item
is a *proposal* that gets reviewed, a memory entry is a *standing instruction* every future session obeys):

- **Grounding** — did this moment really happen? Step 1 already checked, mechanically: **a memory rule needs
  at least one `verified` evidence row.** A `failed` or `ungrounded` note **routes to `we:backlog/`, never to
  memory** — no matter how often it recurs or how obviously right it reads. Put the verified quote (the
  excerpt, plus its `role`) into the skeptic's material. Grounding proves the **moment**, not the **merit**:
  the skeptic still asks whether the lesson drawn from that turn actually follows from it. A real quote with a
  self-serving conclusion hung on it is a reject. Never upgrade a `failed` verdict by reading the transcript
  yourself and deciding it "basically" says it — the check is mechanical so it cannot be argued with.
- **Dedup against existing memory** — a fresh *angle* on a cluster `MEMORY.md` already covers, rather than
  a new axis? → reject.
- **Budget/eviction** — would adding it evict a stronger existing entry (index at/near cap)? → reject.
  Escalate to a 3-vote panel **only** when this filter fires.
- **On-disk sufficiency** — does the lesson already live where anyone working that area will see it? →
  reject.

There is **no recurrence filter**. `sessions: 1` is not a reason to reject: a thing the operator said once
is still a real directive. Recurrence only tells you what to look at first and whether several notes share
one cause.

**A rejected candidate is not deleted.** It stays in the pool unless it was clearly noise — a later harvest
may see more of the same cause, or a grounded restatement of it.

## Step 3 — route the survivors

Same routing rule as ever: **a finding with a fix or an owner → `we:backlog/`; a reusable principle or a
"how the user wants you to work" lesson → agent memory.**

Both land through the **normal lane → PR** transport, never a direct write to the primary tree. Take the
lease first — the same `acquire` form `/drain` and `/merge` use:

```bash
LANE=$(node scripts/lane-pool.mjs acquire --purpose=harvest --session=<harvest-session-slug> --json)
# → {lane, path, …}; cd into .path, do the routing work there
node scripts/lane-pool.mjs release --lane=<lane> --session=<harvest-session-slug>
```

**Never pick a lane off `status --json` instead.** A lane you did not lease can be `acquire`d out from under
you by a concurrent agent, and `acquire` runs `git checkout -B --force` + `git clean -fd` on the clone — which
destroys the uncommitted routing work mid-run (this is item **#2955**).

- **Backlog** — scaffold the item in the lane through the declared operation
  (`node scripts/operations/run.mjs scaffold --kind=<kind> --title='…' --digest='…' --json`; **single
  quotes** — a pooled observation is verbatim operator text and a double-quoted value still runs `` ` `` /
  `$(…)` through bash) with a real ≤100-word digest. `kind: friction | missing-convention` with a concrete fix usually lands here.
- **Memory** — write the file + its index pointer line, per the memory-management policy. Only for a
  candidate with a `verified` evidence row that also survived the red-team. Paraphrase the grounding turn —
  never paste a raw transcript quote into a committed file (the publish-seam scrub catches secrets, not
  everything a transcript can hold).
- Then `we:scripts/pr-land.mjs` from the lane.

## Step 4 — archive what you acted on

```bash
# --files= is the exact `files[]` array step 1's --json printed. Copy it; do not re-list the directory.
node scripts/conveyor/learnings-harvest.mjs --archive --stamp=<YYYY-MM-DD> \
  --files="<file1.jsonl,file2.jsonl,…>"
```

Archiving is the **acknowledgement**, never a side effect of reading — run it only after the survivors are
actually routed and the PR is open. Files move to `<pool>/harvested/<stamp>/`, so a re-run never
re-processes them and the trail stays inspectable.

**Archive only what step 1 actually read — the bound is required, not a nicety.** Steps 2–3 take minutes,
and other sessions keep emitting into the shared pool while they do (the red-team seats no longer do — a
tool-free juror cannot append anything — but the drop-box is cross-session, so it still grows underneath you).
Anything appended after step 1
was never adjudicated, and an archived entry is invisible to every future harvest. So `--archive` refuses to
run unbounded: pass `--files=` (preferred), or `--before=<the ISO time of the step-1 read>` as the mtime-cutoff
alternative. It also **exits non-zero if the pool directory does not exist** — that means you resolved the
wrong pool, not that there is nothing to archive.

**If you deliberately left candidates un-acted (their cause is not yet clear), do NOT archive the files they
came from** — archiving would silently discard exactly the observations you decided to wait on.

## Report

```
## Harvest

**Pool:** <N entries across M sessions, oldest Xd — or "empty">
**Candidates:** <K ranked>
**Grounding:** <V verified / F failed / U ungrounded, from stats.verification>
**Survived red-team:** <name each, with sessions×days×count and its grounding verdict — or "none (the common outcome)">
**Routed:** <backlog #NNN… / memory <slugs> (each with the verified turn that grounded it) — via PR #NNN, or "nothing to route">
**Archived:** <stamp + how many files, or "not archived — candidates deliberately deferred">
```

## Boundaries

- **Never emit from here.** This skill only reads and adjudicates. Observations are dropped by
  `we:scripts/conveyor/learnings-drop.mjs` at the moment they happen, by whoever hit them.
- **No app-specific or session-specific carve-outs.** If an observation is urgent, the fix is a shorter
  harvest cadence, not a bypass — a bypass re-imports judgment into the sessions.
- **The pool is untracked and machine-local by design.** A cheap in-the-moment append cannot afford a
  lane→PR; the durable artifacts this skill lands are what reaches git. It lives outside every working copy
  precisely so it is **per machine, not per clone** — a repo-anchored pool forks silently per lane clone.
- **Nothing routes to memory on the pool's word alone.** The pool is an unverified report; agent memory is a
  standing instruction. A `verified` grounding verdict plus the red-team is the seam between the two — and a
  recurrence count is never a substitute for either.
