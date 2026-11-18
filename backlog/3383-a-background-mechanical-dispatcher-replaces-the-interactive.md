---
bornAs: xyv0vbz
kind: epic
parent: "3029"
status: active
dateOpened: "2026-08-28"
dateStarted: "2026-08-31"
costTokens: "in:5840 cw:6690099 cr:1085684841 out:1965741"
costUsd: 658.92
costSessions: 9
tags: []
---

# A background mechanical dispatcher replaces the interactive session as delivery supervisor

## The problem, stated plainly (2026-08-27/28, the operator's own words)

"The big problem at the moment is that much of this is handled by a costly session that is getting
super large, keeps forgetting its context and cost a lot." Delivery work — dispatching fixers and
reviewers, watching PR state, clearing stuck labels, healing CI — has run through one long
interactive session. That session IS the single point of failure: expensive per turn, its own
context degrades as it grows, nothing continues if it isn't open. `we:scripts/operator/converge.py`
(PR #1669) already proves most of the individual mechanisms work; what's missing is running them
without a person driving every step.

## The target shape (the operator's own spec)

- The session's role narrows to **queueing work** and **being notified of blocked items that need
  a person** — not driving routine progress turn by turn.
- A **mechanical dispatcher** owns queuing and capacity: it decides what runs now based on
  available capacity, not an agent's guess.
- **Subagents only edit code.** Every command they'd otherwise run themselves is delegated to the
  mechanical layer, which queues it and reports the result back — an agent never blocks waiting on
  its own shell command; it hands off and gets told the outcome.
- A **supervisor watches every agent** — progress, whether it's blocked, whether it's on track —
  and surfaces exactly that to whoever's queueing work, without anyone polling.
- Escalation is the exception path, not the default: most cases resolve mechanically (see
  `#3379`'s sibling cards — the stale-label clear, `ci:failed` healing, the ordering bug behind
  `#1659`'s stranding, the headless-reviewer polling fix); only genuinely novel cases reach an
  agent or a person at all.

## How to build it (the operator's own sequencing — deliberately NOT incremental-merge-from-day-one)

This is the opposite build strategy from `#3379`'s already-landed pieces, deliberately: those were
individually proven, low-risk, and graduated to `main` immediately. This is different in kind — an
unbuilt queue/dispatch/supervision system, not yet proven at all. Build and refine it in a
dedicated branch, alongside whatever else lands, WITHOUT the per-commit review tax that would slow
down free iteration on a design that doesn't exist yet. Once it is genuinely stable — proven over a
long stretch of real use, the way `converge.py` itself was proven tonight — split it into small,
individually reviewable pieces and move them to `main` the normal way, one at a time. Only once
everything has transferred does the real system execute from `main` instead of the branch.

**The one caveat that must not get lost in that plan:** a branch does not make the system's ACTIONS
safe, only its CODE unreviewed. The moment this dispatcher runs for real — even from a branch, even
before any of its code has landed — it is taking real actions against real PRs and real shared
state, exactly as `converge.py` already did all of tonight. "Not yet merged" is not the same
guarantee as "not yet running." Whoever builds this owes the same care to what it's allowed to
touch unattended as to the code itself, from the first real run, not just at graduation time.

## Standing doctrine — now lives in the `mechanical-delivery-doctrine` skill

> **The standing operating rules for driving this epic's machinery now live in
> [we:skills-src/mechanical-delivery-doctrine/SKILL.md](/skills-src/mechanical-delivery-doctrine/SKILL.md).**
> This stub exists so a session picking this epic back up reads the doctrine first. The skill holds
> the nine distilled, load-and-follow rules; this card keeps the full rationale for each (the
> "Working doctrine (...)" sections below) plus the chronological session-update history the skill
> does not duplicate — the skill cites back to those sections by name for the "why." Edit the skill
> when a rule itself changes; add a new "Working doctrine" section here (and port its distilled form
> into the skill) when a new rule is set.
>
> Deliberately a separate skill from `/conveyor` (`#2612`/`#2613`) — see the skill's own closing note
> for why, and when the two should merge.

## Why this card exists, not more work in the session that wrote it

This session is itself an instance of the problem this epic describes — large, deep into
compaction, expensive per turn. Building the actual dispatcher here would extend the exact pattern
this epic exists to end. Filed so a FRESH session — full budget, none of tonight's accumulated
context to carry — can pick this up and build it properly.

## Done when

1. A background process (not an interactive session) can run at least one real PR through a full
   fix → review → land cycle with zero interactive-session turns inside the loop.
2. A blocked/escalated case reaches a person or a fresh agent via an explicit notification, not
   because someone happened to poll and notice.
3. `we:scripts/operator/converge.py`'s already-proven mechanisms (independent review dispatch via a
   separate process id, `ci:failed` classification, stale-label recovery) are either subsumed by
   the new dispatcher or explicitly superseded by it — not left running in parallel indefinitely.

## Session update (2026-08-28, continued session) — five pieces built and tested, still unlanded

A follow-on session (same day) picked this back up and built five pieces toward the target shape
above, all individually unit-tested and smoke-tested against real subprocesses (not mocks) —
`check:standards` clean, 1300+ tests green as of last verification. Nothing below is landed to
`main`; it sits committed in lane-11 (`/Users/nicolasgilbert/workspace/.lanes/web-everything/lane-11`,
5 commits behind `origin/main` as of this update), deliberately, per this card's own "How to build
it" section above.

1. **Session-identity fix (#3331, resolved)** — `claude --bg` proven to ignore `--session-id`; the
   observer now reads the real handle off the CLI's own `backgrounded · <id> · <name>` stdout line
   instead. Touches `we:scripts/operations/dispatch-lane-io.mjs`, `we:scripts/operations/explore-io.mjs`,
   `we:scripts/operations/wake.mjs`.
2. **`we:scripts/operations/dispatch-lane.mjs` widened to `fix`/`ci-heal` launch kinds** — reuses
   the build-dispatch machinery.
3. **`we:scripts/operations/route-pr-outcome.mjs`** — new declared operation, thin wrapper over the
   existing `deriveReviewDisposition`, read-only, no sink — closes the gap where nothing under
   `scripts/operations/*.mjs` reached the escalation-disposition logic.
4. **`we:skills-src/conveyor/runner.mjs` now actually calls `dispatch-lane`** per surfaced decision,
   instead of only printing what it would do — the mechanization this epic's "Done when" #1 needs.
5. **`we:skills-src/conveyor/supervisor.mjs`** — a new resident process that keeps the runner above
   alive (restart on crash, backoff, JSONL log), roughly half the size of the `plateau-app`
   drain-daemon precedent because the runner already owns the hard parts. **Nothing installed to
   launchd** — deliberately left as code only; deployment is a separate, later call.

A smaller side-decision surfaced and closed independently during this work: decision #3384
("chasing a moving target" — a retry-cap counter that couldn't tell staleness from a real failure,
which once cost a real PR a human closing it by mistake) went through the full
`/prepare` → independent review → ratify → resolve cycle for real and is merged (`main`, PRs
#1674, #1675). Its own recommended fix is filed but not yet built.

**Correction (2026-08-29): #3118 IS ratified.** The "What's still not done" list below originally
opened with "Decision #3118 was never ratified... the single biggest open gap." That was wrong and
is now stale twice over — #3118 resolved on `dateResolved: 2026-08-26`, ruling (c), call the
existing `dispatch-lane` operation, never a second spawn implementation, codified at
[we:docs/agent/platform-decisions.md#conveyor-dispatch-calls-the-declared-operation](/docs/agent/platform-decisions.md#conveyor-dispatch-calls-the-declared-operation).
All five pieces built in the prior session update already presuppose exactly that answer, correctly.

**What happened since the update above:** lane-11, which held the prototype, had 4 of its 5 built
pieces — the session-identity fix, `route-pr-outcome`, the runner→`dispatch-lane` wiring, and
`we:skills-src/conveyor/supervisor.mjs` — wiped by an `acquire --lane=11` re-claim after the
original lease went TTL-stale. The explicit-lane acquire path has no dirty-tree guard (a bug filed
separately). All four were recovered byte-for-byte from Claude Code's own session transcripts — the
original session's main + subagent JSONL logs, cross-checked against its file-history backup store
(10 of 12 cross-checked files matched the backup exactly) — and re-verified: 364/364 tests green,
`check:standards` 0 errors. Everything is now pushed to a durable remote branch,
`origin/lane/mechanical-dispatcher-recovered`, not just local-only in a lane clone, so it survives
any future lane reset. lane-11 itself still holds the working copy and has an occupant declared.

**What's still not done, in priority order:**

1. **The live end-to-end test.** Nothing blocks it now — #3118 is ratified and all five pieces are
   recovered and tested. Still needs: a setup decision (a scratch clone of the recovered branch,
   named anything other than `lane-N` so `dispatch-lane`'s `assertNotALaneCheckout` guard doesn't
   refuse it, rather than lane-11 itself or requiring `main` first) and picking one specific
   low-stakes backlog item to actually dispatch. The existing `-live`-named tests
   (`we:scripts/operations/__tests__/dispatch-spawn-live.test.mjs` etc.) only prove subprocess
   plumbing against a fake `claude` stand-in on `PATH`, NOT the real CLI's behavior — the real-CLI
   uncertainty #3118 flagged (whether `--bg` really discards `--session-id`, the exact
   `backgrounded · <id> · <name>` stdout shape, whether resume-by-short-handle works) is still
   genuinely unverified, and is exactly what this live test is for.
2. **Landing lane-11's five pieces to `main`** via the normal small-PR path.
3. **The stray-run-record reaper for `dispatch-lane`** (disk hygiene for the runner's own bookkeeping
   over a long-running deployment) was designed but not built — low urgency.
4. **"Done when" #2 (a notification path for a blocked/escalated case) is still open** — nothing
   built this session addresses it directly; the supervisor's JSONL log is observability, not a
   notification.
5. **Decision #3384's own recommended fix** — the `<!-- ci-heal-committed: -->` self-report marker
   on `we:scripts/conveyor/ci-heal-mark.mjs` — is still unbuilt. The decision itself is ratified AND
   resolved; only the code is outstanding. A separate, smaller thread from this epic.

## Goal-vs-filed gap sweep (2026-08-30) — what the stated goal needs that nobody filed a card for

Prior sessions' own sweeps (see the unlanded `origin/lane/mechanical-dispatcher` branch's session updates)
audited EXISTING backlog cards against current code and found stale/resolved items — a code-vs-card pass.
This run asked the harder question instead: what does this epic's stated goal (zero interactive-session
turns inside the delivery loop) require that has no card at all, across lifecycle, deployment shape,
multi-tenancy, observability, durability, cost/billing, dispatch-surface security, testing/staging, and
operator documentation. Read this card's full text (including the unlanded branch's four further
2026-08-29/30 session updates), plus siblings #3029 and #2753, end to end.

**Two categories checked and found already covered — not filed:**
- **Deployment/hosting shape** (distributed lock vs. local file lock, shared DB vs. gitignored local state) —
  fully covered by the ratified #2626 decision + tracked #2742 migration, which explicitly names
  `we:skills-src/conveyor/runner-lock.mjs`'s split (local process guard stays local; arbitration becomes a
  DO lease iff runners go multi-host) and `we:.operations/`'s file-store-behind-a-seam design, gated on the
  #2703 trigger.
- **Multi-tenancy/access control** — deliberately NOT filed. #3049 (ratified framing, not-yet verdict)
  already holds productizing the conveyor externally at "NOT-YET, pending a real customer ask"; filing
  speculative multi-tenant access-control work now would contradict that ruling, not fill a gap in it.

**Five genuine gaps filed, each checked against the backlog first (searches cited in each card's digest):**

- **#3397** — the supervisor has no reload lifecycle, only crash-restart (lifecycle/operability).
- **#3398** — the supervisor/runner has no out-of-band alerting, only a JSONL log (observability/alerting).
- **#3400** — the ratified hosted-key-billed mode has no metering/billing/auth design (cost/billing +
  dispatch-surface security).
- **#3401** — the dispatch-loop's own code is unregistered in TRUST_CHAIN, so a dispatched agent can
  weaken it via ordinary agent-clearable review (dispatch-surface security; adjacent to #2937).
- **#3399** — no operator runbook exists for running/monitoring/recovering the dispatcher (operator
  documentation).

Each names the sibling precedent it extends (#2468/#2501 for reload, #2489/#2493 for alerting, #2909/#2937
for the trust-chain gap) — this repo already solved each problem once, for a sibling resident process, and
none of those fixes were carried over to this epic's own new machinery.

**Not filed, and why:** several concrete operational findings from the 2026-08-29 session updates (the
orphaned `conveyor-*` OS session with no process reaper, the `verify-lane` TTL-vs-long-gate-run race, the
unset-`WE_DISPATCH_AGENT_ARGS` silent hang) are real but already surfaced in this card's own learnings-pool
section, explicitly awaiting a `/harvest` pass — filing them here would duplicate that already-planned step
rather than fill an unconsidered gap.

## Goal-vs-filed gap sweep, round 2 (2026-08-30) — the two categories the round-1 sweep named but never resolved

The round-1 sweep directly above lists "durability" and "testing/staging" among the categories it swept, but
neither category is actually resolved in its own write-up — no gap filed, no existing coverage cited, unlike
every other category there. This run closed exactly those two, grounded in the shipped code:

- **Data durability and crash recovery — a real, verified gap, not speculative.** `we:skills-src/conveyor/runner.mjs`'s
  in-flight/prepare/fix guard bookkeeping lives only in the runner process's own memory (`we:scripts/conveyor/tick-core.mjs`'s
  header says so explicitly: "no parallel on-disk state store is ever created"). `we:skills-src/conveyor/supervisor.mjs`
  crash-restarts a dead runner as its only recovery path, which wipes that bookkeeping. Unlike the fix/ci-heal
  retry-cap counters (proven to bind from a durable floor across a restart, `#2643`/`#2666`), the build
  in-flight guard has no durable floor — only a 3-tick in-memory TTL. A crash in the spawn-to-claim window
  reopens the exact double-dispatch already reproduced live and still open at `#3177` (two agents on #3151/
  #3150/#3154/#2972), via the new automatic-restart path rather than #3177's manual-redispatch path. Also
  flags `#2702`'s Done-when line 19, which claims "durable guard state surviving a runner restart — delivered
  in #2699"; that claim is stale relative to the shipped runner (#2699 only made tick-core pure/stateless, it
  never added persistence, and no caller built since has added it either). Filed as a new story.
- **Testing/staging story — a real, verified gap, not speculative.** This epic's own text already names the
  risk ("even before any of its code has landed... it is taking real actions against real PRs and real shared
  state"), and its own "still not done" #1 above confirms the plan: the live end-to-end test is a real,
  merely low-stakes backlog item, not a fixture. No dry-run/shadow/canary mode exists in
  `we:skills-src/conveyor/runner.mjs`, `we:skills-src/conveyor/supervisor.mjs`, or
  `we:scripts/operations/dispatch-lane.mjs` (grepped for `dry-run`/`dryRun`/`canary`/`shadow mode` — none).
  Filed as a new decision (capture-only, mirroring `#3049`'s shape — no build required to close it).

Both new cards cite the existing adjacent precedent/decision they extend or correct, and were checked against
the backlog first (search terms and negative results recorded in each card's own digest).

## Follow-up: independent verification + a blind design review (2026-08-30) — for the next session

Two more passes ran after the round-1 sweep above, per the operator's own request. **Three concrete threads,
current as of round 2 landing (#3402/#3403), so nothing here has to be re-derived:**

1. **A small fix is ready to land, verified, not yet a PR.** An independent check of round 1's five filed
   items found all five genuine and non-duplicate, but flagged that #3397/#3398/#3399 describe
   we:skills-src/conveyor/supervisor.mjs, which exists only on `origin/lane/mechanical-dispatcher`, not
   `main`. A landing-order note was added to each. **Confirmed still true after round 2**:
   we:skills-src/conveyor/supervisor.mjs, the #3390 dirty-tree guard, and the #2924 destructive-reset fix
   are all still absent from `main` as of this write-up (checked directly — `git merge-base
   --is-ancestor <fix-commit> origin/main` returns false for all three).
2. **A blind Fable review of this epic's design and goals surfaced ranked concerns, most not yet actioned.**
   Read cold (no access to any gap-sweep findings), ranked by how much it mattered to the reviewer:
   (a) escalation/notification (this card's own "Done when" #2, and the filed #3398) is under-built relative
   to how often it's already needed — a real dispatch sat `blocked` for days with nobody told; (b) in-flight
   liveness is tracked via four overlapping heuristics (tick-core's session-ephemeral state, dispatch-lane's
   run records, `claude agents --json`, lane-pool acquirability) rather than one source of truth — the same
   root cause round 2's #3403 names for the build-guard bookkeeping specifically, so #3403 is this concern's
   first concrete instance, not the whole of it; (c) **#3390 and #2924 — both already fixed and tested on
   `origin/lane/mechanical-dispatcher` — are known-good fixes for bugs that are STILL LIVE on `main`** (three
   independent close-sweeps reportedly hit #3390's bug on `main` the same day its fix sat unlanded); (d) the
   "subagents never run commands, only the mechanical layer does" doctrine is being enforced piecemeal
   (`WE_DISPATCH_KIND` in guard-bash, from #3105) without ever going through this repo's own decision
   process — captured to the learnings pool (`missing-convention`,
   `~/.claude/conveyor/learnings/note-20260830-091547.jsonl`) rather than filed directly, still pending;
   (e) the supervisor's clean-exit path gives zero restart delay (an idle-stop conveyor could busy-poll), and
   the runner's own singleton lease may not survive a long `verify-dispatch` pass, mirroring an
   already-documented lane-lease TTL race.
3. **(c) above is the one with a clock on it, and it is explicitly BLOCKED, not merely unstarted.** Landing
   #3390/#2924 needs cherry-picking two commits off `origin/lane/mechanical-dispatcher` (both isolated to
   we:scripts/lane-pool.mjs + we:scripts/lib/lane-lease.mjs per this card's own third-session update above)
   onto a fresh lane against current `main`. **Do not do this unilaterally while another session is actively
   driving this epic's own working branch** — check that session's intent first (it may already plan to
   carve these out per its own "Recommended order for the next session" list above), and re-confirm the
   branch state hasn't moved past what's described here. Note also: **#3390 and #2924 carry no `parent`
   field** — they are standalone, pre-existing items, not formally part of this epic's tree. Landing them is
   not "closing a child of #3383"; it is unblocking work this epic's own branch already depends on.

None of (d) or the #3390/#2924 land are done yet. This section exists so a fresh session doesn't have to
re-run the verification or the design review to find them again.

**Update: #3390/#2924 landed since the above was written** — `PR #1710` (`lane-pool: land #3390 dirty-tree
guard + #2924 re-verify-containment fixes`), merged. (d) — the doctrine ratification — became `#3405`,
filed under this epic, still open.

## Session update (2026-08-30, night session) — a real bug landed via dogfooding, two prior claims corrected,
## two items filed and landed, the live-fire dispatch still not attempted

Picked this back up per the operator's own framing: exercise the prototype for real before trusting it to
deliver, and treat every real snag as a machinery finding, same standing instruction as the 2026-08-29
session above.

**1. Landed `#1715`, a real, repeatedly-hit bug — not part of the dispatcher branch, but found while
assessing it.** `we:scripts/operations/open-pr.mjs`'s `HOME_REASONS` table had no entry for `enqueued`/
`labelled-on-green` (`pr-land`'s `--label-on-green` terminal reasons) — both fell to `unrun`, and the sink
threw "the PR was NOT opened" for a PR that had, in fact, opened. Hit live 7 times across 2026-08-29/30, all
in the (unharvested) learnings pool. Fixed directly rather than waiting for `/harvest`, per the operator's
own steer that this was worth fixing now. **A second bug surfaced dogfooding the fix itself**: the `/pr`
skill's own "dry-run first" step threw the same misleading error for a working rehearsal — the sink's
dry-run exemption keyed off the *request* argv, not the *reported* reason. Fixed, then independent review
(`review-pr`, correctness + security lenses, both CONFIRMED) found the first version of that fix had the
SAME class of bug the other way — keying on request argv let a genuine crash during a dry-run request go
unthrown. Fixed for real (`out.reason === 'dry-run'`), with the exact test the review asked for. Both
rounds are on `main` now (`we:scripts/operations/open-pr.mjs`, `we:scripts/operations/open-pr-io.mjs`,
`we:scripts/operations/__tests__/open-pr.test.mjs`).

**2. Correction: `#3404` is NOT live on `main`, contrary to an earlier in-session claim this update
retracts.** Checked `we:skills-src/conveyor/runner.mjs`'s actual `mechanicalPasses` body on `main` directly
— it only shells `we:scripts/conveyor/infra-blocked.mjs retry` + `we:scripts/conveyor/lease-reaper.mjs`,
both fast and deterministic. The long verify-dispatch pass that makes the stale-lease-during-a-long-pass
window real (`#3105`'s work) exists only on `origin/lane/mechanical-dispatcher`. So
`#3403`/`#3404`/`#3406` all remain genuinely branch-scoped — building any of them means picking a branch
first (see the still-open branch-strategy question below).

**3. Correction: the diff-driven test-selection shrink (`#2681`/`#3372`) would NOT have helped tonight's
verify-lane flakiness, contrary to an earlier in-session claim.** `backlog/` is deliberately excluded — it's
in `we:scripts/readiness/test-selection.mjs`'s own `GLOB_FIXTURE_ROOTS` (directory-scanning tests are
invisible to the module graph the shrink relies on) and absent from `SHRINK_ALLOW_LIST`. A backlog-only diff
correctly forces the full suite; shrinking it would risk a real false-green. Not a gap — working as designed.

**4. A genuine, new finding: `we:scripts/verify-lane.mjs`'s local full-suite gate is unreliable under real
host contention.** Four consecutive local `verify-lane` runs on the SAME backlog-only diff each failed on a
DIFFERENT, unrelated, timing-sensitive integration test — `we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs`'s
TTL-backdating cases (twice), then `we:scripts/__tests__/sync-skills-deploy.test.mjs`'s symlink-cycle test
(`#3011`'s own precedent for the identical load-flake shape, recurring). Every one passed clean run in
isolation. Filed `#3411` for the specific lane-pool-reap case. This host had, at the time, this session plus
a review session plus several other lanes' dev servers all running concurrently — not a corner case for a
dispatcher whose whole point is more concurrent local agents, not fewer.

**5. An open design question, discussed with the operator but NOT ruled on or filed — flagged for the next
session, not resolved here.** `we:scripts/lib/verify-lane-gate.mjs`'s own header already argues the local
full-suite run is a LOCAL, pre-CI sanity check, not the authoritative gate — the real, required GitHub
`test` check is, and `pr-land`/the drain already wait on and refuse-on-red against that CI check
independently of the local marker. Given (a) CI proved green on this exact code while local flaked twice,
and (b) this epic's own direction is more concurrent local dispatch over time, is the full local suite
still pulling its weight as a hard land-blocker, or should it shrink to a fast-fail-only role? No card
filed — the operator wanted the immediate flake fixed (`#3411`), not this reframed yet.

**6. Two items filed and landed, both on `main`:**
   - **`#3411`** — the `we:scripts/__tests__/lane-pool-reap-on-acquire.test.mjs` TTL-backdating flake from
     finding 4.
   - **`#3412`** — wrap `we:scripts/gap-sweep-status.mjs` as a declared operation, a small additive slice of
     `#3273`'s census. Picked specifically as the live-fire dispatch target: self-contained, no hot-file
     contention beyond the two registry lines `#3273` already clears for one slice.
   Both landed via the documented `WE_LAND_UNVERIFIED=1` break-glass (operator-approved for this specific
   case) after the local gate's repeated unrelated flakes, citing CI's independent green as the real proof —
   CI itself came back green on both.

**7. The live-fire dispatch itself is STILL not attempted this session.** `#3412` is filed, ready, and
picked specifically for this purpose — but no scratch clone was set up and no real dispatch was fired.
Nothing has actually tried this since the 2026-08-29 attempt documented in this epic's own history above.
**This remains the single highest-leverage next action.**

**8. Live, current evidence of the notification gap `#3398` already names — not cleaned up this session.**
`claude agents --json` shows three `conveyor-*` background agents sitting `blocked`/`waiting for dialog
open` right now: `conveyor-3150`, `conveyor-3151` (×2, different launches), `conveyor-3154` (×2) — one at
least 22+ hours old. Found only by checking by hand. Either clean these up via `we:scripts/operations/wake.mjs
--resolve --force` (`#3353`'s documented protocol) or leave them as further, current evidence for `#3398`'s
urgency — both valid, neither done here.

**9. Branch-strategy decision still not made.** `origin/lane/mechanical-dispatcher` (has `#3105`'s
gate-delegation fix + the updated `we:skills-src/conveyor/delivery-agent-brief.md`) and
`origin/lane/mechanical-dispatcher-recovered` (has `we:skills-src/conveyor/supervisor.mjs`, the lane-pool
ref-lock + `computeFreeSlots` fixes, the runner→`dispatch-lane` wiring) remain diverged, never reconciled.
`#3403`/`#3404`/`#3406` all need this decided before any of them can be built — see correction 2 above for
why.

**10. `#3405` (doctrine ratification) and the round-3 gap-sweep capture (candidate new gaps: a
dev/local-vs-SaaS runtime-mode distinction, resource management, VM/container isolation per lane — distinct
from the already-covered billing/lock-arbitration angles) remain open, untouched beyond conversation this
session.**

**For the next session, explicitly, so none of this has to be re-derived:**
- Trust corrections 2 and 3 over anything earlier in this card that contradicts them.
- Highest-leverage next action: the live-fire dispatch against `#3412` — scratch clone (non-`lane-N` name),
  `WE_DISPATCH_AGENT_ARGS` with a real permission mode set, one real `we:skills-src/conveyor/runner.mjs
  --once --json` tick.
- The branch-strategy call (finding 9) blocks `#3403`/`#3404`/`#3406` and arguably should happen before or
  alongside the live-fire attempt, since which branch gets exercised is exactly what that decision settles.
- The three stuck `conveyor-*` agents (finding 8) are real, current, and easy to check —
  `claude agents --json` first, `we:scripts/operations/wake.mjs --resolve --force` per `#3353` to close them
  out if that's the call.

## Session update (2026-08-30, continued) — finding 9 corrected with evidence, agents cleaned, #3405 ratified

**Correction to finding 9: the branch-strategy decision was never actually a fork — `origin/lane/mechanical-
dispatcher` is a strict superset of `origin/lane/mechanical-dispatcher-recovered`, verified by diffing the
trees directly, not by re-reading commit messages.** Finding 9's framing (two branches with disjoint unique
content, needing reconciliation) does not survive a direct comparison:

- `git diff --stat origin/lane/mechanical-dispatcher origin/lane/mechanical-dispatcher-recovered` shows every
  file `-recovered` touches also exists on `mechanical-dispatcher` — most in a strictly MORE advanced form
  (e.g. `we:scripts/operations/dispatch-lane-io.mjs` on `mechanical-dispatcher` carries the `#3105`
  `WE_DISPATCH_KIND` stamp and the `#3110` attempt-tag logic; `-recovered`'s version of the same file is the
  pre-`#3105`/`#3110` version, going *to* `-recovered` from `mechanical-dispatcher` is a net 3058-line
  deletion against 147 insertions).
- `mechanical-dispatcher` also holds whole files `-recovered` never got at all:
  `we:scripts/conveyor/verify-dispatch.mjs` (164 lines), the `#3390`/`#2924` lane-pool guard tests,
  `we:.claude/commands/status.md` and `we:.claude/commands/eli5.md`.
- The 147 lines unique to `-recovered` were checked directly (not assumed) — they are all OLDER/simpler
  versions of code `mechanical-dispatcher` already improved on (the pre-`#3390` `we:scripts/lane-pool.mjs`
  without the dirty-tree guard, the pre-`#3110` `classifyDispatchPr` without the attempt-tag axis), not novel
  content.

Read together with finding 9's own claim that `-recovered` holds "the lane-pool ref-lock +
`computeFreeSlots` fixes" — that claim is now stale too: `computeFreeSlots` exists on `mechanical-dispatcher`
as well, unchanged in relevant behavior, just reached via a different commit history because `-recovered`'s
history was reconstructed from session transcripts rather than a normal rebase. **`-recovered` was a
point-in-time rescue of lane-11's wiped files, taken before the same later session layered `#3390`/`#2924`/
`#3105`/`#3110`/`#3398` onto `mechanical-dispatcher` directly — it is a strictly earlier snapshot, not a
sibling with independent value.** Confirmed with the operator (2026-08-30): use `origin/lane/mechanical-
dispatcher` going forward for `#3403`/`#3404`/`#3406` and the live-fire test; `-recovered` adds nothing and
can be deleted or left to rot once nobody needs to double-check this finding.

**`mechanical-dispatcher` is also 87 commits behind `origin/main`** (21 unique commits ahead) — not reconciled
by the above; a separate, real step. 13 files changed on both sides since the branches diverged, including
`we:scripts/lane-pool.mjs`, `we:scripts/verify-lane.mjs`, `we:scripts/lib/lane-lease.mjs`,
`we:scripts/operations/wake.mjs` — real conflict risk, because `main` already landed `#3390`/`#2924`
(PR #1710) in those exact files independently of the branch's own equivalent guards. Rebasing onto `main`
and resolving those conflicts by hand is the next step, before the live-fire dispatch (which branch gets
exercised is exactly what this settles) — in progress this session.

**Stuck `claude agents` cleanup — six found, not three, and half were stale bookkeeping, not live
processes.** `claude agents --json` showed six blocked/waiting `conveyor-*` sessions, not the three finding 8
named: `conveyor-3154` (three separate launches, oldest from 2026-08-17 — 13 days, not "22+ hours"),
`conveyor-3151` (2026-08-17), `conveyor-3` in lane-25 (2026-08-25), and `conveyor-3150`/`conveyor-3154` again
(2026-08-29). Only two carried a live `pid` in the listing — `conveyor-3150` (30175) and `conveyor-3154`
(30255), both genuinely stuck at `claude --resume ... waiting for dialog open`; `ps` confirmed both, and both
were killed directly. The other four have no `pid` in the listing at all — `claude agents --json` is
reporting stale bookkeeping for processes already gone, not agents actually waiting on anything. Left
as-is (nothing to kill); this is itself live, current evidence for the exact liveness-reading gap `#3353`
already documents (a stale/unreadable `claude agents` listing, not a code defect in the dispatcher).

**`#3405` ratified.** Fork 1 → (a) denylist by verb-class, expand as each concrete case forces it. Fork 2 →
(a) halt and surface a `missing-operation` finding. Both match the card's own stated defaults; full reasoning
recorded on `#3405` itself and codified at
`we:docs/agent/platform-decisions.md#dispatched-agent-never-runs-commands-directly`. One Done-when item
(citing this ruling from `we:scripts/guard-bash.mjs`'s header) is deferred — `#3105`'s
`dispatchedAgentVerificationReason` does not exist on `main` yet (confirmed by grep; branch-only), so the
citation belongs in the branch copy of that file or with `#3105`'s own landing, not here.

## Session update (2026-08-30/31) — the branch is rebased onto `main`; the live-fire dispatch found a real,
## severe, reproducible bug and never got past it

Continued the same session, per the operator's explicit go-ahead: `origin/lane/mechanical-dispatcher`
rebased onto `origin/main` (finding 9's own next step), then the live-fire dispatch attempted for real from a
scratch clone of the rebased branch. The dispatch never succeeded — but the reason it failed is itself the
most important finding of the night.

**1. `origin/lane/mechanical-dispatcher` is rebased onto `origin/main` and pushed.** Was 87 commits behind, 21
ahead. Two commits were pure duplicates (patch-id matched, auto-dropped by `git rebase`). Six real conflicts,
all resolved by hand and verified against the actual diff content, not guessed:
- `we:scripts/lane-pool.mjs` (the `#3390`/`#2924` fetch — merged the branch's retry-wrapped
  `fetchOriginPruneWithRetry` around the SAME `#2924` re-verify-containment logic already on `main`; both
  fixes are real and now coexist).
- `we:scripts/verify-lane.mjs` (docblock only — the branch's `#3105` `request` mode section combined with
  `main`'s `#3378` own-lease-ok nuance to the `reset` line; the code body had no conflict).
- Four separate conflicts in `backlog/3383-*.md` itself, each the same shape: two independent append-only
  histories of this same epic card that had diverged. Every one resolved by reading BOTH sides in full and
  interleaving them in chronological order — nothing dropped, nothing picked over the other — since each
  held real, non-duplicate content (the branch's own 2026-08-29 "first live dispatch attempted" session, its
  "third session — rebased onto main" session, its `#3105` build write-up, and its learnings-pool digest all
  turned out to be genuine history `main`'s copy of this card never carried, not stale duplicates of anything
  already here).
Verified post-rebase: `npm run check:standards` 0 errors (matches baseline), 115 test files / 4181 tests /
4 skipped, all green, against the full `scripts/__tests__/lane-pool*`, `scripts/operations`, `scripts/conveyor`,
`scripts/lib`, `skills-src/conveyor` suites — not just the six touched files. Pushed with
`--force-with-lease` (clean, no rejected-ref surprise).

**2. The live-fire dispatch itself, run for real, twice, from a scratch clone
(`~/workspace/wev-scratch-dispatcher`, deliberately non-`lane-N`).** `node we:scripts/conveyor/queue.mjs add
3412` queued the target, then `WE_DISPATCH_AGENT_ARGS='["--permission-mode","acceptEdits"]' node
we:skills-src/conveyor/runner.mjs --once --json` — twice, since a stray earlier `--help` invocation (no such
flag exists; it silently ran the REAL resident loop with `maxTicks: Infinity` instead of erroring, a smaller
finding of its own worth noting for whoever adds real `--help` support) left the singleton runner lease
(`~/.claude/conveyor-runner-locks/`) held by a pid that no longer existed after it was killed via `TaskStop` —
confirmed dead via `ps`, the stale `we:lock.json` removed by hand, a fresh acquire then worked cleanly.

**Attempt 1 — `#3412` unscoped, routed to `spawnPrepareScope`.** The tick's own JSON output showed
`dispatch.prepareScope: [{"num":"3412","lane":1}]`. The `.operations/runs/dispatch-lane-*.json` record for
that same call showed `"dispatching": false`, `holdReason: "the tick core did not clear this item for
dispatch — it is not in decisions.spawnBuilds, decisions.spawnPrepareScope, ..."` — the OPPOSITE of what the
runner's own tick had just surfaced, moments earlier, in the same process. Re-ran; identical result both
times — reproducible, not a race.

**Attempt 2 — `#3412` given a `scope:` field by hand (the exact files its own card text already names, matching
`#3273`'s "HOW to slice it" shape), to route it to `spawnBuilds` instead** (the path the 2026-08-29 session's
successful `#2936` dispatch actually used). Same shape, same result: `dispatch.builds: [{"num":"3412",
"lane":1}]` in the tick's own output, then `"dispatching": false`, `holdReason: "suppressed by the in-flight
build guard (an agent is already in flight for this item)"` from `dispatch-lane`'s own run record. `claude
agents --json` confirmed no `conveyor-3412` session ever existed; `we:scripts/lane-pool.mjs status` confirmed
lane-1 stayed clean/unleased. Nothing was ever actually spawned, on either attempt.

**Root cause, traced to the exact code, not left as a symptom.**
`we:skills-src/conveyor/runner.mjs`'s `makeCliDispatchPass` (the function `dispatchPass` reduces to) computes
BOTH the dispatch decision (`dispatch.builds`/`dispatch.prepareScope`) AND the updated guard bookkeeping
(`nextState.buildGuards`/`nextState.prepareGuards`) in ONE tick-core call — the new guard entry for the item
about to be dispatched (`{num, lane, spawnedTick, sawPr: false}` or the build equivalent) is already present in
`nextState` before `dispatch-lane` is ever invoked. That exact `nextState` is then written verbatim to a
bookkeeping file and handed to `dispatch-lane --num=<n> --bookkeepingFile=<file>` — whose own internal,
independent `tick-core` re-plan reads that bookkeeping as the CURRENT guard state, sees the item's guard
already live, and — correctly, by its own in-flight-duplicate-prevention logic — refuses to dispatch it a
second time. Except there was no first time: the guard the second read is honoring was written by PLANNING,
never by an actual spawn. The double-dispatch guard this epic itself calls out as load-bearing (`#3383`'s own
"Done when" #1 depends on it, and Fable's blind review flagged the SAME class of problem — "in-flight liveness
tracked via four overlapping heuristics rather than one source of truth," now with a concrete first instance)
suppresses the very first dispatch it exists to protect.

**Filed as `#3416`** (JIT-numbered at land), parented under this epic, size 5, with an executable
mutation-test Done-when reproducing the exact shape plus a bisect-or-name-it Done-when asking whether this is
long-standing or a regression introduced by `#3105`/`#3110`'s later layering on top of whatever the
2026-08-29 session's machinery actually was. **This is very possibly the reason `#3383`'s own "Done when" #1
has never been observed succeeding through THIS exact call path** — the 2026-08-29 session's one successful
live dispatch (`#2936`) predates both `#3105` and `#3110`, so it may simply never have exercised this exact
`dispatchPass`/`makeCliDispatchPass` shape at all.

**Per this line of work's own standing instruction** (improve the machinery, not deliver the item — restated
explicitly by the operator across the 2026-08-29 and tonight's sessions): this is exactly what a first live
run is for, and finding it is the success this criterion exists to produce, not a failure of tonight's
attempt. `#3412` itself is untouched (no PR, no commit beyond the local, uncommitted `scope:` add in the
scratch clone, which is not part of any landed change) — still available as the live-fire target once
`#3416` is fixed.

**For the next session:** `#3416` is now the single highest-leverage next action — fixing it is very
plausibly the unblock for this epic's own core "Done when" #1, ahead of `#3403`/`#3404`/`#3406` (which need
the branch-strategy call, already settled above, but not this bug) and ahead of `#3405`'s already-ratified
doctrine. Re-attempt the live-fire dispatch against `#3412` once `#3416` lands.

**Update: `#3416` landed on `origin/lane/mechanical-dispatcher` (`78234c18`), live-verified — a real agent
spawned for the first time all session (`conveyor-3412`). Two follow-ups from that run: `3422` (should the
dispatcher mechanically file+queue a fix item on a real delivery hiccup, gated by approval) and `3418`
(gives a dispatched agent a static system-prompt identity separate from its per-item brief — landed to
`main`, PR #1729, reviewed and merged by the operator directly).**

**A real gap surfaced answering the operator's own question tonight: `planTick` mechanizes build,
prepare-scope, prepare-decision, fix, and ci-heal — there is no sixth launch kind for independently
reviewing a `review:pending` PR.** `planFixSpawns` mechanizes the BOUNCE (a `review:changes` PR gets a fix
agent automatically), but the review verdict itself — `review:pending` → accepted/changes — only happens via
an interactive session running `/review`/`/jury`/`converge`, or a human. This is very plausibly why this
epic's own "Done when" #1 ("zero interactive-session turns inside the loop") still can't be fully met even
with `#3416` fixed: a dispatched build agent can now genuinely get a PR open, but nothing mechanized carries
it from there to landed. The operator's own framing: "id be good to be able to use the prototype soon for
this." Not filed as its own card yet — noted here for whoever picks this up next to scope properly.

## Where this stands, end of the 2026-08-30/31 session — everything above landed or resolved

All four PRs from tonight are merged: `#1726` (`#3405` ratified + finding-9 branch-strategy correction),
`#1727` (`#3416` fix confirmation + `3422` filed), `#1729` (`3418` — the dispatched-agent system
prompt), `#1731` (this review-mechanization note). Nothing from tonight is open or blocked.

**Next, in priority order:**
1. **Re-attempt the live-fire dispatch against `#3412`** now that `#3416` is fixed — the guard-suppression bug
   is gone, but the fix has not yet been exercised against a genuinely FRESH scratch clone (tonight's
   `conveyor-3412` run used one with unrelated uncommitted work already in it, which is why THAT run stalled
   on its own judgment call, not the fix). A clean re-run is what actually closes this epic's "Done when" #1.
2. **Mechanize the review step** — no `planTick` launch kind turns `review:pending` into a verdict; only an
   interactive `/review`/`/jury`/`converge` or a human does. This is very plausibly the remaining gap between
   "a dispatched agent can open a PR" and "Done when #1's full fix→review→land cycle, zero interactive turns."
   Not yet scoped as a card.
3. **`3422`** (auto-file+queue a fix on a real delivery hiccup, gated by approval) is a real, open decision
   with forks stated but not ruled on.
4. **`#3403`/`#3404`/`#3406`** can now be built — the branch-strategy question that blocked them is settled
   (`mechanical-dispatcher`, not `-recovered`), and the branch is rebased current with `main`.

## Session update (2026-08-31, follow-on session) — the live-fire dispatch finally completed end to end,
## `3422` ruled and landed as `#3422`, `dispatch-abort` built and PR'd, and the real permission-mode root
## cause found

Picked this back up per the operator's own priority order from tonight's close-out. All four items touched;
one fully closed, one landed, one built-but-parked, one confirmed-unblocked-but-not-started.

### 1. The live-fire dispatch against `#3412` — DONE, for real, first time all epic

The confounded scratch clone from the prior session (`~/workspace/wev-scratch-dispatcher`, still holding a
stuck `conveyor-3412` session and unrelated uncommitted changes) was stopped and abandoned per the operator's
own framing. A genuinely fresh clone, `~/workspace/wev-scratch-dispatcher-2`, was cut from
`origin/lane/mechanical-dispatcher` — which had drifted 18 commits behind `origin/main` again since the prior
close-out, so it was rebased current first (3 real conflicts, all in files both sides had touched since
diverging — `we:scripts/operations/dispatch-lane-io.mjs`'s `#3418` system-prompt param vs. `#3331`'s
session-identity fix, and the matching test/fixture files — resolved by hand, both sides' changes kept; 1791
tests green, `check:standards` 0 errors; pushed with `--force-with-lease`). This also settles priority 4: the
branch is current with `main` again as of tonight.

**Three real, previously-undiagnosed blockers stood between "fresh clone" and an actual dispatch, each found
by hitting it directly, not guessed at:**

- **A fresh scratch clone is never in Claude Code's own trusted-directories list.** `we:scripts/bootstrap-session.mjs`'s
  `trustableDirs()` only ever trusts the primary checkout and lane-pool lanes — never an ad-hoc scratch clone,
  which is exactly what `#3353`'s own live-run protocol calls for (a checkout named anything other than
  `lane-N`). Every prior session's live-fire attempt used a clone that had, by luck, already been trusted from
  an earlier manual dialog acceptance; tonight's genuinely-fresh one had not, and the dispatched agent stalled
  on a permission-prompt dialog with nobody there to answer it. Fixed for this run by hand
  (`withTrustedDirs`), and mechanized properly below (`we:scripts/operations/dispatch-abort.mjs --trust=<dir>`).
- **Using `kill <pid>` instead of `claude stop <id>` to end a stuck dispatched agent does not actually end
  it.** `kill` stops the OS process but does not deregister the session; something (unconfirmed what —
  possibly the same machinery that backs the mobile "remote agent" view) resurrected it under a NEW pid
  minutes later, twice, across two different scratch clones. One resurrection raced a second, legitimate
  dispatch attempt onto the same lane and produced a real double-dispatch onto `lane-5` — caught and cleaned
  up by hand, no damage done (the lane was still clean when found), but a genuine near-miss of the exact
  double-dispatch hazard this epic's own "Done when" #1 depends on avoiding. `claude stop <id>` does not have
  this problem — every stop issued through it stayed stopped.
- **The real, root-cause finding: `acceptEdits` is NOT the "non-prompting permission mode" `#3353`'s own
  protocol assumed it was, for a `--bg` dispatch specifically.** Confirmed directly, not guessed: the EXACT
  bash command a dispatched agent's brief step 1 runs (`export LANE_SESSION=...; LANE=$(node
  we:scripts/lane-pool.mjs acquire ...) && cd "$LANE"`) was run via `claude -p --permission-mode acceptEdits`
  (headless foreground) against the same trusted checkout and completed with ZERO prompt. The identical
  command, via `claude --bg --permission-mode acceptEdits`, stalls every time. `bypassPermissions` was ruled
  out separately — it refuses outright on a machine that has never interactively accepted its one-time
  disclaimer (`claude --dangerously-skip-permissions`, confirmed requires a real TTY; cannot be scripted). The
  actual fix: **`--permission-mode dontAsk`**, a mode neither `#3353` nor any prior session's `WE_DISPATCH_AGENT_ARGS`
  ever tried (found by re-reading `claude --help`'s full mode list — `acceptEdits`, `auto`, `bypassPermissions`,
  `manual`, `dontAsk`, `plan` — not the two this epic had been cycling between all along). With `dontAsk`, the
  SAME scratch clone, same brief, same everything: the dispatched agent went straight to `state: "working"`,
  never touched a permission prompt.

**The dispatch, run for real:** `WE_DISPATCH_AGENT_ARGS='["--permission-mode","dontAsk"]' node
we:skills-src/conveyor/runner.mjs --once --json`, from `~/workspace/wev-scratch-dispatcher-2`, `claude 2.1.251`.
Minted handle `aec264c2`, session name `prepare-3412`, `claude agents --json` row confirmed
`{"pid":96364,"cwd":".../wev-scratch-dispatcher-2","state":"working","status":"busy"}` — never blocked.
Acquired `lane-9` via its own `lane-pool acquire` (the exact scope-lease arbitration `#3037`'s acceptance
names) roughly 90s after spawn. Ran to completion unattended: read `#3412`, predicted its `scope:`, opened
`PR #1742` ("WE #3412: author scope: for #3412") through the canonical producer, watched it go green,
confirmed `ready-to-merge`, exited without merging — per its own brief. The drain landed it: **`PR #1742`
merged.** Full cycle, dispatch to merge, zero interactive-session turns anywhere inside it.

**Honest scope of what this proves, not more.** This was a `prepare-scope` launch kind (author `scope:`
frontmatter), not `build` (an actual code fix), and the PR never parked `review:pending` — it scored
low-risk enough to self-approve straight through. So it did NOT have to cross the still-open gap named
below (item 2): nothing here proves a `build` dispatch whose PR parks for review can complete unattended.
It DOES prove, for the first time all epic, that the dispatch→spawn→lane-acquire→real-work→PR→CI→drain-land
chain works end to end with a genuinely fresh checkout and zero interactive turns — the mechanism `#3037`'s
acceptance and this epic's "Done when" #1 both depend on is real, not theoretical.

### 2. `3422` ruled, landed as `#3422` — the follow-up story is `#3421`

`3422` only existed on a stray, never-merged branch (`origin/lane/3416-fix-landed-and-3383-followups`) —
this epic's own "filed" claim from the prior session's close-out was premature; the card was never on `main`.
Brought over and ruled in discussion with the operator (not unilaterally): Forks (a)/(b) collapse onto one
blocking/non-blocking axis — a blocking hiccup (delivery did not proceed) gets auto-filed with a proposed
fix, gated behind approval before it lands; a non-blocking hiccup (delivery succeeded, something's still
worth noting, e.g. perf) files straight through, no gate. Routes through the existing learnings-pool/
`/harvest` pipeline rather than a parallel one, triggered mechanically at the hiccup instead of a human
`/note`. `conveyor-3412`'s own free-form-question stall (named in the card) is explicitly ruled a blocking
hiccup. Landed via `PR #1740`; JIT-numbered `3422→#3422`, its follow-up build story `3421→#3421`.

**A live refinement, from the same discussion, not yet written into either card.** The operator: missing
operations specifically should be Kanban-style — a missing operation raises a feature request, prepared like
any other backlog item (read the spec, predict what it touches, build it in a lane — the SAME mechanism
`#3412`'s own prepare-scope dispatch just proved end to end in section 1 above, not a new one). The
low-risk-vs-escalate call is the building/reviewing AGENT'S OWN CONFIDENCE ASSESSMENT, made during that
normal prepare/build flow, against a small set of named criteria — not a rigid rule-based classifier:
security risk, data-leak risk, performance, blast-radius/reversibility, and baseline correctness (this
session's own proposed additions to the operator's "perf, security risk, etc." + "data leak risks"). Every
built operation gets an agent review, always — the confidence call decides whether a HUMAN also has to look
at it, not whether it gets reviewed at all. High confidence + clean on every criterion → self-clears, retries
the original call, no human in the loop. Any flagged criterion or genuine uncertainty → joins a BATCHED list
of AI-authored findings for a human to clear on their own time, not a blocking interactive prompt. This
sharpens `#3422`'s own blocking-bucket ruling (which said every blocking hiccup is gated, full stop) for the
specific case where the hiccup IS a missing operation. Belongs as an addition to `#3421`'s scope, not a
reopening of `#3422`'s ruling.

**A second refinement, also from the operator, also not yet built:** independent of the confidence call,
some commands/APIs should sit on a standing blacklist that forces elevated review regardless of how
confident the agent is — the same denylist-and-grow shape `#3405` already ratified for the dispatch doctrine
generally, applied here specifically to operations that call something on the list. And a third: the
thresholds themselves (confidence bar, blacklist contents) are eventually a Plateau admin-configurable
surface, not a hardcoded constant — pre-production, keep the parameter but keep it light (a short list, a
loose bar), tighten later once there's real usage to tune against. None of this blocks building a first
version; it's the shape the config should grow into, not a prerequisite.

### 3. `we:scripts/operations/dispatch-abort.mjs` built — mechanizes the stop-then-close-out and trust-grant sequences from finding
### 1 above — PR #1737, still parked, needs a genuinely independent clearance

New declared-style operation (`we:scripts/operations/dispatch-abort.mjs`, plain-module shape matching
`we:scripts/operations/wake.mjs`'s own precedent, not the full `op()` declarative engine): `stopSession`
shells `claude stop <id>` (never `kill`); `trustCheckout` grants checkout trust via the same
`withTrustedDirs` primitive `we:scripts/bootstrap-session.mjs` already uses for lanes; `abortDispatch`
composes stop-then-close-out so `we:scripts/operations/wake.mjs`'s own `assertHandleNotLive` passes on its
own merits without `--force` in the common case. 16 tests, `check:standards` clean. Two independent-review
passes (a `code-review high` pass, then a `/jury` pass on the PR itself) found and got real fixes: a
pre-emptive `listAgents()` read that failed OPEN on a malformed listing (removed — `claude stop` on an
already-gone handle is cheap and benign, so the composition just always attempts it rather than
pre-checking); a bare `--trust` with no value that silently resolved to and trusted the CWD (now refuses,
and the refusal itself is now unit-tested — it had lived only in the untestable `IS_CLI` block); no `force`
CLI escape hatch (added); three small pieces reimplemented instead of reused from
`we:scripts/bootstrap-session.mjs`/`we:scripts/operations/wake.mjs` (now reused). **`PR #1737` is green and
fixed but still parked `review:pending`** — the producer rubric scored it blast-radius (it grants trust and
terminates sessions). This session's own attempt to clear it was refused BEFORE a juror even spent anything:
the independence check keys off `CLAUDE_CODE_SESSION_ID`, and this session authored the PR, so it cannot be
its own reviewer, full stop — not a bug, working as designed (`#2439`/`#2844`). Needs either the operator or
a genuinely different session to run `/review 1737`.

**A related, real finding for `#3383`'s "operation manager" thread, not yet built anywhere:** the operator's
own framing of what "operation manager" should mean is bigger than `we:scripts/operations/dispatch-abort.mjs`
— not a helper script, but a real execution chokepoint every command (not only dispatched-agent ones) routes
through: semantically-named operations (no detail on HOW they execute, which also buys OS-independence),
logged and telemetered even for cheap/read-only calls, tiered by cost (free-and-inline vs. CPU-scheduled vs.
mutating-and-runner-only), and — the missing-operation case above — the point where the catalog grows from
real usage rather than speculative up-front design. Discussed at length with the operator this session;
explicitly NOT a final design, and not yet captured as its own card. Whoever picks this up next should read
this section plus section 2's confidence-call/criteria/blacklist refinements before filing it, so the
discussion is not re-derived from scratch.

### For the next session, in priority order

1. **File the "operation manager" design as its own card** under this epic — capture what's above, keep it
   explicitly open/capture-only (matching `#3422`'s own shape), and continue the design conversation rather
   than treating tonight's discussion as settled.
2. **Clear or get `PR #1737` cleared** — genuinely independent review needed; this session cannot do it.
3. **Mechanize the review step** — still the single largest remaining gap between "a dispatched agent can open
   a PR" and this epic's full "Done when" #1 (a `build` dispatch, not just `prepare-scope`, completing
   unattended through a `review:pending` park). Not yet scoped as a card.
4. **`#3403`/`#3404`/`#3406`** can be built now — branch-strategy settled, branch current with `main`. Real,
   separate build work; not started this session.
5. **Pin the missing-operation risk axis** and fold it into `#3421`'s scope per section 2 above.

## Session update (2026-08-31, follow-on session) — all five of the prior list closed; the review step is a
## real, callable operation now, but not yet wired into the dispatcher's own loop

Picked up the prior session's numbered list in order. All five are done:

1. **`#3427`** filed — the "operation manager" design card, capture-only, citing `we:scripts/operations/dispatch-abort.mjs`
   (PR #1737) as precedent. Landed via `PR #1751`.
2. `PR #1737` — not directly addressed this session (superseded by finding a cleaner path for the SAME
   bootstrapping problem; see below).
3. **`#3403`/`#3404`/`#3406`** built, tested, pushed to `origin/lane/mechanical-dispatcher` — a durable
   ground-truth floor for the build guard (a live `conveyor-<num>` session now counts even if the in-memory
   guard was wiped by a crash-restart), a mid-pass heartbeat so the singleton lease survives the long
   verify-dispatch pass, and a separate backoff curve for repeated idle-stops (distinct from a polite
   stand-down, which still restarts instantly).
4. **`#3421`** amended with the missing-operation risk-axis addendum (confidence assessment against named
   criteria, a standing blacklist, a future admin-config surface). Landed via `PR #1751` alongside `#3427`.
5. **Mechanize the review step — `#3072`'s remainder and `#3279` both landed to `main`** (`PR #1754`,
   `PR #1756`). `#3072` already had the round-cap (`converged`/`in-progress`/`exhausted`/`escalated`, built
   2026-08-12) and the actor-tier confirm declaration (`CONFIRM_ACTORS.HUMAN`/`AGENT`) — this session's actual
   gap was narrower than it first looked: a concrete `autoConfirm` policy (`we:scripts/lib/review-loop-policy.mjs`)
   that answers `changes`/`abstain` unattended but NEVER `accept` (an accept queues for a human, mirroring
   `#3421`/`#3422`'s gated-bucket shape), and the CLI that wires it in
   (`we:scripts/operations/review-loop-cli.mjs`). `#3279` (dispatch a genuinely independent session to run
   that loop) was unscoped going in — its own Done-when was written fresh this session: mints a fresh session
   id, starts a real `claude --bg` session, refuses a bad brief/PR/repo/in-lane-checkout dispatch the same way
   `we:scripts/operations/dispatch-lane.mjs` does.

   **Both PRs went through the machinery they themselves built, for real, and it worked.** `PR #1754` (self-
   authored, inherited this session's own id) parked `review:pending` and could not self-clear — resolved by
   spawning a genuinely independent `claude --session-id=<fresh-uuid>` process to run the new review
   operation against it (the exact bootstrapping answer `PR #1737` above was still waiting on). `PR #1756`
   went three real rounds: round 1 found 3 genuine bugs (dropped `extraArgs`, missing
   `WE_DISPATCH_AGENT_ARGS` wiring, a prose-only self-accept/merge enforcement — the last filed as its own
   residual, `3433`, not silently dropped); round 2, after two of those were fixed, found a NEW bug (the
   dispatched agent's own brief told it to substitute "the lane number" into a release command, but `LANE`
   holds a path, not a number — unexecutable as written); round 3 converged clean. Both landed;
   `check:standards` + the full suite green on each.

**The one thing this does NOT yet do: nothing calls it automatically.** `we:scripts/operations/review-loop-cli.mjs`
is a real, correct, callable operation today — `node we:scripts/operations/review-loop-cli.mjs --pr=<N>
--repo=<repo> --cwd=<a lane>` runs one independent round and answers honestly. But
`we:scripts/conveyor/reconcile-pass.mjs` (the pass that already decides WHEN a review is owed, landed under
`#3296`) still does not call it, and nothing schedules `we:scripts/conveyor/reconcile-pass.mjs` itself yet. So
"the review step is mechanized" is true of the OPERATION, not yet of the LOOP — a PR still does not get
reviewed unless someone (a session, an operator) actually invokes `we:scripts/operations/review-loop-cli.mjs`
against it.

**The interim instruction this implies, until that wiring lands:** whenever a PR under this epic's own work
(or any dispatch-built PR) parks `review:pending`, the session driving the epic should invoke the review
MECHANICALLY via `we:scripts/operations/review-loop-cli.mjs` — not the old ad hoc `/review` skill — and should
drive it through the FULL fix → re-review convergence loop itself when a round comes back `changes`, exactly
as this session did for `PR #1756` above (three rounds, real fixes each time, never stopping after round one
just because a verdict came back). Treat this as standing in for the automatic loop the machinery will
eventually run itself: the session's job, until the wiring exists, is to BE that loop by hand — fix,
re-invoke, repeat until converged/exhausted/escalated — not merely to trigger one round and hand it back for
someone else to notice. This mirrors exactly what
`we:agent-memory-src/standing-authorization-independent-review-self-clear.md` already authorizes for the
self-clear case specifically; this note generalizes it to the whole review loop.

### For the next session, in priority order

1. **Wire `we:scripts/conveyor/reconcile-pass.mjs` into `we:skills-src/conveyor/runner.mjs`'s mechanical
   passes** (branch work, `origin/lane/mechanical-dispatcher`) so a `review` dispatch decision actually calls
   `#3279`'s operation — the one remaining gap between "the review step is a real operation" and "the review
   step is mechanized" per this epic's own goal. `we:scripts/conveyor/reconcile-core.mjs`'s liveness reads are
   already ground-truth based (not session-ephemeral), so this can run as a plain quick mechanical pass, the
   same way `we:scripts/conveyor/infra-blocked.mjs`/`we:scripts/conveyor/lease-reaper.mjs` already do — no new
   resident process needed.
2. Decide whether/when to actually schedule `we:scripts/conveyor/reconcile-pass.mjs` at all if the
   runner-wiring above is deferred — today nothing invokes it outside its own tests even standalone.
3. `3433` (technically enforce review-dispatch's never-self-accept/never-merge rule) remains open, filed,
   deliberately deferred — a genuine, harder residual, not urgent.

## Session update (2026-08-31, continued) — the review step is now fully mechanized; the one remaining gap
## from the list above is closed

Item 1 above is done. `we:skills-src/conveyor/runner.mjs` gained a fourth mechanical pass: each tick, shell
`we:scripts/conveyor/reconcile-pass.mjs --json`, and for every PR its plan marks `kind: 'review'`, shell
`we:scripts/operations/review-dispatch.mjs --pr=<n> --repo=<slug>` against it (the repo slug resolved once via
`gh repo view`, lazily, only when a review is actually owed). Best-effort and sequential, mirroring every other
mechanical pass's own contract — one PR's dispatch failure never stops the rest of the tick. No new guard
bookkeeping was needed: `we:scripts/conveyor/reconcile-core.mjs`'s own liveness read already refuses
(`live-process`) a PR with a bound live session before the `review` decision is ever reached, so a review
already in flight is simply absent from next tick's plan — the exact reason `#3383`'s own text argued this
pass could safely re-run every tick with no session-ephemeral state of its own.

Pushed to `origin/lane/mechanical-dispatcher`. Before this landed, rebasing the branch onto `main` (needed to
pick up `#3072`/`#3279`, which landed to `main` directly, not the branch) surfaced one real, pre-existing test
regression: `we:scripts/operations/__tests__/dispatch-abort.test.mjs`'s fixture (part of `PR #1737`, landed to
`main`) assumed the OLDER pre-`#3331` behavior where `createDispatchSinks` trusted `mintSessionId` directly as
a dispatch's handle. The branch's own `#3331` fix (2026-08-28, verified against the real CLI) had already
changed that: the handle is the short hex prefix read back off the spawn's own `backgrounded · <id> · <name>`
stdout line, never the minted id directly. Fixed the fixture to emit a realistic line; full suite (385 files,
10198 tests) green afterward.

**What this means for item 3 above (`#3279`'s Done-when checklist), read literally against this epic's own
"Done when" #1** ("A background process can run at least one real PR through a full fix → review → land cycle
with zero interactive-session turns inside the loop"): the DISPATCH half is now real and automatic. What has
NOT yet been exercised is a genuine live-fire proof of the WHOLE chain — a build dispatch opens a PR, the
runner's own new pass notices it, dispatches a review with zero interactive turns, that review's verdict lands
(bounce or the gated accept-queue), and the PR merges. Every individual piece has been proven separately
tonight (the build→PR chain in an earlier session; the review loop against two real PRs, `#1754`/`#1756`, in
this one) but never as ONE continuous run through the runner's own tick loop with nobody driving it. That is
the next genuine test of this epic's own "Done when" #1, not a new build.

**`3433`** (technically enforce review-dispatch's never-self-accept/never-merge rule) remains open, filed,
deliberately deferred, unchanged from the prior update.

## Working doctrine (2026-09-01), the operator's own words: kanban-style, not stop-and-ask

Set while attempting the live-fire test above (priority 1 from the prior update). Mid-attempt, the driving
session hit a real obstacle (a stuck-session cleanup path that would not confirm) and stopped to ask the
operator which of several options to take, using a closed multiple-choice tool. The operator's correction,
verbatim (their own typo kept): *"I though my instruction on my use were clear, I dislike those closed up
question UI. second, we need to work kanban style, each time we find an issue you have to apply the real best
fix merit base to the mechanics and reruns it after. this should be in the epic so it is clear from now on."*

**The rule, standing for this epic from now on:** when a session driving this epic's own machinery hits an
issue — a stuck session, a broken assumption, a mechanism that silently does the wrong thing — the response is
to diagnose the root cause and apply the real fix on its own merits, not to stop and surface a menu of options
for the operator to pick from. **This changes when to ask, not whether the fix gets reviewed** — a real
mechanism-code fix (a script, an operation, this doctrine text itself) still lands the normal way, committed
in a lane and landed through the reviewed PR pipeline, never a silent edit. A 2026-09-01 independent review of
this doctrine's own first cut (PR #1764) correctly caught an earlier draft that read as authorizing silent,
unreviewed mechanism edits — the language above is the corrected version; see the agent-memory note's own
2026-09-01 sharpening for the full finding. This generalizes the same judgment-call standard the agent-memory
note `conveyor-file-decisions-not-inline-questions` already sets for routing calls the driving session owns: a
live-fire attempt hitting friction is exactly this kind of
call, not a decision that needs the operator's input. Reserve actually asking the operator for genuine
authorization gates this epic already treats as such (dispatching something live for the first time, a
destructive/irreversible action) — not for "which of these four workarounds do you want."

**Concrete instance this session, for calibration.** Two real issues surfaced back to back while queuing
`#3412` for the live-fire build, both fixed directly rather than asked about: (1) `node we:scripts/backlog.mjs
build-queue add <NNN>` writes committed `buildQueued:true` frontmatter, but
`we:scripts/readiness/conveyor-state.mjs`'s CLI always reads the session-local sidecar (`we:.conveyor/queue.json`,
#2613) when present — even empty — so the committed frontmatter path is DEAD in practice today; fixed by
reverting that commit and using `node we:scripts/conveyor/queue.mjs add <NNN>` instead (the sidecar CLI
`we:scripts/conveyor/queue-store.mjs`'s own docblock already names as canonical). This is itself a real,
unfiled papercut — the legacy `build-queue add` CLI still exists, still prints a success message, and still
does nothing the dispatcher will ever see; worth its own small item (remove or hard-redirect it) so a future
session doesn't repeat the same dead end. (2) Four background `conveyor-*` sessions (`#3154`×2, `#3151`, an
unresolvable `#3`) were stuck `state: blocked`, all pointed at already-`resolved` items — debris from earlier
test runs, not live work. `claude stop <id>` refused to confirm on any of the four, repeatedly, even after
retries ("couldn't confirm... background service may be restarting"). Left unresolved rather than blocking on
it further — the stale guards did not actually block a DIFFERENT item (`#3412`) from being planned/launched,
so the live-fire attempt proceeded around them rather than being gated on fixing session cleanup first. **This
is a second real, still-open instance of the self-clear/independent-dispatch class of gap** named in the prior
update's open question 4 (stop not reliably landing, not just `kill`) — worth its own look, separate from
tonight's live-fire attempt, not re-derived from scratch.

## Session update (2026-09-01, continued) — the fix half of the loop is confirmed missing, not hypothetical;
## two new informative PR labels landed; a second real bug class found in review

**`#3412`'s build completed for real** — a genuinely dispatched agent (`conveyor-3412`) built the operation,
opened `PR #1765`, and it went through THREE real independent-review rounds tonight (round 1: a confirmed
path-traversal — the containment check validated against one root while the spawned CLI read relative to
another, unpinned one; round 2, after fixing round 1: a genuinely different bug the same class of check missed
— the fix and the check now share one root, pinned via `cwd`; round 3 in progress as this update is written).
`PR #1764` (this epic's own doctrine note, below) went through its own two rounds — round 1 correctly caught
the doctrine text over-broadening "apply the fix" into something a reader could take as "skip review of the
result," which it was never meant to authorize.

**The fix half of the fix→review→land loop is now demonstrated missing, not just suspected.** Every one of
those four bounces — two on `#1765`, two on `#1764` — was repaired by THIS interactive session by hand, not by
a dispatched fix agent, because no such dispatch exists yet: `we:scripts/conveyor/reconcile-pass.mjs` correctly
PLANS a `kind: 'fix'` entry for a bounced PR with nothing live working it (confirmed live, `attempts: 1`/`2` on
the real PRs), but nothing in `we:skills-src/conveyor/runner.mjs`'s mechanical passes — nor tick-core's own
older `planFixSpawns`, which never fired across 20+ real ticks tonight either — ever executes it. Filed as
`#3438` two updates ago on a hypothesis; tonight is the direct, repeated, first-hand evidence for it. This
is THE remaining gap between "review is mechanized" (true, landed, proven twice more tonight) and this epic's
own "Done when" #1 (a full fix → review → land cycle with zero interactive turns) — not one gap among several,
the one that's left.

**A second real, cost-burning mechanism bug, found and stopped live: `review-dispatch` double-dispatches a
re-armed PR.** After the round-1 fixes, re-arming `#1765`/`#1764` (`review:changes → review:pending`) and
letting `we:skills-src/conveyor/runner.mjs`'s own tick loop run continuously (not `--once`) produced SEVEN
distinct, genuinely co-live `review-1765` processes over ~15 minutes, none of which ever posted a verdict —
directly contradicting the runner's own docblock claim that `we:scripts/conveyor/reconcile-core.mjs`'s liveness
read refuses a re-dispatch while one is already live. The runner had to be killed by hand; 10 stray sessions
stopped by hand. Filed as `#3437`, high priority — a real safety/cost hazard, confirmed, not theoretical.

**A third, still-unexplained failure mode, found retrying the SAME rounds by hand (single dispatch, no
overlap):** dispatching exactly ONE `we:scripts/operations/review-dispatch.mjs` call per PR (not through the
buggy loop — by hand, via the real operation) after a re-arm still, twice in a row for each PR, finished
`state: done` with ZERO PR activity — no comment, no label change. A THIRD single dispatch (after confirming
the lane pool was NOT exhausted — 41 of 42 lanes free at dispatch time, ruling out the most obvious
explanation) is in progress as this update is written; `claude logs <id>` is being used to inspect an actual
failed run rather than guessing again. This is DISTINCT from the double-dispatch bug above (this reproduces
with a single, non-overlapping dispatch) and from round 1/2's real findings (those DID post verdicts) — a
genuine third finding, not yet filed as its own item pending the `claude logs` read. Whoever picks this up
next: do not conflate it with `#3437`.

**Two new informative-only PR labels landed and are live on real PRs right now** (the operator, mid-session:
"expose if a reviewing is currently reviewing and if a fixer is currently fixing... visibility on what is
actioned upon... periodically verify real state and tag stay aligned, doesn't have to be an internal
[design]"). `we:scripts/conveyor/review-round-tag.mjs` (`review-round:<N>`, from
`we:scripts/conveyor/reconcile-pass.mjs`'s own durable re-arm count) and
`we:scripts/conveyor/review-status-tag.mjs` (`review-status:reviewing` / `review-status:review-stalled` /
`-fixing` / `-fix-stalled`, from a fresh `claude agents --json` read matched by session name — deliberately
independent of `we:scripts/conveyor/reconcile-core.mjs`'s own liveness binding, which is under live suspicion
per `#3437` above). Both purely cosmetic — nothing reads them back to decide anything — and both
self-correcting with no new poller: they ride the runner's existing ~120s tick, re-deriving and re-applying
idempotently every time. Confirmed live: `PR #1765` currently carries `review-round:3` +
`review-status:reviewing`, `PR #1764` carries `review-round:2` + `review-status:reviewing`, both matching real
state at the moment of writing. Landed on `origin/lane/mechanical-dispatcher` (not yet graduated to `main`,
same as the rest of the runner infrastructure).

## Session update (2026-09-01, close-out) — mechanical acceptance ratified, built, and proven live twice;
## two new real findings; both blocking PRs landed

**The "third finding" above is resolved, not a bug.** `claude logs <id>` (raw ANSI, stripped and grepped by
hand) showed both PRs' repeated "no verdict posted" rounds were genuinely clean, independent ACCEPT verdicts
correctly queued for a human per the then-standing 2026-08-31 never-auto-accept ruling — not a crash, not a
hang, not a mechanism failure. That mystery being hard to solve at all is itself real evidence for the new
`#3436` item below.

**Mechanical acceptance ratified and shipped (`#3434` / `backlog/3434-*.md`).** The operator, live, mid
this same session: "I want the acceptance to be mechanical from the verdict." Ratified in discussion (not
unilaterally): a genuinely independent clean verdict on `review:pending` now clears mechanically, no human
step — reversing the 2026-08-31 ruling for that tier specifically; `review:human` stays human-only, confirmed
("yes review human are for human"). A related, real fourth-verdict finding surfaced in the same discussion:
`we:scripts/lib/jury-core.mjs`'s `prevention-outstanding` verdict (bug fixed, a suggested guard never filed)
is currently folded into "bounce as changes" in the real flow (`we:scripts/operations/review-loop-cli.mjs` →
`reviewLoopAutoConfirm` — NOT the function `deriveNegotiationOutcome`, in `we:scripts/lib/jury-core.mjs`, a
separate, differently-behaving consumer of the same enum; do not conflate them) — ratified as its own,
deferred Done-when item: file the guard, then treat as accept-worthy, never bounce forever over a
documentation debt the code doesn't have.

Implemented: `reviewLoopAutoConfirm`'s one gating line now answers `accept` for `review:pending`; `PR #1768`
carried it, correctly parked `review:pending` itself (blast-radius), and — bootstrapping paradox, expected —
its OWN review necessarily ran under the OLD policy (not yet merged) and queued for a human too. Cleared via
the standing self-clear-independent-session authorization; the independent session's first resume attempt hit
a real, orthogonal CLI-shape error (`--answer` on an already-answered `awaiting-effect` run) — fixed by
re-running the plain resume. `PR #1768` merged. **Then `#1765` and `#1764` (the two real PRs blocking this
whole live-fire test) were redispatched and BOTH cleared mechanically** — `review:accepted` +
`ready-to-merge` appeared in one shot, zero human step, real independent jurors, real diffs — and both merged.
This is this epic's own "Done when" #1, proven twice, back to back, on real PRs, tonight.

**Two more real findings, both now fixed for tonight's own work but NOT YET filed/fully addressed — flagging
here so they aren't lost:**
1. **A review dispatched from a stale/unmerged-branch checkout silently runs OLD code, regardless of what's
   on `main`.** `we:scripts/operations/review-dispatch.mjs` spawns the review agent with its start-of-life
   `cwd` at the DISPATCHING checkout's own location; if that checkout (e.g. a scratch clone still pinned to
   `origin/lane/mechanical-dispatcher`, not rebased since `#3434` merged) is stale,
   `we:scripts/operations/review-loop-cli.mjs` loads ITS copy of `we:scripts/lib/review-loop-policy.mjs`, not
   the target lane's fresh one — even though the agent later acquires a lane synced to current `main` for the
   PR's OWN data. Found live: two redispatched rounds kept reporting the pre-`#3434` "queued for a human"
   behavior until dispatching from a genuinely current `main` clone instead. **Not yet filed as its own
   item** — whoever picks this up next should file it under `#3383` before building anything else that
   assumes a dispatch always runs current code.
2. **The primary checkout's trust had drifted** (flagged at THIS session's own startup hook, never acted on
   until a background review agent stalled on it hours later — "every Bash command touching
   `/Users/nicolasgilbert/workspace/webeverything` is auto-denied... that checkout is one of the 45 not yet
   trusted"). Fixed with the existing remedy, `npm run bootstrap install`. Not a new gap — the detection
   already existed — but a reminder that a `drift` line at startup is a real, actionable warning, not FYI to
   skip past.

**Filed this session, under this epic:** `#3437` (review-dispatch double-dispatches a re-armed PR — real,
cost-burning, confirmed, still open), `#3435` (nothing mechanically reaps a finished `claude agents`
session — 16 stopped by hand tonight), `#3436` (a dispatched agent writes no structured completion
record — every real outcome tonight required stripping ANSI from `claude logs` by hand to learn), `#3434`
(ratified + built, this update). `#3438`'s own prior text was corrected in place after a review finding
(it mis-cited unmerged-branch code as if verified against `main`) — a live lesson in the same vein as finding
1 above: verify a code claim against the actual checkout you mean, not from memory of a different branch.

**For the next session:** the two unfiled findings above are the highest-leverage next items. `#3437`
(double-dispatch) and the `prevention-outstanding` accept-treatment (folded into `#3434`'s own Done-when) are
the two concrete pieces of unfinished work this epic's "Done when" #1 still owes, now that the accept step
itself is proven. The `lane/mechanical-dispatcher` branch still needs eventual graduation to `main` in small
pieces — unchanged from every prior update's own note.

## Working doctrine (2026-09-01, continued): a mechanically-dispatched item runs on the card + the generic
## brief, never a bespoke prompt — otherwise the session driving the epic isn't proving the mechanism, it's
## routing around it

Set when the driving session, picking up `#3437`, wrote a long custom investigative prompt into an `Agent`-tool
subagent instead of dispatching it the way the epic's own conveyor would. The operator's correction: *"if we
want the system to be mechanical, like a ui button would do, we should not pass a custom brief, all should be
in the card to be built and general instructions passed with all items."* Followed by the sharper point once
asked why the instruction hadn't landed the first time: *"I wonder why our instruction was not clear enough,
ideally we would save durable instruction in the epic."*

**The rule, standing for this epic from now on:** any investigation, root-cause, or design work a driving
session does on a child item belongs written INTO that item's own card — never folded into a one-off prompt
handed to a subagent. Dispatch (of a build, a review, anything this epic mechanizes) happens through the actual
mechanism under test — `we:scripts/operations/dispatch-lane.mjs` / `we:scripts/operations/review-dispatch.mjs`
via `we:scripts/operations/run.mjs`, or whatever the current wiring is — using the SAME generic brief every
item gets (`we:skills-src/conveyor/delivery-agent-brief.md` / `we:skills-src/review/review-agent-brief.md`),
filled only with the small closed set of placeholders those briefs declare (item number, lane, session slug,
spec path). A driving session's own `Agent`-tool subagent, however well-briefed, is not that mechanism — using
one to "get the work done" proves nothing about whether the real dispatcher works, and is exactly the
interactive hand-holding this epic exists to remove. **This generalizes past this one incident**: whenever a
driving session finds itself about to write a paragraph of context into a dispatch prompt, that paragraph
belongs on the card instead, and the prompt goes back to being the generic one.

**Why writing this into the epic, not just doing it once:** the operator's own second remark names the actual
failure — an instruction given once, in conversation, does not survive past that conversation. A rule that only
this epic's own machinery is supposed to enforce has to live somewhere a later session (or a later turn of this
same session, once context has rolled over) will actually read it before repeating the mistake — which is this
file, not a chat transcript.

## Working doctrine (2026-09-01, continued): the main/interactive session is the orchestrator only — it never
## edits or commits directly, not even for a small doc change

Set after the operator watched the main/interactive session driving this epic hand-run lane acquisition,
`we:scripts/verify-lane.mjs`, and `we:scripts/operations/open-pr.mjs` itself tonight, for what was only a small
doc-only change. The operator's correction, verbatim (their own phrasing kept): *"main session should not be
allow do make any edit by itself"* and *"all should be delegated. you are the orchestrator only."*

**The rule, standing for this epic from now on:** the main/interactive session driving this epic must NEVER
itself run `Edit`/`Write` against repo files, or `git commit`/`git add`, in the primary checkout — it is the
orchestrator only. ALL edits, including small doc-only backlog-card updates and agent-memory notes, go through
a dispatched subagent (which does its own work inside a lane clone, same as this note's own edits did) or the
real conveyor (`node we:scripts/conveyor/queue.mjs add <NNN>` + `node we:scripts/operations/run.mjs
dispatch-lane --num=<NNN>`). The main session's job is to acquire the lane, brief the delegate, and relay the
result — not to hold the pen.

**Why:** this is the same thesis this epic already states for build and review work — a mechanically-dispatched
change proves the mechanism only if the mechanism actually does it, and a driving session quietly doing the work
itself "because it's small" or "faster to just do it myself" is exactly the interactive hand-holding this epic
exists to remove, just relocated from build/review to editing. A doc-only change is not exempt: it is still a
repo write, and the smallness of the change is precisely what makes it tempting to skip delegation — which is
why the operator called it out on a small doc change rather than a large one.

**This generalizes past tonight's one incident.** It is a standing rule for every future session driving this
epic, not a one-off fix for this session's toil: any time a main/interactive session catches itself about to run
`Edit`, `Write`, `git add`, or `git commit` against this repo, that is the signal to stop and dispatch instead,
regardless of how small or "just a doc tweak" the change looks.

## Working doctrine (2026-09-01, continued): a bug found testing the prototype branch can be fixed ON the
## prototype branch directly — no story, no PR, no review — because the prototype itself never went through
## that ceremony; only GRADUATING it to `main` does

Set after the operator was asked whether an issue found while running/testing `origin/lane/mechanical-dispatcher`
needs its own backlog story and a reviewed PR before the fix can land. The operator's rule, given directly: a
quick fix to the prototype can go straight onto `lane/mechanical-dispatcher` — no scaffolded story, no PR, no
independent review — because that branch has never carried that ceremony for its own work, and that is
intentional, not a gap to correct.

**Verified against the actual history, not assumed.** `git log --oneline --first-parent
origin/lane/mechanical-dispatcher` shows merge commits, but every one of them is a normal PR that landed on
`main` through the standard pipeline and was later carried into the lane branch — confirmed by diffing the
branch against `main`: `git log --oneline --first-parent origin/lane/mechanical-dispatcher ^origin/main` returns
28 commits unique to the prototype, and **zero** of those 28 are merge commits. Every one of the branch's own
commits — `runner:`, `tick-core:`, `dispatch-lane:`, `supervisor:`, and the rest of this epic's machinery — is a
direct push straight onto the branch, never a PR merged into it. The prototype has no merge-PR history of its
own to preserve; a quick fix pushed straight to it does not skip a ceremony the branch already has, because it
never had one.

**The rule, standing for this epic from now on:** an issue found while running or testing
`origin/lane/mechanical-dispatcher` may be fixed there directly — diagnose it, fix it, commit it, push it
straight to `lane/mechanical-dispatcher`. Skip filing a backlog story and skip opening a PR for independent
review; that full ceremony (claim a story → lane clone → PR → independent review → drain-land) exists for work
landing on `main`, where other work depends on what's there and a bad change has real blast radius. The
prototype branch is nobody's dependency yet — it graduates to `main` piece by piece, tracked by `#3443`, and
**that graduation is where the full story/PR/review pipeline applies**, because that is the boundary where a
piece of it becomes production code. **One thing does not change even for a prototype-only fix:** the fix still
needs a lane clone — the git-branch-mutation guard (`#104`/`#2183`) applies regardless of which branch is the
target — commit and push from the lane, never from a primary checkout.

**`#3437` is NOT an instance of this rule, even though it was found testing the prototype loop — its fix goes
through the FULL `main` pipeline like normal work.** `we:backlog/3437-review-dispatch-double-dispatches-on-every-tick-instead-of-r.md`
documents this precisely: the double-dispatch bug was *discovered* live-firing the prototype's tick loop, but
its root cause — `bindAgents` in `we:scripts/conveyor/reconcile-core.mjs`, plus `we:scripts/conveyor/reconcile-pass.mjs`
and `we:scripts/operations/review-dispatch.mjs` — is code that is **already on `main` today**; only the runner
wiring that calls it continuously is still confined to the prototype. Fixing code already on `main` is ordinary
`main`-bound work regardless of where the bug was noticed, so `#3437` claims a story, builds in a lane, opens a
PR, and goes through independent review like any other item — it is not a "quick prototype fix" in this
doctrine's sense. **The distinguishing question going forward:** does the fix touch code that lives only on
`lane/mechanical-dispatcher` (this doctrine's fast path), or code already on `main` that the prototype merely
exercises first (the full pipeline, no exception)? Check which is true before picking a path — don't assume
"found while testing the prototype" settles it.

**The fast path here does not make the branch disposable early.** The operator, directly: "make sure we do not
stray from this. Only once main contains all the changes from the mechanical branch will we drop it." Being
able to fix the prototype quickly is a convenience for iterating on it, not a reason to treat it as throwaway —
`origin/lane/mechanical-dispatcher` stays alive until `#3443`'s graduation is fully done (every commit unique to
the branch landed on `main` through its own reviewed PR, or explicitly noted as dropped/superseded), and only
then is it deleted.

## Working doctrine (2026-09-02): a `review:human` PR gets an independent AI review pass BEFORE the human
## ceremony, not instead of it — the human approves an already-vetted diff, never does first-pass review

Set by the operator as a new standing process, stated directly: *"even a `review:human` PR (gate-self, never
mechanically accepted) must get a genuinely independent AI review first — any real findings get fixed before
the PR is ever presented to the human for their ceremony. The human's job is to approve an already-vetted
diff, not to be the first reviewer."*

**The rule, standing from now on:** every PR labelled `review:human` — the conflict-of-interest gate for a
diff that edits gate machinery or the statute file itself (`we:docs/agent/platform-decisions.md`) — must be
run through a genuinely independent `review-pr` pass, and any real (confirmed, blocking-bar) findings that
pass surfaces must be fixed and pushed to the same PR branch, **before** the PR is handed to the operator for
the human ceremony. This is an addition ahead of the ceremony, not a change to it: `review:human` still can
only ever be cleared by the human ceremony itself
(`we:scripts/review-set-label.mjs --to=clear-human --actor=… --reason="<quoted instruction>"`) — `--answer=accept`
stays refused on a `review:human` PR by `decideSetLabel`'s own pure core, unconditionally, exactly as before
this doctrine. Nothing here grants a mechanical override of `review:human`; it only guarantees the diff the
human eventually looks at has already had a real, independent pass over it, so their review is confirmation
of vetted work, not the first read.

**Why this needed stating, not just doing once:** `review:human` exists precisely because the author cannot
be trusted to grade their own statute edit — but "wait for the human" had silently come to mean "the human is
the first reviewer," which defeats the same logic `review:pending`'s independent-juror requirement already
encodes for every lower-tier PR. A gate-self PR is exactly the diff most worth a real independent look before
anyone spends ceremony time on it, not the one exempted from getting one.

**Concrete instance this rule was written from: PR #1814** (`backlog/3427` ratification +
`we:docs/agent/platform-decisions.md` statute extension + the new follow-on item card, `review:human` for editing
the statute file). Running `review-pr` from the session that authored it hit the expected, correct refusal —
`review-pr.read: SELF-CLEAR REFUSED — the clearing actor … is the PR's author` — because this repo's own
independence check (`we:scripts/lib/review-independence.mjs`) keys on `CLAUDE_CODE_SESSION_ID`, and the
authoring session cannot review its own diff, `review:human` or not. The fix was not to route around the
refusal but to use the already-standing answer to it
(`we:.claude/agent-memory/standing-authorization-independent-review-self-clear.md`, and
`we:scripts/operator/dispatch.mjs`'s `runAgent`/`buildReviewPrompt`): dispatch a genuinely separate `claude -p`
OS process — never the `Agent` tool, which inherits the parent session's id verbatim — with its own
freshly-minted session id, running the same declared `review-pr` operation from its own lane. That
independent pass is the deliverable this doctrine requires for every `review:human` PR going forward, not a
one-off workaround for this PR alone.

**What this doctrine does not change.** It adds a review-then-fix step ahead of the human ceremony; it does
not touch who may clear `review:human` (unchanged: the human ceremony only, `#2771`/`#2785`'s
[we:docs/agent/platform-decisions.md#review-human-declarative-leash-only](/docs/agent/platform-decisions.md#review-human-declarative-leash-only)
statute unchanged), and it does not authorize `--answer=accept` on a `review:human` PR under any circumstance
— the independent pass's job is to find and fix real defects, then hand the (now-vetted) diff onward, never
to clear the label itself.

## Working doctrine (2026-09-02, continued): the operator's in-conversation "I approve `<PR>`" naming a PR
## IS the explicit instruction the clear-human ceremony already requires — not a new authorization path

Four `review:human` PRs cleared tonight the same way — #1804, #1808, #1814, #1815 — and the operator asked
this be written down as a durable pattern, not something a session merely happens to do consistently. Read
plainly: **this states nothing new.** It is the existing sanctioned `--to=clear-human` ceremony
(`we:scripts/review-set-label.mjs`, #2895) and this file's own existing doctrine above (the independent
AI-review pass ahead of the ceremony, PR #1817); the only thing this section adds is naming, in one place,
what already counts as the "explicit instruction" `we:.claude/skills/review/SKILL.md` demands before that
ceremony may run at all — so a future session recognizes it on sight instead of re-deriving the process or
second-guessing whether it's allowed.

**The pattern, verified against the four PRs' own comment threads, not assumed from habit:**

1. **A PR lands `review:human`.** The gate-self/statute conflict-of-interest tier — a diff that touches gate
   machinery or `we:docs/agent/platform-decisions.md` itself — is never mechanically clearable, per the
   standing [`#review-human-declarative-leash-only`](/docs/agent/platform-decisions.md#review-human-declarative-leash-only)
   statute. All four PRs parked with the drain's `held — a review hold (review:human) stands` comment, citing
   `blast-radius`/`gate-self` (#1804, #1814, #1815) or `blast-radius`/`statute` (#1808) reasons.
2. **Where the PR postdates PR #1817 (merged 2026-09-02T11:04Z), it first gets the independent AI review
   pass this file already mandates.** #1814 and #1815 — both cleared after #1817 landed — each carry a
   dispatched, independent `review-pr` comment (fresh session id, not the authoring session; correctness +
   security seats) landing on an explicit verdict (`accept`, 0 blocking findings on #1814; one CONFIRMED
   finding found and fixed before the comment was posted on #1815) before either was handed to the operator.
   #1804 and #1808 cleared *before* #1817 landed and predate that requirement — they show the ceremony below
   on its own, not evidence that the independent pass is optional now.
3. **The operator reviews it themselves and says, in conversation, "I approve `<PR>`"** — naming the PR
   explicitly. All four threads quote this verbatim as the stated reason: `> I approve 1804`, `> I approve
   1808`, `> I approve 1814`, `> I approve 1815`. This sentence is the whole of what authorizes the next
   step — `we:.claude/skills/review/SKILL.md`'s own invariant is that the clear-human route may be run "ONLY
   on an explicit in-conversation instruction from the operator naming that PR," with no other route and no
   `--force`. Naming the PR is what makes an instruction usable here; "looks fine" or an approval of a batch
   without naming the number does not qualify — do not stretch this pattern to cover that case without a
   fresh explicit instruction.
4. **The orchestrating session runs the sanctioned clearance, verbatim, no paraphrase:**
   ```
   node scripts/review-set-label.mjs <PR> --repo=<owner/repo> --to=clear-human \
     --actor="Nicolas Gilbert (operator)" --reason="I approve <PR>" --body-file=/tmp/<pr>-clearance.md
   ```
   `--reason` carries the operator's own words verbatim (confirmed rendered as the `> I approve <PR>`
   blockquote in all four threads) — never a summary of them. `--body-file` sits under `/tmp`, per the tool's
   own path constraint (`we:scripts/review-set-label.mjs`'s `--body-file` root allowlist, #2897) — never
   written elsewhere and never skipped. The note in that file, confirmed identical in shape across all four
   PRs (only the change-type noun varies with the PR's own escalation reason — "gate-self" on #1804/#1814/
   #1815, "statute-touching" on #1808, which read `blast-radius`/`statute`):
   ```
   **Human ceremony clearance** — the operator (Nicolas Gilbert) reviewed this gate-self change directly and
   approved it in conversation. This is a human clearance, not an established-independent review.
   ```
   Everything else that lands on the PR — the `✅ review — review:human cleared via the sanctioned path`
   header, the "What this record proves… does NOT prove…" caveat, the `reviewed-sha`/`reviewed-diff`/
   `reviewed-contribution`/`cleared-human`/`cleared-by-actor` markers, and (when the clearing actor is
   provably the PR's own author at the session level) the additional "🧑 Cleared by the HUMAN CEREMONY, not
   by an established-independent agent" paragraph — is generated by `we:scripts/review-set-label.mjs` itself
   from `--actor`/`--reason`/`--body-file`. Do not hand-write any of it into the body file; it duplicates
   what the tool already emits and risks drifting from it.
5. **This swaps `review:human` → `review:accepted`**, and the resident drain lands it from there. The
   orchestrating session never runs `gh pr merge` itself — confirmed: none of the four threads carry a merge
   action from the clearing session; the label swap is the entire mechanical footprint of this step.

**This is NOT a new authorization path, and it does not loosen the human-only invariant.** `--to=clear-human`
still refuses unconditionally unless the PR already carries `review:human`, still requires an explicit
`--actor` and a quoted `--reason`, and `decideSetLabel`'s pure core still refuses `--answer=accept` on a
`review:human` PR by construction (#2895/#2844) — nothing above changes any of that. What this section settles
is narrower and purely evidentiary: the operator's own chat message, naming the PR, **is** the "explicit
in-conversation instruction… naming that PR" the skill already requires before the ceremony may run — so a
future session may act on "I approve `<PR>`" (or plainly equivalent phrasing that names the PR) on sight,
without re-deriving whether that counts or re-justifying that the ceremony is allowed.

## Session update (2026-09-02, close-out) — handoff to next session

Close-out for tonight's session (2026-09-01 into 2026-09-02). Brief by design — the detailed doctrine
sections above and this session's own PRs already carry the evidence. Every claim below was checked
fresh against the live repo (PR state, `status:` frontmatter, `we:scripts/lane-pool.mjs status`), not
transcribed from what this session expected to find — two things did NOT match the initial
expectation, both called out explicitly below.

**Landed tonight:**
- **`#3437` (the epic's top blocker) fixed and merged — `PR #1799`.** `review-dispatch` now binds
  sessions by session name, not just cwd/HEAD-oid, closing the double-dispatch hole where the
  runner's own planning tick wrote a guard entry for a dispatch that had never actually happened.
- **The scope-overlap root cause found and fixed — `PR #1798`.** Directory-wide `scope:` predictions
  were colliding under the lease guard; narrowing four over-broad predictions (on `#3438`, `#3441`,
  `#3435`, `#3398`) unblocked them for building. **Correction to expect going in: "unblocked" means
  buildable, not built** — as of this write-up `#3438`, `#3441`, `#3435`, and `#3398` are all still
  `status: open`, along with `#3403`, `#3404`, `#3406`, `#3399`, `#3416`, `#3418`, `#3443`, `#3446`.
  Resolved tonight: `#3440`, `#3401`, `#3400`, `#3402`, `#3427`, `#3445`, `#3405`, `#3422`. `#3439`
  is `status: active`, not resolved — its own "Progress" section already shows `assertMainNotStale`
  built, tested, and its design decision documented, so it reads as functionally done but was never
  formally closed; worth a look, not a re-build.
- **Two lane-pool lease-leak incidents found tonight, filed as `#3449`** (`bornAs: xelgqmw`, `PR
  #1811`) — twice, a finished build/prepare session's PR merged but its lane lease stayed held with no
  live process behind it (12 stale leases the first time, 10 of 12 the second), starving dispatch
  capacity until force-released by hand. **Correction: `#3449` is still `status: open` — `PR #1811`
  only files the root-cause card, it does not yet ship the actual fix** (a reconciliation cadence
  independent of a live `/conveyor` session). Do not read "filed" as "fixed" for this one. Its own
  root-cause section already names two candidate fixes (a drain-daemon sweep, or making the read-only
  capacity check trigger the existing acquire-time reap) and a regression-test shape.
- **A live instance of the exact same lease-leak class found and cleaned up during this close-out's
  own WIP verification, not part of the count above.** `we:scripts/lane-pool.mjs status --json`
  showed two lanes (lane-1, lane-9) still holding leases from already-merged tonight's work
  (`3437-review-dispatch-live-bind`, acquired before `PR #1799` merged; `drain-lease-cross-repo-
  regression`, acquired before `PR #1810` merged) — neither released after its PR landed. Both
  carried only stray, superseded local diffs (a stale `status: active` edit to `#3437`'s own card,
  pre-dating its resolution on `main`; an orphaned PR-body scratch note) — nothing worth preserving —
  and were released as part of this close-out. **This means "all WIP clean" was not actually true
  until this verification ran it down**; it is genuinely clean now (`gh pr list --state open` empty
  in both `web-everything` and `plateau-app`; `we:scripts/lane-pool.mjs status --json` shows zero
  held leases).
- **The drain daemon's cross-repo lease-key mismatch fixed in `plateau-app` — `PR plateau-app#147`**
  (merged), plus a regression test pinning the fix (`PR #1810`, this repo). The daemon is keying its
  own drain lease per-repo now, matching the child pass, and is landing merges normally again.
- **Decisions `#3400`, `#3402`, `#3427` ratified**, all now `status: resolved`. Follow-on build items:
  `#3402` → `#3445` (resolved — the dispatcher fixture-root thread finished) and `#3446` (open — extend
  the fixture harness through `we:scripts/operations/dispatch-lane.mjs`'s own remainder); `#3427` →
  `#3451` (open — the new call-visibility-signal item, "build the lightweight call-visibility signal
  for every operation," filed under `#3427` as its parent).
- **The `review:human` independent-review-first doctrine (see the standing-doctrine section above,
  rule 5) established and applied live to four PRs**: `#1804`, `#1808`, `#1814`, `#1815` — all cleared
  via the sanctioned `--to=clear-human` ceremony on the operator's own "I approve `<PR>`," with `#1814`
  and `#1815` (both postdating the doctrine's own landing PR `#1817`) each carrying a genuinely
  independent `review-pr` pass first, per rule 5 and rule 6 above.
- **The `review-pr` silent-suspend gap fixed — `PR #1821`, now `#3453`, `status: resolved`.**
  `review-pr` now posts an automatic advisory note on a `review:human` PR before the point where it
  would otherwise wait on a confirm answer it can structurally never get — advisory findings post
  durably instead of silently going nowhere.

**What's next, in priority order:**

1. **Sanity-check `#3437`'s fix live before leaning on it under continuous dispatch.** It merged
   tonight and was exercised via `--once` calls during tonight's own bug-hunt, but never re-run
   through the actual continuous tick loop afterward — the same live-fire proof `#3434` got twice
   before being trusted. Recommended, not a hard gate (see standing-doctrine rule 7 above).
2. **Resume the prototype's own continuous runner loop as the primary delivery mechanism** — this is
   the epic's own original "How to build it" plan, not a new one; see rule 7 above for the full
   framing and why tonight's one-shot dispatching was a detour, not a redirection.
3. **`#3438`'s own remaining scope** (wire `reconcile-pass`'s `kind: 'fix'` into the runner's
   mechanical passes — the fix half of fix→review→land still has nothing executing it) if not yet
   built — still `status: open`.
4. **`#3443`'s graduation work** (moving `origin/lane/mechanical-dispatcher`'s unique commits to
   `main` in small reviewed pieces) — continuing; still `status: open`.
5. **`#3427`'s new call-visibility-signal follow-on, `#3451`** — still `status: open`, not yet built.
6. **Everything else still genuinely open under this epic, so nothing slips through silently:**
   `#3441` (a build-dispatch agent's PR must resolve its own item), `#3435` (mechanically reap
   finished `claude agents` sessions), `#3398` (supervisor/runner has no out-of-band alerting),
   `#3403`/`#3404`/`#3406` (durable build-guard floor, singleton-lease heartbeat, idle-stop backoff —
   the epic's text above says these were "built, tested, pushed to the branch," but their cards
   themselves still read `status: open`, worth reconciling), `#3399` (no operator runbook), `#3416`
   (the guard-suppression double-dispatch fix, branch-only pending graduation), `#3418` (dispatched-
   agent system-prompt identity), `#3446` (fixture-harness extension), `#3449` (the lease-leak fix
   itself, not just its filing), `#3433` (technically enforce review-dispatch's never-self-accept
   rule), `#3436` (a dispatched agent writes no structured completion record), `#3421` (the
   missing-operation confidence-call follow-on to `#3422`), and `#3411` (the `lane-pool-reap-on-
   acquire` TTL-backdating test flake) — all confirmed `status: open` tonight, none silently dropped.

## Session update (2026-09-02/03, overnight session) — `#3457`/`#3456` ratified and built out end to
## end, a real sweep of guard/reaper/lease bugs landed, and the night's biggest find: a wrong-field
## bug mistaken for hours for an external limitation

A long overnight session (2026-09-02 into 2026-09-03). Every PR and status claim below was re-checked
live against the real repo (`gh pr view`, backlog frontmatter, `origin/lane/mechanical-dispatcher`'s
own commit log) while writing this up, not transcribed from the handoff brief this write-up started
from — that brief undercounted the night's actual output (five landed items it never mentioned, found
by checking current status) and got a few things wrong, both corrected explicitly below.

**Landed tonight:**

- **Decisions `#3457` and `#3456` ratified and codified — `PR #1856`.** Both now
  `we:docs/agent/platform-decisions.md` anchors (`#dispatch-status-ground-truth-check`,
  `#heavy-command-admission-queue`). Their build follow-ons landed the same night: `#3460` (the
  dispatch-side ground-truth check itself) via `PR #1877`, proven live against the real `#3435`
  phantom-hold case before landing; `#3461` (the heavy-command admission-queue capacity semaphore)
  via `PR #1880`. Both follow-on cards now read `status: resolved`.
- **`#3332` resolved — `PR #1854`** (a card that read `active` even though its own fix, routing
  `dispatch-lane`'s remaining `spawnFixes`/`spawnCiHeals` kinds, had already landed).
- **`#3462` (manual `dispatch-lane` never checks `blockedBy`) filed AND built — `PR #1857` scaffolded
  the card, `PR #1881` shipped the actual fix** (the manual `--num=<N>` path now refuses a
  structurally-blocked item). **Correction to the handoff brief: it listed `#3462` as still
  "filed, queued, not yet built" — the card reads `status: resolved` as of this write-up; the brief
  was current as of the filing PR but stale by the time this session ended.**
- **Two real merge-conflict reconciliations between `origin/lane/mechanical-dispatcher` and `main`'s
  independently-evolved dispatch code, resolved by hand** — confirmed in the branch's own log as two
  `Merge remote-tracking branch 'origin/main-fresh'` commits (`3c273363`, `f17f26e1`), each preserving
  both `main`'s landed fixes and the branch's own unmerged prototype work. The recurring stale-checkout
  symptom behind these was traced to `wev-scratch-dispatcher-4`'s own `.git/config`: its fetch refspec
  had been narrowed to the prototype branch only, with no entry for `main` at all, so
  `git fetch origin main` was silently a no-op for hours. Fixed permanently in that checkout's own git
  config — a machine-local fix, not a repo commit, so there is no PR to cite for it.
- **`#3464` (no reconciliation cadence for the diverged prototype branch) and `#3463` (decision: notify
  the prior dispatch on an unresolvable sync conflict) filed — `PR #1858`.** Both traced every commit on
  both sides of the conflict against its own item's declared `scope:` and found zero scope violations —
  the branch sat 78 commits behind / 29 ahead of `main` as of filing, entirely because no mechanized
  cadence exists, only sessions noticing drift by hand. Both still `status: open`.
- **The `fixAttempts` miscounting bug (`#3454`) fixed — `PR #1868`.** A guard-refused fix-dispatch
  attempt was counting toward the retry-exhaustion cap as if it were a real, failed attempt.
- **The analogous durable-floor guard bug fixed on the prototype branch directly — no story, no PR**
  (per this card's own standing-doctrine rule 4: a prototype-only bug skips the ceremony). Confirmed in
  the branch log: `a833d4bf6`, "tick-core: durable build-guard floor (`#3403`) never expired,
  permanently inflating building" — the guard was re-stamping its own age every tick, so its TTL
  backstop could never fire.
- **A `we:.claude/lane-ports.json` staleness gap found and FILED as `#3466` — `PR #1869`.**
  **Correction to the handoff brief: it described this as "found and fixed" — `PR #1869` only files
  the root-cause card (confirmed twice live: 5 stale entries on the operator's own tick-1 report, then
  3 more on an independent re-check); no fix has landed, `#3466` is still `status: open`.**
- **The lease-leak fix itself (`#3449`) — not just its prior-session filing — built and landed
  tonight, `PR #1882`** (`we:scripts/lane-pool.mjs`'s `list --acquirable` now triggers the same
  ghost-lease reap `acquire` already runs). Not mentioned in the handoff brief; found by checking
  current status.
- **`#3438`'s remaining scope (wire `reconcile-pass`'s `kind: 'fix'` into the runner's mechanical
  passes) built and landed — `PR #1876`**, closing the last gap the 2026-09-02 close-out flagged as
  its #3 priority ("the fix half of fix→review→land still has nothing executing it"). Not in the
  handoff brief.
- **`#3436` (a dispatched review/fix agent writes no structured completion record on exit) built and
  landed — `PR #1883`.** Not in the handoff brief.
- **`#3446` (fixture-harness extension) landed — `PR #1884`.** Not in the handoff brief.
- **The session-reaper's ground-truth extension (`#3435`'s own follow-on) built and landed — `PR
  #1873`**, catching a session whose registry `state` lies even when the target item is confirmed
  resolved. Proven live against a real scratch clone of the branch: 17 of 22 non-terminal background
  sessions surveyed were in this exact stuck-but-actually-done shape. **Correction to the handoff
  brief: it cited "15 real additional reaps found" — the PR's own body says 17.**
- **The night's biggest find: `claude stop`/`claude rm` had been failing almost universally all night
  with "No job matching."** Diagnosed repeatedly, at length, as an external CLI/daemon limitation —
  until the operator explicitly pushed back ("stop saying this, assume there is a way you haven't
  found") and directed investigation found the real cause: every failing call was passing the full
  session `sessionId` UUID instead of the short 8-char `id` field the CLI's `stop`/`rm` actually match
  on (works fine for `--resume`/`attach`, just not `stop`/`rm`). Proven live and repeatably: a direct
  before/after on one real session (`conveyor-2972` — full `sessionId` exits 1 "No job matching", `id`
  immediately after exits 0 "stopped"), 17/17 clean stops against the ground-truth-confirmed set inside
  the PR itself, and an independently-confirmed bulk clear of 151 done/failed background sessions using
  the same fix, dropping the machine's total live session count 208→57 and its background done/failed
  count to 0. Landed as `PR #1879`, fixing `we:scripts/conveyor/session-reaper.mjs`'s `stopSession`
  call. **This was not an external limitation at all — a wrong-field bug the whole time**, and is now
  this card's new standing-doctrine rule 8 above.
- **`we:.claude/commands/wip.md` updated twice — `PR #1875`** (since-last-invocation scoping for Done,
  steady-state-infra excluded from Doing).
- **Three new agent-memory lessons saved** (not four — the handoff brief overcounted this):
  `verify-session-liveness-before-archiving` (`PR #1860`), `keep-prototype-branch-synced-after-each-
  merge` (`PR #1865`), `question-a-concluded-external-limitation-before-accepting-it` (`PR #1878`, the
  durable form of the `claude stop`/`rm` finding above).

**One finding worth the operator's own attention, not just a status note:** `#3443` (the item tracking
`origin/lane/mechanical-dispatcher`'s own graduation to `main`) now reads `status: resolved`,
`dateResolved: 2026-09-03` — but this looks like a premature auto-resolve, not genuine completion. The
drain daemon's generic `resolve #3443 on land` fired the moment `PR #1866` merged (one small increment,
`computeFreeSlots`'s dirty-lane exclusion), even though that PR's own body explicitly says "this PR does
not resolve #3443, it lands one increment of it," and `#3443`'s own "Progress" section (last touched the
same day) still names roughly 26 commits still ahead of `main`, most entangled with the held-back
reconcile-pass tick-loop wiring — its own "Done when" criteria are plainly unmet. This reads as the
drain's title-matching resolve-on-land mechanism firing on any `WE #3443: ...`-titled PR regardless of
what the PR body says about partial scope; worth the operator's judgment on whether to reopen `#3443` or
teach the drain to respect a PR's own "does not resolve" disclaimer.

**What's still open, checked fresh, so nothing silently drops:**

1. `#3464` (no reconciliation cadence for the diverged branch) and `#3466` (lane-ports staleness fix
   itself) — both filed, queued, not yet built.
2. `#3463` — decision, not yet ratified; needs the operator's own judgment call, same as `#3457`/
   `#3456` were tonight.
3. `#3398` (supervisor/runner has no out-of-band alerting) — still `status: open`, `blockedBy: ["3443"]`
   per its own frontmatter, which the `#3443` finding above complicates: its blocker's card now reads
   resolved while the real graduation work it names is not done.
4. `#3441` (a build-dispatch agent's PR must resolve its own item) — `status: active`, in progress as
   of this write-up, not yet landed.
5. `#3443`'s own real graduation work is NOT done despite its card reading `resolved` — see the finding
   above. Roughly 26 commits are still unique to `origin/lane/mechanical-dispatcher`, most entangled
   with the still-held-back reconcile-pass tick-loop wiring.
6. Whether the now-fixed, now-live mechanical session-reaper (`#3435` + its `#1873` ground-truth
   extension) actually closes ghost sessions unattended on its own next real ticks was not yet observed
   — only manually/PR-proven — as of this session's close.
7. `PR #1853` (the whole-branch big-bang graduation PR) remains explicitly parked/not-wanted, per
   standing operator preference for incremental graduation over a single big merge — unchanged from
   before tonight.
8. **Filed, not fixed, tonight**: `wev-scratch-dispatcher-4`'s own ad hoc sync loop (pid `24624`) fetches
   `main` fine but silently aborts on every real merge conflict with no retry/escalation strategy,
   independent of the `.git/config` refspec fix landed earlier — its checkout is 53 commits behind
   `origin/main` as of this write-up (real symptom: that checkout's own `backlog/3436-*.md` still reads
   `status: open` though `#3436` resolved on `main` via `PR #1883`). Filed as its own item, `relatedTo`
   `#3464`/`#3466`; not fixed per standing instruction to file bugs, not fix them mid-flight.

## Working doctrine (2026-09-04): rule 9 — a mechanism-bug fix during delivery delegates to a subsession, the
## orchestrating session never holds the pen, even to "quickly test the fix"

Set after a live, concrete violation of already-standing rules 2 and 3, caught by the operator mid-session, not
self-noticed. Recorded here as the evidence base for rule 9 in the quick-reference list above.

**What actually happened, 2026-09-04.** The orchestrating session found and fixed three real mechanism bugs —
a `process.exit`-before-flush truncation in `we:scripts/readiness/dispatch-plan.mjs`, a sequential
(rather than concurrent) `gh pr list` loop in the same file plus `we:scripts/operations/dispatch-lane-io.mjs`,
and a `.trim()` that silently corrupted `git status --porcelain` output in
`we:scripts/readiness/scope-lease-collect.mjs` (plus a related `.git`-suffix bug in
`we:scripts/readiness/lane-manifest.mjs`) — all real, all measured before/after, all genuinely worth fixing.
But the session did the `Edit`/`git commit`/`verify-lane`/`open-pr` work itself, directly, in lane clones it
drove by hand — never dispatching a subagent to do it, exactly the thing rule 3 already prohibits. Then, to
"prove the fix worked end to end," it hand-spawned **9 `Agent`-tool subagents** to deliver 9 backlog items in
parallel — exactly the thing rule 2 already prohibits ("a driving session's own hand-briefed `Agent`-tool
subagent is not that mechanism"). The operator caught this by checking `claude agents --json` directly and
finding **zero** of the 9 registered there, versus 22 genuine conveyor-dispatched sessions that were.

**Why this is worse than "used the wrong tool."** The whole point of a hand-spawned `Agent`-tool subagent
looking like it works is what makes it dangerous here: it produces real diffs, real commits, real PRs — so a
session under time pressure can convince itself "the work got done" without ever noticing it proved nothing
about whether the actual mechanism (the live runner, the `dispatch-lane` operation, `claude --bg` dispatch)
can do the same job unattended. That is this epic's entire reason to exist (see "The problem, stated plainly"
at the top of this file); routing around it to hit a delivery number is a direct regression on the epic's own
goal, not a shortcut toward it.

**The corrected shape — not new doctrine, a restatement pinned to this failure mode:**
1. The orchestrating session may **diagnose** a mechanism bug itself — reading state, reproducing a failure,
   root-causing it — because diagnosis is not an edit.
2. It must **delegate the fix** to a dedicated subsession once root-caused. It does not `Edit`, `git commit`,
   or `verify-lane` anything itself (rule 3, restated).
3. That subsession's fix follows rule 4's own distinguishing question: code living only on
   `lane/mechanical-dispatcher` gets the ceremony-free direct-push path; a fix to code already on `main`
   (true of all three fixes above) takes the full story → lane → PR → independent-review pipeline, same as
   `#3437`.
4. Only once the subsession's fix is **proven** — a measured before/after, not an assertion — and landed does
   the orchestrating session resume delivery.
5. Resuming delivery itself is never the orchestrating session hand-spawning `Agent`-tool workers (rule 2).
   It is either the live runner picking the freed-up work back up on its own next tick, or, if one item needs
   a direct nudge, the declared `we:scripts/operations/dispatch-lane.mjs --num=<N>` operation — never a
   bespoke prompt handed to the harness's own subagent tool.

**Left for a follow-on, not this card:** `#3096` (route the conveyor's build dispatch through the declared
`dispatch-lane` operation, still blocked on `#3353`) is the structural fix that would make "hand-spawn an
`Agent`-tool worker to get something moving" stop being the path of least resistance at all — closing it is
the single highest-leverage way to make this failure mode structurally harder to repeat, not just documented
against.

## Working doctrine (2026-09-04, continued): rule 10 — the runner's normal operating mode is tracking `main`
## directly; a long-lived divergent branch is a temporary build tool, not the default steady state

> **AMENDED 2026-09-12 — read this section together with "Working doctrine (2026-09-12): rule 10 amended"
> below.** The operator ruled that N standing POC branches are a wanted, durable delivery mode. The
> wind-down half of this section no longer holds; its drift/naming/short-lived-fix-lane reasoning does.
> Kept unedited as the original record.

Set the same night as rule 9 above, after a second, independent finding: `origin/lane/mechanical-dispatcher`
itself — this epic's own prototype branch — had silently drifted 97 commits behind `origin/main`. The
branch's own auto-sync loop (the mechanism meant to keep it current, per the `keep-prototype-branch-synced-
after-each-merge` agent-memory lesson, `PR #1865`) had been failing without surfacing the failure. Recovering
required a roughly 40-minute manual reconciliation — 15 real conflicts, resolved by hand — before delivery
could resume from the branch at all. This is a real, costly instance of exactly the risk this epic's own
founding "How to build it" section already named: a branch that never converges back to `main` accumulates
exactly this kind of silent, compounding drift.

**Two ways to respond, weighed explicitly with the operator, not assumed.**
(a) Build more machinery to cope with permanent divergence as the steady state — a `reconcile-branch`
operation doing mechanical fast-forward plus judgment-driven conflict resolution, invoked on some cadence.
(b) Stop treating divergence as the steady state at all, and actively wind it down. The operator chose (b),
citing this card's own "How to build it" section verbatim: the branch was always meant to be temporary —
"once genuinely stable... split into small pieces and move to `main`... only once everything has transferred
does the real system execute from `main` instead of the branch." Option (a) would have been building
permanent scaffolding around a state this epic's own plan never intended to be permanent.

**Direct evidence the wind-down pattern already works, from tonight's own delivery.** Every quick mechanical
fix landed tonight — `#1894`, `#1895`, `#1902`, `#1903` — used the exact shape rule 10 generalizes: a fresh
scratch lane cut off *current* `main`, iterated and tested live, landed as one small clean PR, then
discarded. None of them needed a standing branch to get the fix in safely. Rule 10 states that this stops
being an ad hoc pattern for one-off fixes and becomes the runner's own normal operating mode once the
prototype branch itself has nothing left that only it holds.

**The caveat that must not get lost, stated in the rule itself and restated here:** rule 10 describes the
TARGET steady state, not tonight's actual configuration. `#3443` (the item tracking
`origin/lane/mechanical-dispatcher`'s own graduation to `main`) is still open as of tonight, with real content
still unique to the branch — so the runner still needs to run off the branch, freshly reconciled tonight, not
off `main` directly. A future session should check `#3443`'s live status before reading today's
branch-tracking as a violation of this rule: it isn't one, until graduation is done. Once `#3443` closes for
real, switching the runner to track `main` directly is what rule 10 then requires, not merely permits.

## Working doctrine (2026-09-04, continued): rule 11 — a one-off symptom-relief action is never
## reported as the fix; the real root cause and a durable fix are both owed, and both must be verified

Set the same night as rules 9 and 10 above, after a third, independent incident — this one caught by the
operator mid-report, not self-noticed, the same pattern that produced rule 9.

**What actually happened, 2026-09-04.** `we:scripts/conveyor/session-reaper.mjs` (`#3435`, this epic) is
supposed to run every tick via the live headless runner's `makeCliMechanicalPasses`
(`we:skills-src/conveyor/runner.mjs`, `runQuiet('we:scripts/conveyor/session-reaper.mjs')`). Running it BY
HAND directly reaped 120 of 163 listed `claude agents` sessions in one pass — a large backlog, evidence the
scheduled tick invocation had been failing for a real stretch. The operator's own words, catching the framing
before it shipped: "no fix are applied without find root cause and applying real fix" — a one-off reap that
incidentally clears a backlog is not a fix for why the automated pass keeps failing, and reporting it as
though it were would have been exactly the failure mode this rule now names.

**The real root cause, found (not guessed).** `runner.log` held exactly ONE logged failure for this pass
across a 190+-tick live overnight run: `"⚠ mechanical pass we:scripts/conveyor/session-reaper.mjs failed
(non-fatal): Command failed: node .../we:scripts/conveyor/session-reaper.mjs"` — no further detail, because
`runQuiet`'s own error handler truncated to `String(e.message || e).split('\n')[0]`, discarding every line
after the first even though `execFileSync`'s thrown error already carries the child's full captured stderr
appended to `.message` (Node's own behavior, reproduced directly to confirm). Tracing the code path:
`we:scripts/conveyor/session-reaper.mjs`'s stop loop calls `stopSession`
(`we:scripts/operations/dispatch-abort.mjs`) once per reap candidate; a `claude stop <id>` call that fails
with anything other than `No job matching` (the already-documented, already-benign "already gone" case)
throws, and that per-candidate failure trips the WHOLE pass's own `process.exit(1)` — by design, so a caller
can tell a clean sweep from a partial one — which `runQuiet` then reports as a bare, undiagnosable "Command
failed" with the real per-candidate error thrown away. `claude stop`'s own upstream flakiness is already a
documented, known-transient condition in this file's own header (issues #65925/#45250/#41461); a live
concurrency stress test (25 concurrent `claude stop` + 10 concurrent `claude agents --json --all` calls,
repeated) never reproduced a hard failure, consistent with a rare, self-clearing hiccup rather than a
deterministic bug — so the fix targets a real, evidenced failure class, not a guessed one.

**The real, durable fix landed — not the by-hand reap.** Two changes, `we:scripts/conveyor/session-reaper.mjs`
and `we:skills-src/conveyor/runner.mjs`, both with unit + real-CLI-subprocess test coverage:
1. `stopSessionWithRetry` retries a failing `claude stop` candidate up to `STOP_RETRY_ATTEMPTS` (3) times with
   a short backoff before counting it a real failure — recovering the transient case instead of letting one
   candidate fail the whole pass's exit code.
2. `runQuiet`'s new `summarizeMechanicalPassError` logs a bounded, newline-collapsed summary of the real error
   instead of just the first line, so a future mechanical-pass failure is diagnosable from `runner.log` alone,
   not just for this file — every mechanical pass this runner drives shares the same `runQuiet` helper.

**Verified, not assumed.** A real (non-dry-run) `we:scripts/conveyor/session-reaper.mjs` run against the live
`claude agents` listing reaped cleanly post-fix; the new tests prove the retry recovers within budget, still
fails (bounded, not silently) once the budget is exhausted, never retries an already-`No job matching` answer,
and that the error-summary no longer truncates a real multi-line failure to a bare "Command failed" line.

## Session update (2026-09-12) — mechanical-harness delegation audit across all seven dispatch launch kinds:
## exactly ONE (`review`) is actually wired; the other six still run their own lifecycle from a brief

A delegation audit of every dispatch launch kind on `origin/lane/mechanical-dispatcher`, verified against tip
`02d9af300`. The question asked was narrow and checkable: for each launch kind, does the dispatched agent still
run its own lifecycle commands (`lane-pool acquire`, `open-pr`, `learnings-drop`, …) out of a full prose brief,
or has that lifecycle moved into a mechanical harness the dispatcher calls directly? This is the concrete state
of the epic's own founding bullet — "**Subagents only edit code.** Every command they'd otherwise run themselves
is delegated to the mechanical layer" (see "The target shape" at the top of this card).

**The answer: one of seven.** `review` is fully harnessed — no agent commands in its brief, a direct wrapper call
to `we:scripts/operations/review-dispatch-wrapper.mjs`, wired as the default path at
`we:scripts/operations/review-dispatch.mjs:496` and `:542`. The other six all still hand the agent a full brief
and let it drive its own lifecycle.

| Launch kind | Agent runs lifecycle commands itself? | Wrapper | `we:scripts/guard-bash.mjs` coverage | Verdict |
|---|---|---|---|---|
| build | Yes | `we:scripts/operations/deliver-item-wrapper.mjs` exists, **unwired** | verification-only; lifecycle denylist dead | Not integrated |
| prepare (scope) | Yes | none | verification-only; brief bug fixed | Not integrated |
| prepare-decision | Yes | none | verification-only; brief bug fixed | Not integrated |
| investigation | Yes | none | verification-only; never had the bug | Not integrated |
| fix | Yes | `we:scripts/operations/fix-dispatch-wrapper.mjs` exists, **unwired**, brief still "PROTOTYPE" | verification-only; brief bug fixed; denylist arm blocked by a two-spawner conflict | Not integrated |
| ci-heal | Yes | none | verification-only; brief bug fixed | Not integrated |
| review | **No** | `we:scripts/operations/review-dispatch-wrapper.mjs`, wired as default path | N/A by construction | **Fully integrated** |

**Two wrappers exist but nothing calls them.** `we:scripts/operations/deliver-item-wrapper.mjs` (for `build`) and
`we:scripts/operations/fix-dispatch-wrapper.mjs` (for `fix`) are both written and both dead code on the dispatch
path. The `fix` one is not merely un-wired-yet: it is blocked by a real, named conflict — `WE_DISPATCH_KIND=fix`
is stamped by **two different spawners with incompatible contracts**, so wiring one wrapper behind that single
env value would mis-harness the other spawner's agents. That conflict has to be resolved before the wrapper can
be turned on at all; it is not a "just flip the flag" item.

**`guard-bash`'s lifecycle denylist is correctly OFF for all six, and must stay off until each one is wired.**
The denylist is what would mechanically enforce "the agent doesn't run its own lifecycle commands." Arming it
today, for any of the six, would deny **step 1 of that kind's own brief** — `lane-pool acquire` — and break the
dispatch outright. So the current state is self-consistent, not an oversight: the denylist can only be armed for
a kind *after* that kind's lifecycle has moved into a harness. `guard-bash`'s coverage for the six is
verification-only today, which is the correct setting for an unwired kind.

**Why this matters for the epic, not just as a status line.** `review` being harnessed is the existence proof
that the target shape works — the pattern is proven, once, end to end. But the epic's founding claim is about
*every* command an agent would otherwise run, and six of seven kinds are still the old shape. The `review`
wrapper is therefore the template to copy, and the remaining work is concrete and enumerable rather than
open-ended: wire `deliver-item-wrapper` for `build`; resolve the two-spawner `WE_DISPATCH_KIND=fix` conflict and
then wire `fix-dispatch-wrapper`; author wrappers for `prepare`, `prepare-decision`, `investigation`, `ci-heal`;
arm `guard-bash`'s lifecycle denylist per kind, each time only after that kind's wrapper is live.

**Related, already filed:** `#3629` (review and fix dispatch should get the same minimal context treatment) and
`#3627` (dispatched delivery agents should get a minimal hand-crafted brief) both sit next to this finding but
neither tracks the wiring itself. The self-hosting question this audit immediately raised — whether the
prototype branch can build these six remaining kinds into ITSELF, via a lane forked from the prototype rather
than from `main`, without a PR per increment — is filed separately as its own decision card; see the
"POC-branch delivery mode" decision under this epic.

## Working doctrine (2026-09-12): rule 10 amended — a long-lived divergent branch is a DECLARED delivery
## mode ("POC branch"), N may stand at once, and landing inside one skips review until graduation

The "POC-branch delivery mode" decision above was ruled by the operator the same day it was filed, and the
ruling amends rule 10 rather than working around it. The operator's words, verbatim:

> "I do want N POC as new feature. then goal is to be able to delivery quickly into a POC, so we must not be
> slow by the same slow PR process, otherwise there is not benefit. real review will happen when the POC
> graduate."

**Before (rule 10 as set 2026-09-04).** "The runner's steady state is tracking `main` directly; a long-lived
divergent branch is not the default operating mode." A divergent branch was framed as a temporary build tool
to be wound down; `#3443` was that wind-down; only one such branch was contemplated, and having it at all was
treated as a state to exit.

**After (rule 10 as amended 2026-09-12).** "A long-lived divergent branch is a DECLARED delivery mode — a
'POC branch' — not temporary scaffolding to wind down. What is forbidden is an UNDECLARED, unreconciled one."
N POC branches may stand concurrently, each a first-class delivery target an item can name
(`deliveryTarget:`), each graduating to `main` on its own timeline. Landing INSIDE a POC branch skips the
review gate entirely — the item's own tests/build validation is the only gate; the full review process (a real
PR to `main`, the escalation gate, the jury/judge panel, `review:human`) applies once, at graduation.

**What was preserved, and why it is not sentiment.** The 97-commit drift incident is real evidence, but of a
narrower claim than the original rule drew from it: the branch was undeclared, unregistered, and its sync loop
was failing silently with nothing watching. So the amended rule keeps (a) the runner's own steady state being
`main` — a POC branch is a *target*, never the runner's default tracking ref; (b) the short-lived
scratch-lane-off-current-`main` pattern for fixing the delivery machinery itself
(`#1894`/`#1895`/`#1902`/`#1903`) — "I need a POC branch" is never the answer to "I need to fix the runner";
(c) the requirement that every POC branch NAME what it is for and who graduates it, now as a registry entry;
(d) active per-branch drift reconciliation via `we:scripts/conveyor/branch-drift.mjs`, with a drifted branch
still holding its own items; and (e) build no more machinery than the POC in front of you needs.

**What was deleted.** The claim that divergence is inherently temporary and must be wound down, and the
assumption of a single branch. `#3443` remains real work — but as that one branch's own graduation, not as a
wind-down of the mode, and the runner tracking it today is not a violation of anything.

**Where it lives.** `we:skills-src/mechanical-delivery-doctrine/SKILL.md`, rule 10, plus that skill's own
`description:` line which paraphrases it — edited there first, per the skill's own stated amendment path
("If a rule itself changes, edit it here first, then note the change on the card"), and noted here second.

**Left for a follow-on, not this ruling:** the build itself — the `poc-branches` registry, the
`deliveryTarget:` field, the per-branch land lock, and the fast-forward-with-rebase-retry lander. The decision
card names that item and deliberately builds none of it.

## Session update (2026-09-12, continued) — punch-list of what is genuinely still open after today's
## mechanical-harness wiring, so a fresh session does not have to re-derive it

Written to survive this conversation, per the operator's own instruction. Every item below was RE-VERIFIED
against live state, not copied from an earlier draft — verified against `origin/lane/mechanical-dispatcher` tip
`373f14af1` ("validate-and-promote, the trigger that finally arms the watchdog"), `origin/main` tip
`b0763ceac`, and the live backlog/PR/issue trackers, all as of 2026-09-12. Where something turned out to
already be resolved, that is stated explicitly rather than silently dropped.

**What moved since the "one of seven" delegation audit earlier on this card (tip `02d9af300`).** That audit is
now stale on two of its six "Not integrated" rows — read the table below, not that one, for current state:
`build` (#3645) and `prepare` (#3641) both went from unwired to wired-by-default in the five commits after it
(`c081e1650` … `373f14af1`). The registry mechanism itself (`we:scripts/operations/dispatch-provider-registry.mjs`,
`62f4ce383`) is also new since that audit — it replaces what would otherwise have been a fifth hard-coded
branch in `we:scripts/operations/dispatch-lane-io.mjs`.

### 1. Dispatch-kind wiring — current state of all seven launch kinds

Re-verified directly against `we:scripts/operations/dispatch-provider-registry.mjs` on the lane tip (it throws
at import time if it ever drifts from `LAUNCH_KINDS`, so the table below is closer to a compile-time fact than
a snapshot):

| Kind | State | Evidence |
|---|---|---|
| `build` | **Wired, mechanical by default** | `DISPATCH_PROVIDER_REGISTRY.build` → `deliverItemDetachedProvider`; opt-out `WE_BUILD_DISPATCH_MODE=agent` |
| `prepare` (scope) | **Wired, mechanical by default** | `DISPATCH_PROVIDER_REGISTRY.prepare` → `prepareScopeDetachedProvider`; opt-out `WE_PREPARE_DISPATCH_MODE=agent` |
| `review` | **Wired** (since before today's later commits) | `we:scripts/operations/review-dispatch.mjs:496`/`:542` → `we:scripts/operations/review-dispatch-wrapper.mjs`, no agent turn in the critical path |
| `fix` | **Still unwired — blocked, not just undone** | see item 2 below |
| `prepare-decision` | **Still unwired** | no `we:scripts/operations/dispatch-providers/prepare-decision.mjs` exists; `#3644` (open) is the story |
| `ci-heal` | **Still unwired** | no `we:scripts/operations/dispatch-providers/ci-heal.mjs` exists; `#3642` (open) is the story |
| `investigation` | **Still unwired**, and no wrapper exists yet at all (unlike fix/ci-heal/prepare-decision, nobody has even prototyped one) | full-brief agent path only |

**Action for a future session:** `#3640` (fix, blocked — see item 2), `#3642` (ci-heal), `#3644`
(prepare-decision) are the three remaining stories under the umbrella `#3643`, all `status: open`, all already
carrying `deliveryTarget: lane/mechanical-dispatcher` (set on `main` via PR #2144, landed today) — so each can
be picked up as an ordinary POC-branch-targeted build, no further decision needed to start. `investigation`
has no story yet; file one before building it (needs a wrapper design pass first, the way `#3627`/`#3629`
did for build/fix/review).

### 2. `fix` dispatch is blocked on a real conflict, not merely unscheduled

`WE_DISPATCH_KIND=fix` is stamped by **two different spawners with two incompatible contracts**:
`we:scripts/operations/dispatch-lane-io.mjs#defaultClaudeProvider` (the live path, running
`we:skills-src/conveyor/fix-agent-brief.md` v1, which runs its OWN lane acquire / gate / commit / open-pr) and
`we:scripts/operations/fix-dispatch-wrapper.mjs` (written, unwired, running
`we:skills-src/conveyor/fix-agent-brief-v2.md` under a wrapper that owns all of that lifecycle instead). One
env value cannot describe both contracts at once — a `dispatchKind === 'fix'` deny arm in
`we:scripts/guard-bash.mjs` written for the wrapper's contract would deny the v1 agent's own legitimate step 1.
This is documented in `we:scripts/guard-bash.mjs` itself (search "A REAL AMBIGUITY TO SETTLE BEFORE ANY `'fix'`
ARM IS ADDED") and in `we:scripts/operations/fix-dispatch-wrapper.mjs`'s own header.

**Newly found today, same shape:** `prepare` now has the identical collision.
`we:scripts/operations/prepare-scope-wrapper.mjs` stamps `WE_DISPATCH_KIND=prepare` for its own (wrapped)
contract, but the pre-existing `WE_PREPARE_DISPATCH_MODE=agent` fallback path also stamps
`WE_DISPATCH_KIND=prepare` via `we:scripts/operations/dispatch-lane-io.mjs`'s generic
`String(request.launchKind || 'build')` stamp — same one-value/two-contracts problem, currently undocumented
anywhere except `we:scripts/operations/prepare-scope-wrapper.mjs`'s own header. **Not yet filed as its own
item** — worth doing before anyone tries to arm a `we:scripts/guard-bash.mjs` `'prepare'` deny arm and hits the
same wall `'fix'` already hit.

**Resolution shape, not yet decided:** either a distinct `WE_DISPATCH_KIND` value per contract (e.g.
`fix-wrapped` vs `fix-agent`, and the equivalent for `prepare`), or a second signal alongside the kind that
says which contract is in force. Whichever is chosen for `fix` should almost certainly be reused for `prepare`
rather than re-litigated.

### 3. `we:scripts/guard-bash.mjs`'s lifecycle denylist — confirmed still correctly scoped, and why it must stay that way

Re-read directly (`we:scripts/guard-bash.mjs`, the `dispatchKind === 'delivery'` block). **Only `'delivery'` is
armed** — the stamp `we:scripts/operations/deliver-item-wrapper.mjs` puts on the minimal build agent it
spawns. `'prepare'` is NOT armed (see item 2 — same two-contract collision as `fix`, confirmed in
`we:scripts/operations/prepare-scope-wrapper.mjs`'s own header: "`WE_DISPATCH_KIND: 'prepare'` … NAMED GAP, and
a gap this item deliberately does NOT close"). `fix`, `prepare-decision`, `ci-heal`, `investigation` are all
still verification-only (the `#3105` gate only), exactly as before. **This is self-consistent, not drift:**
arming any of these before its own two-contract collision (if any) is resolved and its wrapper is the sole
spawner would deny that kind's own agents their legitimate first step. Confirm this table again before arming
anything new.

### 4. Nothing re-judges whether a predicted scope is a GOOD prediction — still just flagged

`we:scripts/operations/prepare-scope-wrapper.mjs` (line ~47) states this in its own header in so many words:
"nothing here re-judges whether a WELL-FORMED prediction is a GOOD one." The wrapper checks structural
well-formedness (did the agent touch only its own backlog file, did it write a `scope:` field at all) but
nothing scores whether the predicted touch-set is actually close to what the item will really touch. **No
backlog item exists for this yet** (searched; nothing found). Worth filing as its own story before `prepare`
dispatch is trusted at volume — a silently bad prediction degrades exactly the scope-lease conflict machinery
(`#2560`/`#2592`) that predicted scope exists to feed.

### 5. `we:scripts/conveyor/driver-watchdog.mjs` has nothing scheduling it — still just a script

Confirmed: no `we:package.json` script, no cron entry, no launchd plist, no GitHub Actions workflow references
`we:scripts/conveyor/driver-watchdog.mjs` anywhere in the repo. It is invoked only by hand (`node
we:scripts/conveyor/driver-watchdog.mjs check|heal`) or, as of `373f14af1`, indirectly by
`we:scripts/conveyor/validate-and-promote.mjs promote` (which calls `record-good`, arming the watchdog's
fallback, but never calls the watchdog itself). **A real decision is still owed:** cron/loop trigger on the
driver's own host, a tick inside the runner's own mechanical passes (the watchdog's header explicitly forbids
sharing the driver's decision logic, but running the CHECK on a timer from outside the driver process is a
different question), or accepted as manual-only for now. Until one of those is chosen and wired, the watchdog
protects nothing unattended.

### 6. `validate-and-promote` / `record-good` / `restart-runner` — unit-tested, never live-fired end to end

Confirmed by reading the test suites directly: `we:scripts/conveyor/__tests__/validate-and-promote.test.mjs` is
pure decision-table + injected-double tests only (four described sections, no real clone, no real `npm`, no
real `git reset`, no real `claude`). `we:scripts/operations/__tests__/restart-runner-io-real.test.mjs` is the
one REAL-mechanism test in this group — real directory trees, a real `ps` shell-out, a real detached child
process — but its own header states it deliberately never spawns the real supervisor or the real runner, "per
a standing operator constraint." The `we:scripts/conveyor/validate-and-promote.mjs` CLI does have a
live-fireable read-only `validate` verb (five checks in a throwaway clone, touches no driver) — that is the
"one live self-test" this session ran — but nobody has yet run the `promote` verb for real: a live sha, a real
driver checkout, a real `record-good` write, a real reset, and a real `restart-runner` landing the driver on
new code. **That end-to-end live run is the next concrete step before trusting this pipeline**, not a code
change — the code appears complete and is exercised in isolation, just never chained together for real.

### 7. `#3646` / backlog `#3646` — filed, not fixed. Confirmed still open.

`we:skills-src/conveyor/runner.mjs`'s SIGTERM/SIGINT handler cannot fire while the runner is inside a blocking
`execFileSync` call (one of its own mechanical passes) — Node only dispatches signals on the event loop.
`we:backlog/3646-*.md` (`status: open`) documents this and names the precedent fix (`#3404`'s move to
`runQuietHeartbeating` for `we:scripts/conveyor/verify-dispatch.mjs`). PR #2142, which merged today, **only
filed this card** ("backlog: file runner SIGTERM-mid-blocking-pass limitation under #3383") — it added no
code. The actual fix (moving whichever of `we:skills-src/conveyor/runner.mjs`'s own mechanical passes still
use a plain blocking spawn onto the heartbeating pattern) remains unbuilt.

### 8. `#3647` — review-dispatch-wrapper misclassifies a successful review as `blocked-on-infra`. Confirmed still open, unfixed.

`we:backlog/3647-*.md`, `status: open`. Root cause already diagnosed and written down on the card:
`we:scripts/operations/review-loop-cli.mjs` exits non-zero when a *secondary, non-essential* logging step
fails (a missed prevention-guard append to `~/.claude/conveyor/learnings/review-loop.jsonl`), even though the
review itself ran to completion and succeeded (real accept verdict posted, label flipped, PR merged). The
wrapper's `execFileSync` catch branch cannot currently tell "the review never ran" from "the review ran and
succeeded but something secondary afterward failed," so it hardcodes `blocked-on-infra` either way. No code
fix has landed for this — only the diagnosis and the card.

### 9. PR #2113 — needs a real disposition decision, not indefinite open status

Confirmed still `OPEN` against `main` (`gh pr view 2113`): "WE #3629: extract shared minimal-context
primitives + build the mechanical review-dispatch wrapper." Its content was already merged into
`lane/mechanical-dispatcher` via a local branch merge back on `5129bd1fd` ("Merge branch 'pr-2113' into
lane/mechanical-dispatcher") — i.e., the review-dispatch-wrapper code this PR carries is *already living and
running* on the prototype branch (`02d9af300` wired it as the default `review` path there), while
`we:scripts/operations/review-dispatch-wrapper.mjs` does **not exist on `main` at all** (confirmed: `git
ls-tree -r origin/main` has no such file). Since the 2026-09-12 POC-branch ruling, the intended path for
prototype-branch content reaching `main` is `#3443`'s incremental small-PR graduation (that epic is `status:
active`, already landing pieces), not a single big PR opened before that ruling existed. **Recommendation, not
yet decided by the operator:** close #2113 as superseded by the POC-branch content plus #3443's graduation
path, rather than leaving a stale direct-to-main PR open indefinitely alongside the now-different intended
landing mechanism. This needs the operator's actual call, not a unilateral close.

### 10. `#3639` — the changeset/"batch" decision. Confirmed still open, unratified.

`we:backlog/3639-*.md`, `kind: decision`, `status: open`, no `preparedDate` set. Extensively researched on the
card itself (7 forks, a full survey, a "continued" reassessment after the operator supplied the real
motivating scenario) but per this repo's own rule ("never rule w/o preparedDate"), it is not yet a
ready-to-ratify decision in the tracked sense even though the prose reads as thorough. Needs either a
`/prepare` pass to set `preparedDate` formally, or the operator ratifying directly against the "Revised
recommendation for Fork 7" already on the card.

### 11. The bootstrap gap — named so it is not mistaken for forgotten work

`main`'s own conveyor still cannot spawn delivery agents at all (`#3369`/`#3580`'s decoupling work and the
dispatcher-on-`main` question are unrelated to and upstream of everything above). Every mechanical-harness
wiring item in this whole session update lives on `origin/lane/mechanical-dispatcher` only. Graduating any of
it to `main` is explicitly `#3443`'s job — already `status: active`, already landing incremental PRs (most
recently PR #2144 today) — and is a separate, ongoing epic, not something this list calls for action on. Named
here only so a future session does not mistake "none of this runs on `main` yet" for a gap in today's work.

### Already-resolved items worth naming explicitly (so nobody re-opens them)

- **PR #2142** — merged (filed `#3646`, no code fix — see item 7 above; the PR itself is done, the underlying
  work it filed is not).
- **The `build`/`prepare` rows of the earlier "one of seven" audit** — superseded by item 1 above; both kinds
  wired and mechanical-by-default as of `d1c2d8ed6`/`ffbc921ab`+`49c46c3d2`.
- **The `we:scripts/operations/dispatch-provider-registry.mjs` extraction itself (`62f4ce383`)** — done; a
  pure refactor, all pre-existing tests pass unchanged, 21 new tests added for the registry.
- **The driver watchdog's fallback-marker gap** — `we:scripts/conveyor/validate-and-promote.mjs` (`373f14af1`)
  closes the "nothing ever calls `record-good`" gap the watchdog shipped with; see item 6 for what is still
  NOT done (a live end-to-end `promote` run).

## Session update (2026-09-12 night, close-out) — five in-flight threads checked against live state before the
## operator stepped away; two done, one landed live DURING this check, two still genuinely in progress, one
## real unattended problem found and left exactly as found

Written because the operator is stepping away for the night and asked for a durable, cold-readable record of
what five parallel threads actually reached — not a transcription of the plan going in. Every claim below was
re-checked against a live artifact (a lane's own git state, a running process's log, `gh pr view`, `claude
agents --json`) at write time, not carried over from memory. **State kept changing while this was being
written** — two things landed mid-check — so timestamps are given where the gap matters instead of a single
"as of" line for the whole section.

### 1. Codex delivery-agent provider (`CODEX_PROVIDER.spawn()`) — genuinely in progress, substantial, not done

Lane-21 (`3383-codex-delivery-provider`, based on `origin/lane/mechanical-dispatcher`) holds a real, actively-
being-written implementation: `we:scripts/operations/codex-delivery-provider.mjs` (352 lines, new/untracked)
plus edits to `we:scripts/operations/deliver-item-run.mjs` and `we:scripts/operations/deliver-item-wrapper.mjs`
wiring a `--provider=codex|claude-restricted` selector (flag → `DELIVERY_AGENT_PROVIDER` env → default,
mirroring `we:scripts/operations/run.mjs`'s existing judge-provider seam). **This is explicitly, and correctly
per the operator's own call, built ahead of `#3581`'s ratified reviewer-first sequencing** — the new file's own
header states this in so many words ("the operator explicitly chose to build this ahead of that gate — a
deliberate, informed call, recorded here rather than left to look like an oversight"). Not an oversight; do not
treat it as one tomorrow.

All three unknowns the old stub named are answered with **live, reproduced evidence**, not assumption — this
matches the `we:docs/agent/prototype-based-dev.md` discipline (ground the spawn seam in a real run before
writing the port). The raw probes are on disk in this session's own scratchpad (four numbered probe transcripts
plus a sandbox-boundary probe), not committed anywhere — worth folding into the file's own header citations if
not already, since they're the falsifiable record behind the claims:
- **Write capability + the right flag**: `-c default_permissions=locked -c 'permissions={locked={extends=":workspace",…}}'`,
  never `-s workspace-write` — `-s` silently defeats the deny map (re-confirms `#3371` Probe 14f) and
  `codex exec resume` doesn't accept `-s` at all (confirmed against real `--help`).
- **Blocking/foreground invocation**: a real `execFileSync('codex', argv, {stdio:['ignore','pipe','pipe']})`
  blocked 8.5s, exited 0, left the file on disk (reproduced 3×, 8.5s/12s/11s). `stdio[0]` must stay `'ignore'`,
  never inherited/piped, or a positional-prompt-plus-open-stdin spawn hangs forever (documented trap, shared
  with `we:scripts/lib/codex-judge-spawn.mjs`).
- **No guard-lane/guard-bash equivalent needed**: Codex's native permission profile already enforces the same
  two protections `we:scripts/guard-lane.mjs` / `we:scripts/guard-bash.mjs` do, at the OS layer instead.

One `throw` remains in the new file (an explicit refusal path, not an unimplemented stub). **Not yet committed,
not yet tested against `check:standards`/vitest, not yet landed anywhere.** Whoever picks this up should verify
the file's own claims hold under the repo's test suite before trusting the header's prose.

### 2. Codex reviewer-seat validation (does the verdict hold up, per `#3581`'s own bar) — set up, not concluded

Lane-22 (`codex-judge-validation`, purpose `codex-judge-validation-3581`, based on `origin/lane/mechanical-
dispatcher`) is reserved and clean — no diff, no commits. A separate scratch clone (shallow, HEAD at `main`'s
`6223c75dd` as of ~21:53) was set up as a live-fire workbench. **No persisted verdict-quality write-up was found
anywhere** (this lane, that scratch clone, or the learnings pool) as of this check — the actual PRs Codex's
advisory seat would be validated against (`PR #2115`/`#2117`, "wire Codex CLI as a second JudgeProvider" / "seat
Codex as a real, opt-in THIRD judge") are unchanged since 2026-09-10/11, both still parked (`review:changes`,
one with a live merge conflict against `main`). **Read plainly: this thread has a workbench but no recorded
result yet** — don't assume progress here beyond "environment ready," and don't conflate it with item 1 above
(different lane, different purpose, no shared code between them yet).

### 3. Telemetry instrumentation — DONE, committed and pushed to the prototype branch during this very check

Confirmed landed: `fe2d96ac6` ("WE #3383: unified delivery telemetry — traces, spans and the four golden
signals"), pushed straight to `origin/lane/mechanical-dispatcher` at **2026-09-12T22:17:09-04:00** — per rule
10/rule 4, a direct prototype-branch commit needs no PR. Three new files (`we:scripts/operations/telemetry.mjs`
pure core, `we:scripts/operations/telemetry-store.mjs` NDJSON io shell, `we:scripts/operations/telemetry-cli.mjs`
report/trace/traces/days reader) plus instrumentation added to all six delivery wrappers
(`we:scripts/operations/ci-heal-dispatch-wrapper.mjs`, `we:scripts/operations/deliver-item-wrapper.mjs`,
`we:scripts/operations/fix-dispatch-wrapper.mjs`, `we:scripts/operations/minimal-context-provider.mjs`,
`we:scripts/operations/prepare-decision-wrapper.mjs`, `we:scripts/operations/prepare-scope-wrapper.mjs`,
`we:scripts/operations/review-dispatch-wrapper.mjs`) and `we:skills-src/conveyor/runner.mjs`'s own tick loop.
**Verified provider-agnostic by direct inspection**: grepping `we:scripts/operations/telemetry.mjs` for
`provider`/`codex`/`claude`/`antigravity` returns nothing that names a CLI — spans are keyed by launch kind,
never by which CLI ran the phase. **136 tests pass** (`we:scripts/operations/__tests__/telemetry.test.mjs` 114,
`we:scripts/operations/__tests__/telemetry-wiring.test.mjs` 22), run directly against the lane at commit time.
This item is finished for tonight; the only thing left is graduating it to `main` under `#3443`'s normal
incremental path, same as everything else on this branch.

### 4. Decision Docket convention (full fork detail for every prepared item, not just ratified ones) — committed, not yet pushed or landed (progressed DURING this check — was uncommitted prose minutes earlier)

Lane-18 (`decision-docket-doc`) went from an uncommitted working-tree diff to a real commit,
`7ade8f652` ("docs: codify the Decision Docket convention — full fork detail for every prepared item, not a
summary row"), while this update was being written. Adds a new `we:docs/agent/backlog-workflow.md` section
("Publishing the Decision Docket — full fork detail for every prepared item shown, never a summary row")
stating the rule plainly: every prepared item the Decision Docket lists gets its complete fork breakdown —
every option, the bold default, and each non-default option's stated rejection reason — never a compact
summary row, and this bar does **not** vary by section (a "current batch" item and a merely-listed older item
get the same treatment; shrink the list before thinning the detail). Cross-links backlog item #3562 (the
standing mechanical pass this binds once built) and amends #3562's own "Why" section to point back at the new
doc anchor. **Committed, local to lane-18 only as of this check** — not pushed, no PR, not landed yet.

### 5. Codex-delegation memory note — DONE, landed to `main` (landed live DURING this check)

`we:agent-memory-src/delegate-work-to-codex-when-feasible.md` (indexed into `we:agent-memory-src/index-meta.md`),
capturing the operator's 2026-09-12 framing verbatim (actively look for a point where handing real work to
Codex becomes genuinely feasible, not just theoretically wired, and treat it as worth pursuing rather than
waiting to be asked), is now on `main`: `PR #2151` merged at **2026-09-13T02:32:23Z** — after being only a
local, unpushed commit in lane-20 earlier in this same check (the pattern repeated across two of tonight's
five threads). **Lane-8 and lane-20 were both acquired under the identical purpose (`delegate-codex-memory`)**
— lane-20 did the real work and it is now landed; lane-8 is a redundant, unused reservation from the same push
and should simply be released.

### Corrections to the operator's own settled-context list, verified rather than transcribed

- **The watchdog + validate-and-promote pipeline, corrected in two ways.** First, the citation "item #3514,
  PR #2147 merged" was **not yet true when this check started** and became true **during it**: `gh pr view 2147`
  showed `OPEN` for most of this session, then `origin/main` advanced (`d0e16ff7b`, "drain: resolve #3514 on
  land") and `PR #2147` showed `MERGED` at **2026-09-13T02:19:53Z** — the drain landing what the live-fire build
  had opened. So the full chain — dispatch → build → PR → (parked, then cleared) → drain-merge — is now
  genuinely proven for tonight's one permitted item, just later than the brief implied. Second, the pipeline's
  own pause marker on `wev-driver-live` shows this was a deliberately narrow test, not a broad run: dispatch was
  paused for every kind except `build` — `pausedKinds: [prepare, prepare-decision, investigate, fix, ci-heal]`,
  reason recorded verbatim as "epic #3383 first live-fire: ONLY the build kind may dispatch (#3514)", set at
  `2026-09-12T23:58:15Z`. The recorded last-known-good state confirms a real `validate-and-promote --full`
  promotion ran too (`76d91cc25` → `9fe6cb932`, recorded `2026-09-13T00:03:31Z`) — the `promote` verb genuinely
  fired for real, which an earlier section of this same card had listed as still-untested. **Third, and this is
  new, not a correction of the brief: the driver at `wev-driver-live` is DOWN right now** — see "For tomorrow"
  below.
- **The bounded-vs-resident watchdog fix** — confirmed landed, directly on the prototype branch (`39b88e26f`,
  "the watchdog stops calling a finished --once driver a crash"), no PR, per rule 4 (prototype-only fixes skip
  ceremony). Also on the branch tonight, same pattern: `9fe6cb932` ("put the validation clone where the
  constellation says a checkout goes").
- **`#3649`** — confirmed accurately described: `status: open`, `kind: decision`, `preparedDate: 2026-09-12` set,
  landed to `main` via `PR #2149` (merged). Genuinely prepared and awaiting ratification, not yet ruled.
- **`3652` / `PR #2150`** — confirmed: `OPEN`, "file: gh pr checkout bypasses the branch-switch guard on the
  shared primary checkout." Filed, not fixed, exactly as stated.
- **"Fix what you find by default" memory** — confirmed:
  `we:agent-memory-src/prototype-fix-what-you-find-by-default.md`, landed to `main` via `PR #2148` (merged).
  **"Codex work targets the prototype branch first"**
  has no separately-named memory file of its own as of this check — it's consistent with the existing
  `we:agent-memory-src/default-to-prototype-for-mechanical-fixes.md` /
  `we:agent-memory-src/prototype-is-source-of-truth-for-mechanical-work.md` notes but was not found as its own
  artifact; treat it as a verbal standing instruction until/unless someone writes it down separately.

### A real, current, unattended problem — not in the brief, found only by reading the watchdog's own log

`we:scripts/conveyor/driver-watchdog.mjs` is genuinely running right now — a shell loop (pid confirmed alive via
`ps`) polls `wev-driver-live` every 5 minutes, logging to a local watchdog log outside the repo. Every single
poll since **2026-09-13T00:58Z**, roughly 80 minutes straight through **02:19Z** (the last poll before this
write-up), reports the same thing: driver state `"down"`, no runner lease held anywhere, reason recorded
verbatim as "the driver is not running (no runner lease at all). That is a crash, not silent staleness," action
`"none"`, `"alerted": false`. The runner lock directory is confirmed empty, matching "no lease anywhere." This is
exactly the gap this card's own punch-list already named earlier tonight (item 5, "nothing schedules the
watchdog" — now half-closed, since a loop IS scheduling it) plus the still-open alerting gap (`#3398`) — the
watchdog sees the crash, correctly declines to auto-restart or roll back a checkout under a dead driver (by
design, per its own header), but nothing pages anyone. **Left exactly as found, not restarted or investigated
further** — restarting a driver unattended overnight is explicitly the kind of new unsupervised action the
operator ruled out before stepping away; this is a "check first thing" item, not a "fix silently" one.

### For tomorrow, explicitly

All five threads above were already scoped and authorized before the operator stepped away; nothing new was
started without one of them as the reason. Nothing here was force-cleared past a `review:human`/parked state.
Check, in this order:

1. **Restart the driver at `wev-driver-live`** (or confirm someone already has) — it has been down, unalerted,
   since ~00:04Z, and the paused kinds (`prepare`/`prepare-decision`/`investigate`/`fix`/`ci-heal`) plus a dead
   runner mean nothing but last night's one already-merged build (`#3514`) actually moved. Decide whether to
   lift the pause's narrow live-fire scoping now that the one permitted item landed.
2. **Item 1** (`lane-21`, codex-delivery-provider) — was still being actively written as of the last check;
   confirm whether it finished, then run `check:standards` + vitest against it before trusting the header's
   claims, then commit/PR per the normal prototype-fix-or-graduate path.
3. **Item 2** (`lane-22` plus the separate codex-validate scratch clone) — no recorded verdict yet; this is
   genuinely still open, not just unwritten-up.
4. **Item 4** (`lane-18`, Decision Docket doc change) — finished commit as of this check, needs push + PR.
5. **Item 5** (Codex-delegation memory) — already landed (`PR #2151`); just release the redundant `lane-8` /
   `lane-20` reservations.
6. **Stuck-vs-working check**: `claude agents --json` shows a primary-checkout interactive session sitting on
   `"waiting for dialog open"` — a real stuck-dialog pattern seen repeatedly today, not one of tonight's five
   threads; worth a look. Several `fix-*`/`review-*` background entries show `state: blocked` but are ~24h+ old
   debris from unrelated earlier work, consistent with the already-documented stale-`claude agents`-bookkeeping
   gap — not new, not urgent.

## Follow-up (2026-09-12 night, after the list above) — item 2 (Codex reviewer-seat validation) reached a
## verdict: the mechanism is clean, the JUDGMENT is not — 4 of 4 real runs came back empty, including one real miss

Item 2 above was left as "workbench ready, no recorded verdict yet." It has since concluded. Everything below
is read directly off the four persisted completion records the live-fire run itself wrote
(`review-pr-9c12fca6…` = PR #2107, `review-pr-e64b290a…` = PR #2130, `review-pr-268cdedd…` = PR #2147,
`review-pr-19d6b92a…` = PR #2043) and their `judge`/`judgeAdvisory` telemetry, not a paraphrase of a summary.

### The live-fire run itself: plumbing proven, judgment not

`--codex-advisory` ran against these 4 real, currently-open PRs, real diffs, confirmed non-degraded reads
(`degraded: false` on every request). Every one of the four `judgeAdvisory` (Codex, simplicity lens) steps came
back the same shape: exactly 1 turn, `stopReason: "turn.completed"`, `costUsd: 0`, **zero findings**
(`findings: []`):

| PR | wall time | reasoning tokens (output) | loaded context tokens (diff-proportional) |
|----|-----------|---------------------------|--------------------------------------------|
| #2043 | 7.2s | 76 | 24,625 |
| #2147 | 9.2s | 103 | 29,101 |
| #2130 | 11.4s | 108 | 42,651 |
| #2107 | 12.2s | 180 | 87,103 |

**4 of 4 real runs: empty.** Reasoning effort does not track diff size the way it should: from the smallest
diff (#2043) to the largest (#2107) the loaded context grew ~3.5x but reasoning output grew only ~2.4x — the
seat gives proportionally *less* attention as the diff gets bigger, the opposite of what a careful review would
need.

### The miss that matters: PR #2107

On #2107, Codex's advisory seat's own words: "no concrete simplicity findings survived scrutiny" — a rubber
stamp. The same diff, same run, reviewed by the Claude correctness juror, produced a `CONFIRMED`,
`disposition: blocker`, `worseThanBase: true` finding: `commitConvergeRound`
(`we:scripts/operations/deliver-item-wrapper.mjs`) shells `git commit -F <msgfile> -- <paths>` with no preceding
`git add`, which throws on any round whose accepted edit adds a brand-new (untracked) file — verified against
real git, not the test suite's mocked `run` (every existing test for this path mocks `run`, which is why it was
never caught). Codex looked at the identical diff and found nothing.

### The control probe: the seat itself is not broken

A separate synthetic-diff control probe (a scratch script driving the same real request builder and provider,
against a contrived diff with an unused dead function and redundant branches — built to be found) confirmed the
wiring CAN produce a real, correctly-shaped finding when exercised in isolation. So this is not a broken
integration — it is a real judgment-quality gap on dense, real-world diffs specifically.

### Verdict, per `#3581`'s own bar (Codex must prove itself as reviewer before delivery work trusts it)

**Mechanism: validated.** No recurrence of the earlier false-accept bug, correctly tool-free, cheap, fast.
**Reviewer judgment: NOT validated.** Four empty accepts in a row — one of them a genuine miss on a confirmed
blocker — is not evidence of added signal.

This does **not** call into question item 1 above (the Codex delivery-agent provider build) — the operator
already explicitly, and separately, chose to move that forward ahead of this gate; that call stands as made. It
**does** leave open a real, unresolved question: should the advisory seat itself be trusted or adjusted (a
harder mandate? reasoning effort/budget forced to a floor regardless of diff size?) before `#2117`'s pilot is
treated as proven. Nothing here forces that call tonight — it is a "decide with fresh eyes" item, not a
"blocked" one.

### Two smaller residuals, for the record

- **A `blocked-on-infra` labeling gap, confirmed by direct inspection.** In
  `we:scripts/operations/review-dispatch-wrapper.mjs` (prototype branch, `origin/lane/mechanical-dispatcher`),
  the `blocked-on-infra` classification built when `we:scripts/operations/review-loop-cli.mjs` itself crashes
  (`classified = { outcome: BLOCKED_ON_INFRA, verdict: null, loopOutcome: null, runId: null }`, no `label`)
  carries no error detail into `reportDone`, while the sibling `acquireLane`-throw path a few lines above builds
  `classified` with `label: String((e && e.message) || e).slice(0, 500)` from the same kind of caught error
  before reporting. Worth aligning so every `blocked-on-infra` path carries its error as a `label`, not just
  some of them.
- **Lane-pool reaped a live sibling agent's lease mid-run tonight** — no data lost, but the mechanism that let a
  live lease get reaped out from under a running sibling is worth checking before trusting it unattended again.

## Follow-up (2026-09-12 night, continued) — item 1 (Codex delivery-agent provider) also finished: `CODEX_PROVIDER`
## is now real, not a stub, and pushed

Item 1 above ("genuinely in progress, substantial, not done") has since landed on the branch. `e53073fef`
("WE #3580: CODEX_PROVIDER is real — a write-capable second delivery agent") is pushed to
`origin/lane/mechanical-dispatcher`: `CODEX_PROVIDER.spawn()` in
`we:scripts/operations/deliver-item-wrapper.mjs`, previously an honest throwing stub, is now a real
implementation backed by `we:scripts/operations/codex-delivery-provider.mjs` (352 lines, new). Selectable via
`--provider=` on `we:scripts/operations/deliver-item-run.mjs`, then `DELIVERY_AGENT_PROVIDER`, then the
unchanged default — **Claude stays the default; Codex is opt-in only.**

Confirmed against a real `codex exec` invocation (codex-cli 0.153.4), not guessed, per the commit's own header:
write access rides `-c default_permissions=locked` (never `-s workspace-write`, which was tested and rejected —
it silently zeroes the permission deny map, and `codex exec resume` accepts no `-s` at all); a real
`execFileSync` through the production primitive blocked ~10s and exited 0; and — the notable finding — Codex's
own native OS-level permission profile, measured with no model in the loop, is actually STRONGER than this
repo's Claude-side `we:scripts/guard-lane.mjs`/`we:scripts/guard-bash.mjs` hooks: a write into the primary
checkout or a sibling lane both return `Operation not permitted` at the OS layer (`we:scripts/guard-lane.mjs`
can only match Edit/Write tool calls and cannot stop a shell redirect, and it documents the sibling-lane case
as an open residual), and the profile has no network at all, so `git push` is structurally impossible for it
rather than merely denied by a hook. One documented limitation, stated in the code itself: choosing `codex`
swaps the BUILD agent only — the wrapper's own separate converge-editor step (`runConvergeEdit`) still always
spawns Claude.

**Read this together with the reviewer-seat finding above, not separately**: the delivery-agent PROVIDER side
is now real and technically working, opt-in-only, built ahead of `#3581`'s gate by the operator's own already-
recorded explicit choice. But per the reviewer-judgment finding just above, `#3581`'s gate itself is not yet
cleared. So the honest state is: **the mechanism for Codex delivery work now exists; whether to actually route
real delivery work through it is still gated on the unresolved reviewer-judgment question** — not "Codex
delivery work is ready to use."

## Session update (2026-09-13) — `#3649` (run-quality benchmark / auditor) fully ratified, fork-by-fork

`#3649` — the run-quality auditor that scores a dispatched agent's own transcript against a versioned rubric
(deductions off an implicit 100%) — was reviewed fork-by-fork across several sessions and is now **resolved**,
`codifiedIn: we:docs/agent/platform-decisions.md#drain-daemon-self-hosting-boundary` (only Fork 5's independence
restatement earns statute; the rest is `one-off`). All seven forks ratified as recommended: session-end
trigger; vector-canonical record with a class-level aggregate scalar only (never a per-run headline); stamped
`rubricVersion`, never re-normalised; a named always-actionable criteria list plus accrual, no numeric par
band in v1; the subject-class gate (driver/conveyor subjects report-only, always, stamped at launch); the
risk-assessment-of-the-fix axis (blacklist first); and v1 ships **recording-only**, with the router built but
disarmed.

**Open follow-up, tracked as its own card so it survives past this session:** the router ships disarmed on
purpose. Arming it is filed as `3651` ("Arm the run-quality router once v1's rubricVersion has a complete
run population"), parked `maturityGated` (`adoptionSignal`: one complete run population under a single
`rubricVersion`), `blockedBy: ["3649"]`. Nothing arms automatically — the next session that finds that
population exists is the one that un-parks it.

`#3649` itself builds none of the five pieces its ruling names (reader-widening on `#3477`, the rubric, the
scorecard store, the subject-class stamp, the router) — those are still unfiled follow-on work, distinct from
the `3651` arm-trigger card above.

## Operator goal, recorded for the record (2026-09-13): point our own interactive build skills at the driver once it's trustworthy

**This is a stated target the operator wants, not a "could do someday" idea — treat it as real backlog intent
to revisit as the blockers below clear, not something a future session should second-guess away.** The
operator's own words: "As soon as the driver is ready, I want our skills to point to it for building." Once
this epic's mechanical dispatcher/driver is validated and trustworthy enough — **quality-proven on real work,
not just mechanically working** — the repo's own interactive dev workflows under `we:skills-src/` (the skills
that currently handle building/delivering a backlog item by driving an interactive session —
`next-backlog-item`, `batch-backlog-items`, `workflow`, and anything else that dispatches build work today)
should be changed to route their build path through the driver, rather than the driver staying purely a
separate background/parallel system while the interactive skills keep doing their own thing. This is the
natural endpoint of this whole epic's target shape (see "The target shape" section above) applied to the
repo's own tooling, not a new idea.

**Why this isn't done yet — the blockers as of today (2026-09-13):**

1. **The driver has been exercised exactly once in a bounded, supervised test run**, against item `#3604` —
   it correctly reported the item `"blocked"`, and this was the first time the new unified delivery telemetry
   (`fe2d96ac6`, "traces, spans and the four golden signals" — see the session update above) was proven live
   end-to-end rather than only unit-tested. One correct outcome on one item is evidence the mechanism can work,
   not evidence it reliably does — nowhere near enough real-work volume to trust it as the default build path
   for the skills operators actually use day to day.
2. **Codex delivery-provider quality is still completely unvalidated on real work.** `CODEX_PROVIDER` (the
   write-capable second delivery agent, `e53073fef`, "WE #3580") is technically real and wired, opt-in via
   `--provider=`/`DELIVERY_AGENT_PROVIDER`, Claude staying the default. But the sibling validation thread in
   this same file (the "Codex reviewer-seat validation concluded, judgment gap found" follow-up above) found
   the mechanism clean while the JUDGMENT was not: 4 of 4 real live-fire runs came back with zero findings,
   including one confirmed miss on a genuine blocker a Claude juror caught in the same diff. That was the
   reviewer seat specifically, not the delivery-agent build seat, but it is the closest real evidence this repo
   has on Codex's judgment quality on real diffs, and it is not reassuring. Nothing here should be read as
   routing default build work through Codex, or through any driver path that leans on Codex judgment, until a
   comparable live-fire validation exists for the DELIVERY side, not just the reviewer side.
3. **Provider-selection wiring for `fix`/`ci-heal` kinds — checked directly at the time of this entry, and it
   is done, on the branch, not yet on `main`.** As of this session's check, `origin/lane/mechanical-dispatcher`
   already has: `WE #3640` (`20129c38e`, wires `fix` dispatch to
   `we:scripts/operations/fix-dispatch-wrapper.mjs`'s mechanical arc), `WE #3642` (`00e81eacb`, wires `ci-heal`
   dispatch to `we:scripts/operations/ci-heal-dispatch-wrapper.mjs`'s mechanical arc), and `161f1bd4d` ("thread
   the selected delivery provider into the converge round") — which fixed a real gap where
   `we:scripts/operations/deliver-item-wrapper.mjs`, `we:scripts/operations/fix-dispatch-wrapper.mjs`, and
   `we:scripts/operations/ci-heal-dispatch-wrapper.mjs` all resolved a provider for the build spawn but never
   passed it to the converge round, so a Codex-selected build's converge silently ran under Claude with no
   record of the hand-off. All three commits are dated 2026-09-12 18:22 through 2026-09-13 07:40 (local),
   pushed to the branch, not yet graduated to `main` per this epic's own "prove on the branch, graduate later"
   build strategy (see "How to build it" above). So this specific blocker is functionally cleared at the
   mechanism level — what remains is everything else on this list, especially live-fire proof and a rollout
   policy, before any of it is trusted to replace an interactive skill's default path.
4. **No risk/rollout policy exists yet for when the driver should be trusted to run unattended long enough to
   actually replace interactive workflows.** Nothing in this epic currently states a bar — how many real items,
   what mix of kinds, what failure rate, what escalation behavior — that would justify flipping a skill's
   default build path from "drive it yourself, interactively" to "hand it to the driver." Until that bar is
   named and met, pointing the skills at the driver is a goal to work toward, not a change to make.

**What "done" looks like for this goal, so a future session recognizes it**: the driver has cleared a stated
rollout bar (once one exists — see blocker 4) on real work across the kinds it needs to cover, and
`we:skills-src/next-backlog-item`, `we:skills-src/batch-backlog-items`, `we:skills-src/workflow` (and any
sibling interactive delivery skill) have been changed so their build step calls into the driver instead of
driving an interactive session's own tool calls turn by turn — at which point the driver stops being a
separate parallel system and becomes THE way this repo builds.

## Operator goal, recorded for the record (2026-09-13): know this system's real build capacity, and model what new hardware would buy

**This is a stated target the operator wants, not a "could do someday" idea — treat it as real backlog intent
to revisit as the measurement foundation below matures, not something a future session should second-guess
away.** The goal: determine the actual build/delivery capacity this system has available on current hardware,
and model what new/different hardware would buy — specifically, how much additional build work and how many
more concurrent lanes a given hardware upgrade would support. **This is the actual purpose behind the
per-process resource telemetry work dated 2026-09-13** (see the host-resource metrics landed this same day,
`e539e430e`, "telemetry: add host-resource metrics (load avg, mem, cpu count) to runner tick", plus the
per-process telemetry work in flight alongside it under this same epic) — that work is not telemetry for its
own sake; it exists to answer this capacity-planning question.

**Future architectural direction (explicitly NOT built yet, just recorded as intent):**

- Split resource capacity into two separate pools with their own budgets: the **command queue** (the
  mechanical orchestration layer itself — conveyor/driver, drain, dispatch coordination) and the **lanes**
  (actual build/work agent execution) — rather than treating all resource consumption as one undifferentiated
  pool.
- Consider using **macOS containers** (or an equivalent OS-level resource-control mechanism — sandbox-exec
  resource limits, or a container runtime like OrbStack/Docker Desktop on macOS) to actually ENFORCE how much
  CPU/memory each pool gets, not just measure it after the fact.
- The per-process telemetry work (categorizing usage across conveyor/drain/dispatched-agent/vscode/chrome/
  other, landed the same day as the host-resource metrics above) is the measurement foundation this future
  capacity-split/enforcement work would build on — it has to exist before a capacity split or an enforcement
  mechanism can be designed responsibly, since neither can be sized without knowing what actually consumes
  capacity today.

## Operator goal, recorded for the record (2026-09-13): a "git manager" — a central coordination layer every
## git/GitHub operation across concurrent conveyor + subagent work routes through

**A distinct, separate concern from the "point interactive build skills at the driver" goal recorded just
above** — that one is about which system drives a build; this one is about how many independent processes are
allowed to hit GitHub's API at once and how they share that budget. Recorded here as real, durable operator
intent to build, in the same terms as this epic's other forward-looking goals — **not** a "could do" idea a
future session should second-guess away.

**Trigger, live during this very session.** A real GitHub API rate-limit exhaustion happened while this
session was running: many concurrent conveyor/review/dispatch processes, each making its own independent
`gh`/GitHub API calls with no shared coordination between them, caused `PR #2162`'s review-clear/drain pass to
fail non-fatally and retry repeatedly. Nothing today stops N independently-running processes from each
assuming they have the whole rate-limit budget to themselves.

**The goal, in the operator's own words, in substance**: build a **git manager** — a central coordination
layer that all git/GitHub operations across concurrent conveyor and subagent work should route through
("hook all git operation in concurrent conveyor and subagent work ideally"), rather than each process
independently making raw calls. Two requirements the operator stated directly:

1. **Telemetry.** It must track git/GitHub API call volume and rate-limit consumption over time. This ties
   directly into the telemetry system already built this session — `we:scripts/operations/telemetry.mjs` /
   `we:scripts/operations/telemetry-store.mjs` — rather than inventing a second recording mechanism.
2. **Self-adjusting to the REAL live rate limit, not a guessed static threshold.** It must read the actual
   rate-limit-remaining/reset signal off real GitHub API responses and throttle dynamically off that live
   signal. Confirmed earlier this session: GitHub returns rate-limit headers on every call, and the exact
   header names differ from the Anthropic/OpenAI ones researched earlier in this session. For GitHub
   specifically: the REST API returns `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`,
   `x-ratelimit-used`, and `x-ratelimit-resource` on every response; the GraphQL API returns the same header
   family AND additionally exposes an in-band `rateLimit` query field (`cost`/`limit`/`remaining`/`resetAt`/
   `nodeCount`) for point-based accounting a header alone can't give. The SECONDARY/abuse-detection limit (the
   one that actually fired in the live incident behind this goal — see the near-term-stopgap note below) is
   separate again: it surfaces as an HTTP 403/429 with an optional `Retry-After` header, not the primary
   `x-ratelimit-*` family, and is NOT reflected in `gh api rate_limit`'s own primary-quota numbers. A design
   that only watches the primary headers would miss the exact failure mode that triggered this goal.

**Explicitly not built yet.** No git-manager code, design, or scaffolding exists as of this entry — this is
operator intent to revisit and design, not a change already in flight.

**Near-term stopgap raised, NOT yet decided/authorized.** A smaller interim step — a shared rate-limit-aware
retry/backoff wrapper around the existing scattered `gh` calls, short of the full git-manager build — was
raised as a possible stopgap during this same discussion. That is not yet decided or authorized as a plan;
record it as raised, not agreed.

**Important finding while writing this entry down: a version of that stopgap already exists, partially,
in this repo — checked directly, not assumed.** `we:scripts/lib/gh-throttle.mjs` (`#3621`) is a real, already-
landed module built after this exact class of incident (its own header cites a prior live secondary-rate-limit
trip: "100 concurrent requests / 900 REST points-per-min / 2000 GraphQL points-per-min... confirmed separate
from and NOT reflected in the primary 5,000/hr quota"). It gives `gh` calls a concurrency cap (default 6,
deliberately conservative against GitHub's 100-concurrent secondary ceiling) built on top of
`we:scripts/readiness/heavy-admission.mjs`'s existing counting semaphore (see the reuse question below), and
retries a rate-limit-*shaped* failure (via `we:scripts/conveyor/infra-blocked.mjs`'s existing stderr
classifier) with bounded exponential backoff. Two things matter about it for this goal specifically:
- It is wired into only **3 of the ~84** `gh`-calling call sites that same incident's own grep found —
  the conveyor runner's highest-volume paths only, by its own header's admission, not a full migration.
- It throttles by a **fixed concurrency cap plus reactive retry on a failure already classified as
  rate-limit-shaped** — it does NOT read the live `x-ratelimit-remaining`/`x-ratelimit-reset` (or GraphQL
  `rateLimit`) signal proactively. So it does not yet satisfy requirement 2 above (self-adjust to the exact
  live limit); it is a real, working, narrower stopgap already partially in place, not a full answer to the
  live-signal requirement, and migrating the remaining ~79 call sites and/or making it header-driven is
  itself unmigrated, undecided follow-up — separate from, and short of, the full git-manager build.

**Codex readiness for this work, assessed today: not ready.** Codex cannot build any part of the git manager
right now — its OS sandbox currently blocks it from committing anything at all (a separate bug found today,
fix in progress, tracked outside this entry). Once that fix is confirmed, the plan discussed is to split the
git manager's work by risk, not hand the whole thing over:
- The core coordination/throttling logic — the part everything else depends on — stays with Claude. A bug
  there could cascade across the whole mechanical system, the same caution already applied to driver/conveyor
  subjects elsewhere in this epic.
- Well-scoped, self-contained pieces (a rate-limit-header parser, a telemetry-recording helper, tests) are
  reasonable first Codex candidates once the sandbox fix is proven — matching the atomic/no-design-judgment
  selection criteria that worked in the `#3565` trial.
- The point is reducing Claude token usage where it's safe to do so, not blanket-handing Codex critical
  infrastructure. None of this is authorized yet — it's the shape of the plan, contingent on the sandbox fix.

**Open question, not yet resolved: does this repo already have the right foundation to build on?** Two
existing mechanisms may already be relevant, and whether they are the same mechanism or two distinct ones —
and whether either is a natural foundation for the git manager's own coordination logic rather than building
from scratch — is being checked separately, right now, as of this entry. Not yet answered:
- `we:scripts/readiness/heavy-admission.mjs` (`#3461`/`#3456`) — the existing counting concurrency semaphore,
  used today to gate the heavy verify-gate step, and ALREADY reused (not reimplemented) by
  `we:scripts/lib/gh-throttle.mjs` above for its own independent `gh`-call pool.
- The general "operation" engine (`we:scripts/operations/registry.mjs`'s `op()` pattern plus
  `we:scripts/operations/engine.mjs`), used today for things like `restart-runner`.
A future session should resolve this open question before starting the git manager's design, not assume
either mechanism is or isn't the right base.

**A further vision extension, recorded here so the plan stays in one place, not scattered across chat: the
same wrapper-owned-content principle should cover every GitHub WRITE operation, not just commits.** The
operator extended the same principle just applied to fixing the Codex sandbox-commit bug (commits are
mechanically generated, never agent-composed free text) to the git manager's own scope: agents — Claude or
Codex alike — should never compose raw `gh` write content freely, whether that's a PR body/description, a
label, or a comment. Instead the wrapper renders that content from a template, fed by structured data the
agent supplies (what changed, why, findings) — the same shape as the commit-message fix, generalized. This
closes the same class of risk the commit fix closes: it guarantees standard-compliant formatting, and it
structurally blocks an agent from doing something wrong or dangerous through a raw `gh` call (a malformed
body, a wrong label, or worse) — a footgun-first structural fix, not a judgment call left to each agent.
**Existing precedent already in this repo supports this direction**, checked directly:
`we:scripts/operations/review-dispatch.mjs`'s `REVIEW_DISPATCH_DISALLOWED_TOOLS` already denies raw `gh` and
label-editing tool access to every spawned review session — this is the same discipline, not a new one; it
would generalize that discipline to build/fix/delivery dispatch's own PR-opening step too, which carries no
such restriction today. This is a plan/vision addition, not something built in this entry — recorded here so
a future design pass inherits it rather than re-discovering it.

## Open question flagged, not resolved (2026-09-13) — the #2502 PR-duplication cleanup may be a symptom of an incomplete WE→plateau-app migration for a piece of this epic's own mechanism

While closing out a cluster of duplicate PRs filed against `#2502` (WE #2060 + plateau-app #151, both
superseded by WE #2073 + plateau-app #152), the operator noted the duplication itself — the SAME fix
(threading the drain sweep's per-PR head SHA into the journal, adding a head-SHA-churn stuck signal) filed
independently in both `web-everything` and `plateau-app` under matching branch names/numbers — may not be
coincidence. It may instead be a symptom of an earlier, uncompleted effort to migrate some piece of this
epic's own mechanical-dispatch functionality (the drain sweep / stuck-signal detection this cluster touches)
out of `web-everything` and into `plateau-app`, left half-finished, so work kept landing in both places.

**Not resolved here — flagged for a fresh look later.** The actual placement question — what piece of this
mechanism belongs in WE vs. in `plateau-app`, and whether a migration is genuinely in flight or was only ever
attempted — is a real architectural call this cleanup pass deliberately did NOT make. It needs its own
dedicated decision turn (read both repos' history for the drain-sweep/stuck-signal code, confirm whether a
migration was ever started or ratified, and rule where this mechanism's canonical home is going forward),
not a byproduct of closing duplicate PRs. Recorded here, on this epic's own tracker, so whoever picks this up
next does not have to re-derive the observation from the closed PRs.

### Correction (2026-09-13) — the entry above misnames which PRs actually survived the cleanup

Checked directly against live PR state (`gh pr view <n> --json state,mergedAt`) rather than trusted as
written: **`WE #2073` and `plateau-app #152` — the two PRs the paragraph above names as the survivors — are
themselves `CLOSED`, not merged.** The cluster was four duplicate/near-duplicate PRs in total, not two:
`WE #2060`, `WE #2073`, `WE #2083` (all three `CLOSED`) and `plateau-app #151`/`plateau-app #152` (both
`CLOSED`). **The PRs that actually survived are `WE #2087`** (`MERGED` 2026-09-08) **and `plateau-app #155`**
(still `OPEN`, unmerged, as of this correction) — a different pair than the one named above. The substance of
the open-question section itself (the WE↔plateau-app migration-symptom question) is unaffected; only the
specific "which PR survived" citation was wrong.

## Session update (2026-09-13) — durable operator intent: extend Codex as a provider beyond build/fix/ci-heal to every declared operation

**Where this stands as of today, proven not just wired.** `#3564` → `PR #2169` ("WE #3564: delivery build")
went through the real `we:scripts/operations/deliver-item-run.mjs --provider=codex` path (#3580's wiring) and
came back independently reviewed carrying `review:accepted` with no findings. As of this write-up it is still
parked — `review:human` per this card's own rule 5/6, the human clearance ceremony hasn't run yet — so it has
not merged. But that parking is a process gate, not a doubt about the work: the delivery-and-review chain
itself is now proven end to end for the first time, not merely assembled. (Reproduce directly: `gh pr view
2169 --json title,labels,state,mergedAt`.)

**A live, real goal, NOT yet built, NOT yet designed, NOT yet scoped — recorded here per this file's own
"operation manager" convention (see that thread earlier in this file) so a future session doesn't have to
re-derive it from scratch.** The operator's own stated direction is to extend what Codex can be used for,
eventually, past the three delivery kinds it is wired into today — `build` (`we:scripts/operations/deliver-item-run.mjs`),
`fix` (`we:scripts/operations/fix-run.mjs`), `ci-heal` (`we:scripts/operations/ci-heal-run.mjs`), all three
taking `--provider=codex` per #3580 — to every operation this system declares, i.e. the full `OPERATIONS`
table in `we:scripts/operations/run.mjs` (built out via `we:scripts/operations/registry.mjs`'s `op()` engine).
That table already runs well past the three delivery kinds: `review-pr`, `review-prep`, `record-verdict`,
`verify`, `mutation-check`, `gap-sweep-status`, `restart-runner`, `clear-stuck-session`, `resolve`, `scaffold`,
`file-item`, `suggest-next`, `pr-status`, `gate-health`, `route-pr-outcome`, `dispatch-lane`, `claim`,
`explore`, `open-pr`, `stage-pr-view` — none of which have any Codex wiring today, and none of which this
session has scoped.

**How to approach it — not new doctrine, the same discipline this epic already proved works.** #3564/#3565
took build/fix/ci-heal from merely "wired" to actually "proven" by validating ONE real case with a real
independent review before trusting the class — never by assuming three wired operations meant the fourth
would just work. The same discipline applies here, harder, because the candidate operations don't share one
shape the way build/fix/ci-heal roughly do: `review-pr`'s juror is tool-bearing and lane-scoped
(`assertLaneCwd` refuses a spawn with no lane) in a way none of the three proven delivery kinds are;
`claim`/`resolve` are cheap reads-then-writes that may not need an agent seat at all; `restart-runner` and
`clear-stuck-session` are already fully mechanical passes today with no agent in the loop to swap a provider
under. So which operations even HAVE an "agent seat" a provider could be substituted into is itself part of
the undone design work here, not a given — one atomic operation at a time, a real independent review each
time, no blind trust that a provider swap proven for one operation transfers to the rest.

### Correction (2026-09-13) — the entry above conflates two separate systems; splitting scope into two tracks

Direct investigation confirms the paragraph above frames the `build`/`fix`/`ci-heal` delivery lifecycle as if
it belonged to the same `op()`-registered system as the rest of the `OPERATIONS` table it lists. It does not
— these are two separate layers, not one:

- **`dispatch-lane` IS a real `op()`-registered operation.** It is genuinely declared in
  `we:scripts/operations/run.mjs`'s `OPERATIONS` table (via `we:scripts/operations/registry.mjs`'s `op()`
  engine), three steps — read, plan, dispatch — with one `effect` step. That effect is what STARTS a build; it
  does not complete one. This part of the plan above is accurate.
- **The actual build/fix/ci-heal delivery lifecycle is a separate, hand-rolled script, not an `op()`
  declaration.** Lane acquire, agent spawn, gate, converge, PR open — the work
  `we:scripts/operations/deliver-item-wrapper.mjs` describes — runs via a per-kind provider handoff triggered
  after `dispatch-lane`'s effect fires. It never touches `we:scripts/operations/registry.mjs` or
  `we:scripts/operations/step-kinds.mjs`. It predates, and sits entirely outside, the `op()` declaration
  framework the rest of this entry is describing.
- **There is, and never has been, a `build` key in `OPERATIONS`.** Confirmed directly by grep of
  `we:scripts/operations/run.mjs`: every `_OP` entry in the table is `review-pr`, `review-prep`,
  `record-verdict`, `verify`, `mutation-check`, `gap-sweep-status`, `resolve`, `scaffold`, `file-item`,
  `suggest-next`, `pr-status`, `gate-health`, `route-pr-outcome`, `dispatch-lane`, `claim`, `open-pr`,
  `explore`, `stage-pr-view` — no `build`, `fix`, or `ci-heal` entry exists among them, now or ever.

**What this means for the plan.** Today's proven Codex delivery work (`#3564`/`#3565`) already lives in the
separate delivery-lifecycle layer (`we:scripts/operations/deliver-item-wrapper.mjs`'s per-kind provider
handoff), which is NOT part of the `op()`-registered set this entry's "extend to every operation" plan
describes. Extending Codex "to every operation" would only reach the `op()`-registered layer —
`dispatch-lane`'s own decision step, plus the genuinely `op()`-registered operations (`review-pr`, `claim`,
`resolve`, `scaffold`, `file-item`, and the rest listed above). It would NOT automatically cover more of the
actual coding/delivery work, because that work is architecturally a different, separate system.

**Scope, going forward, splits into two explicit tracks — do not conflate them:**

1. **Extending Codex within the `op()`-registered operations themselves** — e.g. a judge/juror seat inside
   `review-pr`-style operations, and potentially the `dispatch-lane` decision step itself. This is the part
   the plan above actually describes, and it remains undone, unscoped work.
2. **The already-proven, separate delivery-lifecycle work** (`we:scripts/operations/deliver-item-wrapper.mjs`'s
   per-kind provider handoff) that today's real Codex deliveries (`#3564`, `#3565`) actually used. This was
   never gated by, or part of, the "all operations" plan's stated scope above, and should not be conflated
   with it going forward — it is a different system with its own provider seam, already proven
   independently.

## Operator goal, recorded for the record (2026-09-13): every new model/provider release must earn its way out of probation before it gets blocking/gating authority

**This is a stated standing principle the operator wants applied going forward, not a "could do someday" idea
— treat it as real, durable operator intent, in the same terms as this epic's other recorded operator goals
above.** It generalizes directly from what this epic is building right now for Codex specifically (see the
Codex reviewer-seat validation follow-up and the `#3649` ratification, both above, same day): a probation
state a new model or provider release must sit in before this system trusts it with any authority that can
block or gate other work.

**The principle, stated plainly:**

- **Every new model or provider release — a new Claude version, a new Codex version, Antigravity, Grok, an
  open-weight model, or anything else added to this system in the future — goes through the same probation
  state this epic is building right now, before it is trusted with any blocking/gating authority.** Not just
  Codex, and not just today's roster: this is a standing gate on every future addition, named in advance so a
  future session does not have to re-derive it from first principles the way this session had to reconstruct
  the Codex case.
- **Probation means three things together, not any one of them alone:**
  1. **It can do real fix/build/review work.** Probation is not a sandbox that only runs toy tasks — it is
     seated on genuine work, the same way `CODEX_PROVIDER` (`#3580`) already dispatches real `build`/`fix`/
     `ci-heal` work and the Codex reviewer seat (`#3581`) already ran against 4 real, currently-open PRs.
  2. **It is seated as an advisory participant only — never blocking.** Its output can inform a decision but
     can never itself be the reason something is held, rejected, or gated. This is exactly the shape the
     Codex reviewer seat already has today (`--codex-advisory`, `judgeAdvisory`) and exactly why the finding
     above — 4 of 4 empty accepts, including a genuine missed blocker on `#2107` — was safe to learn from
     rather than a live incident: nothing was ever gated on that seat's verdict.
  3. **Its real performance is recorded, via `#3649`'s mechanism, not informally remembered.** Every probation
     run's transcript is scored against `#3649`'s versioned rubric and persisted as a vector-canonical
     scorecard — the same recording path this epic ratified fork-by-fork this same day, not a second,
     bespoke tracking scheme invented per provider.
- **Promotion out of probation is an explicit decision, grounded in the accumulated recorded data — never
  assumed just because a new version or provider becomes available.** A new Claude release, a new Codex
  release, or a first-time entrant (Antigravity, Grok, an open-weight model) does not inherit blocking/gating
  authority by default, by vendor reputation, or by benchmark claims made outside this system. It earns it the
  same way `#3649`'s own `3651` follow-up already requires for arming the run-quality router itself: a real,
  named, checkable trigger (here, an operator decision reviewing the accumulated probation data), not a
  default that fires silently.

**Why this generalizes beyond Codex — the identity-keying requirement.** Codex is the first real instance
exercising this mechanism, not the whole of it. **The probation state itself, and `#3649`'s recording of it,
must be keyed by provider *and* model identity together — never hardcoded to one provider, and never
collapsed to "provider" alone.** `#3649`'s own scorecard schema already carries a `model` field alongside
`dispatchKind` and the stamped `rubricVersion` (see `meanScore({ rubricVersion, model, effort, dispatchKind })`
in that card's own worked example) — this principle is the operating rule that field exists to serve: a
future Claude version, a future Codex version, or a brand-new provider is a **distinct identity** in this
scheme, starting its own probation record from zero. **A newer model release must never automatically inherit
an older model's accumulated trust** just because it shares a provider name or a family label — "Codex" is not
one identity forever; "Codex version X" and "Codex version X+1" are two separate identities under this
principle, each starting cold. The same holds across a Claude version bump: today's Claude is the trusted
default delivery provider by virtue of a long track record recorded the old way (informally, pre-`#3649`); a
future Claude version is not exempt from this same probation-and-record discipline merely for sharing the
`Claude` name — the identity key is provider+model, not provider alone, and probation applies to a genuinely
new model identity even from an already-trusted provider.

**Current state, for concreteness, not as the point of this entry.** As of today: Codex is proven-wired for
real build/fix/ci-heal delivery work (`#3580`) and has one seat already run in advisory-only mode against real
PRs (`#3581`'s reviewer-seat trial, 4/4 empty, one confirmed miss) — exactly probation-shape, mechanism clean,
judgment not yet trusted, nothing blocked on its verdict. `#3649`'s recording mechanism is ratified fork-by-
fork this same session but ships v1 recording-only, router disarmed, arming gated on `#3651`'s own named
trigger. This entry does not change any of that; it records the general rule those specific facts are the
first instance of, so the rule outlives this specific Codex episode and applies unprompted to whatever comes
next.

## Operator goal, recorded for the record (2026-09-13): make the lane-concurrency admission cap resource-aware instead of a flat count

**Real, durable operator intent — not built now, just recorded**, in the same terms as this epic's other
forward-looking goals above (the capacity-planning split and the git-manager coordination layer) — not a
"could do someday" idea a future session should second-guess away.

**Trigger, confirmed live today.** `we:scripts/lib/lane-concurrency.mjs`'s host-wide shared pool (default cap
8, coordinated across all concurrent sessions via `~/workspace/.lanes/web-everything/`) is a flat, count-based
admission control: it treats every lane as equal weight regardless of what the item actually requires. A real
proof-run attempt today hit exactly this limit — roughly 40+ of 63 lanes leased host-wide, the shared pool
saturated, real work blocked purely by lane COUNT, not by any actual measured resource exhaustion (CPU, memory,
or otherwise).

**The operator's stated view, recorded in substance, verbatim in intent:**
1. The current flat-count cap is a deliberately crude stopgap against oversaturation, acknowledged as such by
   the operator — not a permanent design. It exists to keep the host from being overrun, not because a fixed
   count of 8 is the right unit of capacity.
2. Once the per-process resource telemetry built earlier today (the `host.process.*` categories in
   `we:scripts/operations/telemetry.mjs` / `we:scripts/operations/host-process-sample.mjs`, landed at
   `6305d81dc`) accumulates enough real data on actual load per lane, capacity admission could become
   resource-aware instead of a flat count — e.g. admitting based on measured/estimated compute load rather than
   a fixed number of concurrent lanes.
3. A further idea: estimate a story/item's likely compute cost DURING PREPARATION/scoping — alongside the
   existing "scope" sizing already done at prepare-time — so a text-only change with no unit tests is
   recognized as needing much less capacity than a heavy build+test cycle. A future admission system could then
   weight concurrent admission by this per-item cost estimate, rather than treating every item as the same unit
   of capacity regardless of what it actually costs to run.

**Distinct from, but connected to, the capacity-planning goal recorded above.** That earlier entry is about
measuring total hardware capacity and splitting the command-queue pool from the lane pool. This goal is
narrower and different in kind: it is specifically about making the EXISTING admission mechanism
(`we:scripts/lib/lane-concurrency.mjs`'s flat cap) smarter, using the real per-process telemetry data already
being collected plus a per-item cost estimate made at prepare-time — not a question of provisioning
more/different hardware.

**Explicitly not built yet.** No resource-aware admission logic, no per-item cost-estimation step, and no
telemetry-driven cap adjustment exist as of this entry — `we:scripts/lib/lane-concurrency.mjs`'s cap is still a
flat, static count. This is operator intent to revisit once the telemetry above has accumulated enough real
data to design against, not a change already in flight.

## Session update (2026-09-13, continued) — the Codex delivery pipeline proven end-to-end across three real items, plus two real infrastructure bugs it surfaced and fixed

**Proven, not just wired.** Three real items went through
`we:scripts/operations/deliver-item-run.mjs --provider=codex` and landed: `#3564` → `PR #2169`, `#3565` →
`PR #2172`, `#3506` → `PR #2176` — all three `MERGED`, all three carrying a real `Co-Authored-By: Codex`
trailer on their build commit (`193395f50`, `a528b1486`, `8ccea68d9` respectively — confirmed by
`git log --grep="Co-Authored-By: Codex"`), and all three came back from an independent review pass with
`review:accepted`. This is the delivery-agent side of the pipeline the earlier "reviewer-seat judgment gap"
finding (above) does NOT call into question — that finding was about the advisory REVIEWER seat, not the
delivery-agent BUILD seat these three items exercised.

**Two real infrastructure bugs found and fixed along the way, both confirmed present on
`origin/lane/mechanical-dispatcher`:**
- `56a333e63` — "delivery: fix commitBuildTurn's locus-prefix auto-fix to cover EVERY bare mention, not just
  touched paths" (`#3383`/`#3565`).
- `f70b0641e` — "delivery: fix commitBuildTurn/commitConvergeRound crashing on a genuinely new (never-tracked)
  touched file" (`#3383`/`#3564`) — this is the same untracked-file/`git commit -F` class of bug the earlier
  Codex-reviewer-seat validation night caught as a miss on `#2107`; it recurred on a real live delivery and got
  a real fix this time.

**A separate, structural bug in the `deliveryAgent: codex` marker itself was also found and fixed**:
`f74d16cd2` — "mechanical-dispatcher: fix deliveryAgent: marker invisible when REPO_ROOT is stale" (confirmed
on the branch) — a lane-acquire ordering bug where the marker read a stale `REPO_ROOT`, making a real
`deliveryAgent: codex` marker invisible to the dispatcher.

## Session update (2026-09-13, continued) — two new advisory judge seats (Codex correctness, Antigravity), plus the generic model-probation system underneath both of them, plus #3649's recording mechanism actually BUILT (not just ratified)

**Fourth judge seat — Codex correctness-advisory**, `467ffb79f` ("review-pr: add a genuinely NEW fourth judge
seat — Codex correctness-advisory (#3383)"), extended to the probation default by `df00bd9e9`. Distinct from
the pre-existing `simplicity` lens seat; structurally non-blocking (advisory only), same shape as every other
seat this epic has proven out.

**Fifth judge seat — Antigravity advisory-review**, `bbd469c0b` ("review-pr: wire Antigravity in as a genuine
fifth judge seat"), backed by a new tool-free primitive `63102bde8` ("add we:antigravity-judge-spawn.mjs: a
tool-free Antigravity CLI judge primitive"). Built tool-free deliberately — `we:backlog/3633`'s known finding
that Antigravity's own `--sandbox` flag only confines the shell, not Antigravity's own file tools, informed
keeping this seat advisory/non-delivery-capable rather than write-capable. Same non-blocking pattern as the
Codex seat; registered in probation.

**The generic model-probation system underneath both new seats**: `f4395e2af` ("mechanical-dispatcher: generic
{provider,model} probation status + #3649 run-quality recording mechanism (epic #3383)") adds
`we:scripts/lib/model-probation.mjs`, keyed by `{provider, model}` identity plus role
(`unvalidated|probation|trusted`) — exactly the identity-keying the operator-goal entry above ("every new
model/provider release must earn its way out of probation") calls for. Both Codex seats and the new
Antigravity seat default to live `probation` status under this system, confirmed by the same commit.

**`#3649` itself — ratified fork-by-fork earlier today (`PR #2157`), but its own header noted it "builds none
of the five pieces its ruling names." That gap is now substantially closed, same commit (`f4395e2af`)**: the
run-quality recording mechanism is real and has scored actual Codex runs, not test fixtures only. Building it
surfaced a real gap the ratification itself did not anticipate: **advisory judge seats were running effectively
ephemeral for scoring purposes** — no durable transcript, nothing for `#3649`'s scorer to read. Codex's side
of this gap is fixed: `52c8a00ce` ("fix(codex-judge-spawn): persist the judge's raw JSONL transcript so #3649
can score it (not null)") adds `persistCodexJudgeTranscript`, confirmed wired as the default
`persistTranscript` in `we:scripts/lib/codex-judge-spawn.mjs`.

**Two pieces of this thread remain genuinely unfinished, checked directly against the branch rather than
assumed done:**
- **Antigravity's equivalent transcript-persistence fix has NOT landed.** Grepping
  `origin/lane/mechanical-dispatcher` for `persistAntigravity`/`AntigravityJudgeTranscript` returns nothing —
  no commit, no function. The Antigravity seat added this same session (`bbd469c0b`) is exposed to the same
  ephemeral-transcript gap Codex's seat had, unfixed as of this update.
- **`appendScorecard` (`we:scripts/conveyor/run-scorecard-store.mjs`) still has zero real callers outside its
  own test file**, confirmed by grep — every other reference is documentation or the test suite. Wiring it
  into real dispatch completions (so a real Codex/Antigravity run's score is actually persisted, not just
  persistable) has not landed. Both of these were reportedly dispatched as follow-on fix work; **no resulting
  commit or PR was found on `main` or `origin/lane/mechanical-dispatcher` as of this check** — treat both as
  still pending, not landed, until a fresh session finds the actual commit.

**A third in-flight item from the same thread, also unconfirmed as landed:** the `fix`-kind Codex dispatch
finding that it is 100% blocked by a sandbox-vs-report-path collision (Codex's sandbox denies reading the
primary checkout, but the fix-report CLI path resolves there) — a fix was reportedly dispatched for this too.
No commit or PR addressing a sandbox/report-path collision was found on either branch as of this check. Flag
for a fresh session to search current state directly (`git log --grep=sandbox -i`, open PR list) rather than
assume it landed.

## Session update (2026-09-13, continued) — automatic driver-based Codex routing: the MARKERS are proven landed; the actual live-fire dispatch is NOT yet confirmed to have executed

**What is confirmed landed**: two PRs merged straight to `main` (content-only backlog edits, no lane/
mechanical-dispatcher involved) set real `deliveryAgent: codex` markers on three existing backlog items,
intended as live-fire targets for automatic (non-manual) driver-initiated Codex routing:
- `PR #2181` (merged) — marks `#3428` and `#2866` `deliveryAgent: codex`.
- `PR #2183` (merged) — marks `#3360` `deliveryAgent: codex`, adds a `scope` to `#3428`.

Both confirmed present on `origin/main` by direct file read: all three backlog files (`#3360`, `#3428`,
`#2866`) carry `deliveryAgent: codex` in their frontmatter as of this check.

**What is NOT confirmed**: whether the driver has actually picked any of these up and completed a real
automatic dispatch. As of this check — `status: open` on all three items on `origin/main`, no build commit
for any of them found anywhere, `gh pr list --search "3360"` / `--search "3428"` return no PR touching either
item's actual work, no `codex` process running host-wide, and no lane reservation referencing either item
number. **This is a correction to how this milestone should be read going forward**: the markers making
`#3360`/`#3428` eligible for automatic routing are real and landed; a completed, real, driver-initiated
end-to-end proof run for either item is not yet evidenced by repo state at the time of this check. A fresh
session should re-verify directly (`gh pr list --search "3360"`, `--search "3428"`, `gh pr view` on any hit,
and the backlog files' own `status` field) before treating automatic routing as proven, rather than carrying
forward an optimistic assumption. (Real driver-initiated Codex deliveries — with real `Co-Authored-By: Codex`
commits — ARE proven for `#3564`/`#3565`/`#3506` via manual `--provider=codex`, per the session update above;
that is a separate, already-confirmed claim from the *automatic*, marker-driven routing this section is about.)

## Session update (2026-09-13, continued) — new decision filed and prepared: graduation criteria for exiting probation

`3654` — "Define graduation criteria for a model/provider to exit probation status" — was filed via
`PR #2185` (merged) and JIT-numbered to `#3654` on land. A `/prepare` pass then ran against it and merged via
`PR #2187` ("prepare #3654: graduation criteria for a model/provider to exit probation"), confirmed by reading
the PR body directly. Four forks were framed and `preparedDate` stamped — **ready to ratify, not yet ratified**:

1. **Volume/mix**: a minimum trial count plus at least one genuinely informative (failure/edge-case) trial,
   not count alone — exact N deliberately deferred, consistent with `#3649` Fork 4's own precedent.
2. **What's measured**: success rate as a floor, plus a confirmed severity-calibration miss as an independent,
   necessary-but-not-sufficient veto.
3. **Per-role vs. global**: the bar scales with the role's eventual authority (`advisory-review` lightest,
   `delivery` moderate, a future blocking/gating role strictest).
4. **Per-provider vs. uniform**: one uniform floor for every `{provider, model}` identity — no identity buys
   an easier bar by reputation; a project may optionally tighten (never loosen) per identity.

Each fork was attacked by a separately-dispatched skeptic sub-agent (all four `SURVIVES-WITH-AMENDMENT`) and
cleared by a fresh-context two-confusion screen, per the PR body. This item directly answers the "no
graduation criteria exist yet" gap the probation system above was built without.

## Session update (2026-09-13, continued) — cross-session coordination, provider-evaluation filings, stray-session hygiene, and the POC-branch CI gap

**Cross-session coordination with a peer session (`webeverything-85`)**: a real file-conflict risk was found
and reconciled on `we:scripts/operations/dispatch-lane-io.mjs` / `we:scripts/operations/review-dispatch.mjs` —
both `PR #2130` ("WE #3331: read a --bg dispatch's REAL session id back off stdout") and `PR #2003` ("WE
#3331: graduate the session-identity fix from lane/mechanical-dispatcher") touch the same two files under the
same `#3331` card, confirmed by diffing both PRs' file lists directly. **Both remain genuinely `OPEN` as of
this check** — the reconciliation is a plan, not yet executed; whoever lands one of these next should check
the other for the same edit first. Separately, `we:scripts/lib/codex-judge-spawn.mjs` work was clarified as
duplicate (not conflicting) effort with the peer session, not a second real conflict.

**Three provider-evaluation items filed for later work, all via one PR (`PR #2179`, confirmed `OPEN`,
unmerged as of this check):**
- `3660` — probe Cursor as an additional dispatch provider.
- `3661` — probe Grok (top-tier subscription) as a bulk high-volume dispatch provider.
- `3662` — probe open-weight PAYG models (DeepSeek, Qwen) as a bulk high-volume dispatch provider.

**Stray-session/orphaned-watcher hygiene**: the behavioral memory fix landed —
`we:agent-memory-src/no-stray-sessions-or-orphaned-watchers.md`, `PR #2174`, confirmed `MERGED`. A follow-on
design-only safety-net item, `3655` ("design a stray-resource monitoring safety net"), was filed via
`PR #2177`, confirmed still `OPEN`/unmerged as of this check.

**`clear-stuck-session` mechanized and wired into the reaper**, both confirmed present on
`origin/lane/mechanical-dispatcher`: `81d5c9745` ("operations: add clear-stuck-session — mechanize the GH
#77683 zombie-session workaround") and `2142bd0c0` ("conveyor: session-reaper mechanizes the #77683 repair via
clear-stuck-session"). A docs follow-up pointing stuck-session cleanup at the new mechanized path instead of
the old manual workaround (`PR #2170`) is filed but confirmed still `OPEN`, unmerged.

**POC-branch CI gap — filed AND landed.** `3653` ("allow GitHub Actions CI to be enabled for POC branches,
not just main") was filed and merged via `PR #2171`, then JIT-numbered to `#3653` on land (confirmed:
`git log` shows `cbd4ac3e7 drain: JIT-number 3653→#3653 at land`). This closes the gap where PRs on
`lane/mechanical-dispatcher` never got real GitHub Actions CI.

**Duplicate/escalated PR resolutions, checked directly rather than transcribed:**
- The `#2502` cluster — see the "Correction" subsection above; the real surviving PRs are `WE #2087`
  (`MERGED`) and `plateau-app #155` (`OPEN`), not the pair the original entry named.
- `frontier-ui #2755` (`#45` vs. `#47`) — both PRs are duplicates of the same native Go SSR renderer
  foundation work and, confirmed directly against the `frontierui` repo, **both remain `OPEN` as of this
  check** — record this as "duplication identified, not yet resolved on either PR," not as already landed.
- `#3331` `#2130` vs. `#2003` — the same pair covered under "cross-session coordination" above; both `OPEN`,
  reconciliation not yet executed.

## Session update (2026-09-13, continued) — Codex fix/ci-heal sandbox bug fixed + `#3649` scorecard wired to all four real call sites; Antigravity seated as a fifth judge (not yet trialed); a genuine, still-unresolved `#3654` numbering collision between `main` and the prototype branch

Everything below was re-verified directly against `git log`/`git show`/`gh pr view` at the time of this
update, not transcribed from an earlier summary — several claims that looked landed going in turned out to
still be in flight, and are corrected accordingly rather than recorded as done.

### Confirmed landed

**Codex fix/ci-heal sandbox-vs-report-path bug fixed, `#3649`'s scorecard wired to all 4 real dispatch call
sites — `a0d328fb1`, on `origin/lane/mechanical-dispatcher`.** Two bugs, both closed in one commit: (1) every
Codex `fix`/`ci-heal` dispatch was blocked before the agent could even check in `started`, because
`we:scripts/operations/fix-dispatch-wrapper.mjs`'s report-CLI path pointed at the primary checkout while the
Codex sandbox's own deny-list blocked reading that whole root — fixed by staging the report CLI's dependency
closure into the agent's own lane at dispatch time; (2) `appendScorecard` (`we:scripts/conveyor/run-scorecard-store.mjs`)
had zero real callers, so `we:scripts/conveyor/run-scorecards.json` stayed empty for every genuine dispatch —
fixed by wiring `recordCodexRunScorecard` into all four real call sites
(`we:scripts/operations/deliver-item-wrapper.mjs#CODEX_PROVIDER`,
`we:scripts/operations/fix-dispatch-wrapper.mjs#FIX_CODEX_PROVIDER`,
`we:scripts/operations/ci-heal-dispatch-wrapper.mjs#CI_HEAL_CODEX_PROVIDER`,
`we:scripts/lib/codex-judge-spawn.mjs#codexJudgeSpawn`). Verified live, not just unit-tested: a real fix-kind
Codex dispatch against real, untouched PR #2032 produced a real `started` check-in and a genuine,
non-synthetic `we:scripts/conveyor/run-scorecards.json` row.

**Antigravity judge-transcript persistence fixed — `042ae4f62`, mirroring Codex's own equivalent fix
(`52c8a00ce`).** `we:scripts/lib/antigravity-judge-spawn.mjs` now persists its raw stream-json transcript
instead of leaving it `null`, so `#3649`'s scorer can actually read it. Confirmed present on
`origin/lane/mechanical-dispatcher`.

**Antigravity wired as a genuine fifth judge seat — `bbd469c0b`, plus its standalone primitive `63102bde8`.**
Mirrors the Codex correctness-advisory seat exactly: a new `judgeAntigravityReview` step on its own
`antigravity-review` lens (disjoint from every existing lens set by construction), opt-in via
`REVIEW_PR_ANTIGRAVITY_REVIEW`, registered on `probation` for `{provider: antigravity, model: gemini-3.1-pro,
role: advisory-review}` — **the commit's own text states this identity "has zero prior review trials,"
unlike Codex's seat which had build-side trials first.** Read literally: the seat is wired, not yet exercised.
**No real Antigravity review trial has run as of this check** — no scorecard row, no PR review referencing it
was found anywhere in the repo. Anyone picking this up should not assume a first trial has happened; it is
still an open action item, not a completed one.

### A genuine, real numbering collision — confirmed by reading both branches directly, still unresolved

`#3654` currently means two different things depending which branch you read, and this is a real divergence,
not a stale false alarm:

- On `origin/main`: `we:backlog/3654-define-graduation-criteria-for-a-model-provider-to-exit-prob.md` —
  "Define graduation criteria for a model/provider to exit probation status," `status: open`,
  `preparedDate: "2026-09-13"`. Confirmed real, safe, and complete: four forks, each attacked by a separately
  dispatched skeptic sub-agent (all four `SURVIVES-WITH-AMENDMENT`), cleared by a fresh-context screen —
  **ready to ratify, not yet ratified.** (This is the same item already recorded above under "new decision
  filed and prepared"; nothing about it needed correcting.)
- On `origin/lane/mechanical-dispatcher`: `we:backlog/3654-codex-model-routing-pin-a-codex-model-per-rung-or-keep-inher.md`
  — a different card entirely ("Codex model routing: pin a Codex model per rung, or keep inheriting"),
  assigned that same number by the branch's own independent JIT-numbering heal
  (`f4395e2af`'s commit message: `we:scripts/backlog-renumber-collisions.mjs` resolved a 3635/3636/3637
  collision to 3654/3655/3656 locally, against a `main` merge-base that was already stale by the time `main`'s
  own drain separately numbered the graduation-criteria item `#3654`).

**Both files exist, under the same number, on their respective branches, right now.** This has not been
healed — see "still not done" below; the merge that would surface and resolve this collision (main wins,
per the newly-adopted tiebreaker below) has not happened yet.

**Correction: the standing "main always wins a numbering collision" rule is not yet actually written down.**
No file at `we:agent-memory-src/backlog-numbering-must-resolve-against-main.md` (or any equivalent) exists on
`main`, on `origin/lane/mechanical-dispatcher`, or anywhere else in this repo's history as of this check —
confirmed by direct search. Treat this as a **decided-in-conversation-but-not-yet-authored** rule: the
principle behind it is now explicit here on this tracker (main wins; a lane's own JIT-heal must ultimately
defer to it), but the durable agent-memory artifact still needs to be written by whoever next touches this.
Do not carry forward an assumption that it already exists.

### Two small bugs filed, PR still open — correcting a "landed" assumption

`3657` ("`we:scripts/lane-pool.mjs#ensureDeps` leaks `npm ci`'s inherited stdout into an acquire's
captured lane path") and `3656` ("`dispatchFix` leaks its acquired lane when the finding-scratch-file write
throws early") — both found live while fixing `a0d328fb1` above, both filed as backlog cards, no fix attempted
in the same PR. **`PR #2188` is confirmed `OPEN`, not merged**, as of this check (`gh pr view 2188`). Filing
happened; landing has not.

### Checked and confirmed still in flight — not recorded as done

- **`#3521` automatic Codex-routing proof-run.** A marker commit (`d8ff48145`, "mark #3521 deliveryAgent:
  codex") is pushed to its own small branch, `origin/lane/mark-3521-deliveryagent-codex`, based on current
  `main` — **not** part of `lane/mechanical-dispatcher`. No PR exists for that branch (`gh pr list --search
  "3521"` returns nothing touching it), and no further dispatch, PR, or run record for `#3521` was found
  anywhere. The marker is in place; the actual automatic-routing run it sets up has not been observed to
  complete.
- **Antigravity's first real review trial** — see above: wired, on probation, zero trials recorded.
- **Cursor / Grok / open-weight-PAYG provider research** — still filing-only, exactly as already recorded
  above under "Three provider-evaluation items filed." Re-confirmed directly from each commit's own message
  (`b467e029c`, `0fcf8fc52`): *"Filing only, per the operator's explicit request; no build or deep research
  performed."* No CLI capability was actually probed for any of the three candidates; `PR #2179` carrying all
  three remains `OPEN`.
- **A git-manager slice for `gh pr create`/`open-pr` specifically** — not built. Direct inspection of
  `we:scripts/operations/open-pr-io.mjs` and `we:scripts/pr-land.mjs` (the actual `gh pr create` call site)
  shows no `we:scripts/lib/gh-throttle.mjs` wiring and no new self-calibrating, live-rate-limit-header-driven
  logic added there. What exists there today predates this session: `we:scripts/pr-land.mjs`'s own `#2659`
  infra-blocked path (classifies a post-push `gh pr create` failure and auto-retries with backoff via the
  conveyor tick, not a live `x-ratelimit-*` reader) and the separately-landed `we:scripts/lib/gh-throttle.mjs`
  (`#3621`, a concurrency cap plus reactive retry, wired into only ~3 of the repo's ~84 `gh`-calling sites,
  not `open-pr`/`pr-land` among them). The full git-manager vision recorded earlier in this file is still just
  that — a vision, not a build; nothing changed on that front this session.
- **A full merge of current `origin/main` into `lane/mechanical-dispatcher`** — not completed, not pushed.
  `git merge-base lane/mechanical-dispatcher origin/main` still resolves to `4261ef224`, ~15 merged PRs behind
  current `main` (through and including `PR #2189`'s tracker update). Worth flagging for whoever picks this up
  next: two lanes (`lane-1`, `lane-3`) are currently leased under the purpose `merge-mechanical-dispatcher-main`
  (acquired ~18:55 EDT this same evening), but as checked directly, both sit on plain `main`, far behind, with
  no merge attempted and no commits toward it — and the PIDs recorded on their leases are no longer running.
  This reads as a stale or abandoned start, not active in-progress work; confirm before assuming it is being
  handled.

## Operator note, recorded for the record (2026-09-13): value confirmed in #3621's container-based resource isolation, but active work is explicitly deferred until judge/provider integration graduates

**The statement, in the operator's own terms:** containers will likely be useful for resource management, but
it is a larger piece of work, so it should wait until the current judge/provider integration work
(Codex/Antigravity/model-probation) graduates — i.e. defer per `#3621`'s own already-researched recommended
sequencing. **This is not a ratification** and does not stamp a `preparedDate` — `#3621` stays `open`/
unprepared, per this repo's "never take an unprepared decision" doctrine. This entry only records stated
operator intent/sequencing so it is not lost, the same discipline this tracker has used for every other
operator statement recorded above tonight.

**This confirms #3621's own most recent amendment rather than adding a new judgment on top of it.** `#3621`'s
2026-09-11 "LIVE test" amendment already concluded, in its own "Recommended sequencing" section: "the
operator's stated preference — wait until Codex and Gemini are hooked up — is well supported by the evidence,
because the Codex work gains nothing from waiting for containers. If anything starts in parallel sooner, it
should be the heavy-command container pool, not per-lane containers." Tonight's operator statement restates
and confirms that same sequencing rather than introducing a different one.

**Ties to `#3654`'s graduation criteria.** The "judge/provider integration work" this defers behind is this
same epic's model-probation system (`we:scripts/lib/model-probation.mjs`) plus its two new advisory seats
(Codex correctness, Antigravity) — see the session updates above. `#3654` ("Define graduation criteria for a
model/provider to exit probation status") has had all four of its forks ratified per `PR #2195` — confirmed
`OPEN`, **not yet merged to `main`** as of this check; do not assume it has landed. Once that PR merges and
the probation system has real graduation criteria to operate against, active work on `#3621` becomes in-scope
again per this sequencing.

**If anything on this axis starts before graduation, it should be the heavy-command container pool, not
per-lane containers** — `#3621`'s own distinction, restated here because it is the one piece of the container
idea this deferral does not cover: it needs no auth/billing change, answers `#3621`'s founding incident
(`#3594`'s busy-spin) directly, and would produce the throughput measurement data the core-split amendment
still lacks.

## Session update (2026-09-13, continued) — `#3654` (graduation criteria for exiting probation) ratified, all four forks

`#3654` — "Define graduation criteria for a model/provider to exit probation status," filed and prepared
earlier this session (see the "new decision filed and prepared" update above) — was ratified by the operator
(Nicolas Gilbert) in one pass, all four forks approved as prepared, no amendments. Now **resolved**,
`codifiedIn: we:docs/agent/platform-decisions.md#model-probation-graduation-criteria` — unlike `#3649`, this
card's full ruling earns statute (it *is* the shape of the graduation bar), not a narrow rider under an
existing anchor.

Ratified, as recommended: **(1)** a minimum trial count plus at least one genuinely informative trial (a
confirmed miss or a documented cross-reviewer disagreement), never count alone; **(2)** success rate as a
floor, with a confirmed calibration miss an independent veto regardless of accept rate, never diluted into a
blended composite; **(3)** the bar scales with the role's eventual authority (`advisory-review` lightest,
`delivery` moderate, a future gating role strictest, not yet built); **(4)** one uniform floor for every
`{provider, model}` identity — no identity buys an easier bar on reputation, though a project may tighten
(never loosen) per identity as an optional config choice.

**No concrete numeric N is fixed by this ruling**, consistent with `#3649` Fork 4's own precedent — a
specific N per role is deferred to a follow-on ordinary (batched) finding once real trial-count data exists,
never a separate ceremony. No graduation-check function is written and no threshold is wired into
`we:model-probation.mjs` here — this card rules on the shape of the bar only; wiring it is still unfiled
future work, distinct from this ratification.

## Session update (2026-09-14) — heavy-command-pool container POC started, per operator direction

Tracked here as a progress note rather than a new formal backlog item, per the operator's own explicit
instruction ("we can maybe track on the prototype progress unless need formal item to be filed"). Checked
first whether this repo's PR-landing convention requires a formal item: it does not — `we:scripts/pr-land.mjs`
only refuses an EMPTY PR description (#2324), and recent precedent (`PR #2131`, "fix: throttle
we:review-set-label.mjs's last bare execFileSync call (#3631 slice)") lands a real, tested code change that
references an EXISTING item by number without filing a new one. This slice does the same: it references
`we:backlog/3621-real-os-level-resource-isolation-per-dispatched-lane-is-appl.md` directly (an amendment was
also added there, dated the same day) rather than opening a sibling item.

**Why this slice, now, despite #3621's own per-lane-container deferral still standing.** #3621's 2026-09-11
amendment corrected an earlier framing and drew a real distinction the operator's brief for this task also
draws: per-lane containers remain gated on a real, unresolved auth/billing question (switching dispatched
sessions from OAuth/keychain to `ANTHROPIC_API_KEY` metered billing) — that deferral is UNCHANGED and still
applies. The heavy-command-pool slice is different: it needs no auth/billing change at all (`check:standards`
and `test:unit` need no credentials), it was #3621's own amendment's explicit recommendation for "if anything
starts in parallel sooner," and it answers a real, currently-live problem this same night: the heavy-admission
semaphore (`we:scripts/readiness/heavy-admission.mjs`, `DEFAULT_ADMISSION_CAP = 2`) is a purely COOPERATIVE
counting semaphore with no resource boundary behind it — it throttles how many heavy commands run at once,
never what any one of them can do to the host once admitted.

**What was built — a working first slice, `check:standards` only, proven with real evidence, not a mock.**

- `we:scripts/lib/container-exec.mjs` (new) — builds the `container run --cpus N --memory Ng` argv and runs a
  command inside a real Apple `container` instance. The checkout is bind-mounted read-write at its own
  absolute path; when the checkout has a git-alternates primary root (a `--reference`-cloned lane, the normal
  shape `we:scripts/lane-pool.mjs` produces), that primary is ALSO mounted read-only at its own identical
  absolute path — without this, `git merge-base origin/main HEAD` and similar calls inside the container fail,
  which was the first real failure mode hit while building this (git's alternates file records an absolute
  host path that otherwise does not exist inside the guest).
- `we:scripts/lib/container-exec/Containerfile` (new) — `node:22-alpine` plus `git` (alpine's base ships
  none, and `we:scripts/check-standards.mjs` shells out to it). Deliberately does NOT bake a linux-arm64 `node_modules`
  the way #3621's own fuller research measured: `check:standards`'s actual npm closure (`gray-matter`,
  `markdown-it`) is pure JS with no native binding, so the lane's own host-built (darwin) `node_modules`
  mounts straight in and just works. This is a real, narrower, cheaper path than #3621 measured for the FULL
  suite — but it is NOT proven for `test:unit` (vitest/esbuild/rollup carry real native darwin bindings in
  this lane's tree; #3621's own `MODULE_NOT_FOUND` finding almost certainly still applies there without the
  baked-linux-tree approach that item already measured).
- `we:scripts/readiness/heavy-admission.mjs` — gained a general-purpose `run` CLI mode
  (`node we:scripts/readiness/heavy-admission.mjs run [--container] -- <cmd…>`, `runUnderAdmission`) that this
  repo's `main` did not yet have (a fuller version of the same idea exists only on the separate, still-unmerged
  `lane/mechanical-dispatcher` integration branch, per #3383's own earlier finding — the two will need
  reconciling, likely a straightforward union, whenever that branch merges to `main`; flagged here rather than
  silently duplicated). `--container` (or `WE_HEAVY_ADMISSION_CONTAINER=1`) is OPT-IN ONLY: it swaps the
  command's execution from host `execSync` to `we:scripts/lib/container-exec.mjs#execContainerized`; every existing caller,
  and `run` without the flag, is byte-for-byte unchanged.

**Real evidence, measured on this machine tonight:**

- **Fidelity**: `check:standards` run inside the container and on the host, back-to-back against the SAME repo
  state, produced the IDENTICAL error count (3 errors — real, pre-existing, unrelated stranded-backlog-hash
  issues live on `main` right now) and the identical error messages. The one output difference was a single
  warning swap (`fui:`/`plateau:` sibling-checkout-absent vs. a block-export-shape warning) caused by this POC
  not yet mounting the `frontierui`/`plateau-app` sibling checkouts — a named, understood scope gap, not a
  correctness bug.
- **Cap enforcement, reproducing #3621's own busy-spin containment method**: 8 unbounded `while :; do :;
  done` spinners inside a `--cpus 2 --memory 2g` container held the host-side
  `com.apple.Virtualization.VirtualMachine` process at ~190-205% CPU throughout the run (sampled 3x during a
  live run) — on the host, the SAME shape ran unconstrained reaches ~800% per #3621's own prior
  measurement. The cap is real, not aspirational.
- **End-to-end via the actual wrapper**: `node we:scripts/readiness/heavy-admission.mjs run --container --
  node we:scripts/check-standards.mjs` correctly acquired a real admission slot (this host's cap was genuinely
  saturated by other live lane activity during this session — a real, not staged, demonstration of the
  capacity pressure this whole item exists to address), ran the command inside the container, and propagated
  its real nonzero exit code back out.
- Unit tests added: `we:scripts/lib/__tests__/container-exec.test.mjs` (pure argv/mount-derivation logic, plus
  a self-skipping REAL integration block that only runs when the `container` CLI and this POC's image are
  actually present) and new cases in `we:scripts/readiness/__tests__/heavy-admission.test.mjs` for
  `runUnderAdmission`/`shellQuoteWord`/the injectable container-exec seam.

**What is explicitly NOT done — left for a real follow-up, not overclaimed:**

1. Only `check:standards` is proven. `test:unit` and the Playwright visual-capture pass are NOT wired or
   proven — `test:unit` in particular needs the baked-linux-tree approach #3621 already measured (~14s `npm
   ci` in-image), not the bind-the-host-`node_modules` shortcut this slice uses.
2. `--container` is not wired as the DEFAULT anywhere — `we:scripts/verify-lane.mjs`'s own gate execution, and every
   other existing heavy-command call site, still runs on the host exactly as before this PR. Turning it on by
   default (even for `check:standards` alone) is a deliberate follow-up decision, not made here.
3. The `frontierui`/`plateau-app` sibling-checkout mounts are not included, so `check:standards`'s
   cross-repo reference-resolution gates degrade to "skipped" inside the container today.
4. No image-build automation exists yet (a human/agent runs `container build` by hand per this PR's
   Containerfile) — a real gap if this is ever wired into an unattended dispatch path.
5. This work landing on `main` while the fuller `run`-mode implementation lives unmerged on
   `lane/mechanical-dispatcher` is a known, accepted duplication risk (see above) — not resolved by this PR.

## Session update (2026-09-14, later the same day) — heavy-command-pool container POC extended to `test:unit`

Same tracking convention as the session update directly above: a progress note, not a new formal item, per
the operator's own standing direction and this repo's PR-landing precedent (`we:scripts/pr-land.mjs` only
refuses an empty PR description — #2324). First checked whether the prior PR (`#2206`,
`lane/3621-heavy-command-pool-container-poc`) had merged before starting: it had not (`gh pr view 2206` — open,
mergeable), so this slice was built as a lane clone based directly on that PR's own branch, reusing its
`we:scripts/lib/container-exec.mjs`/`Containerfile` infrastructure rather than duplicating it.

**Why `test:unit` next.** `#2206`'s own report named it explicitly: `test:unit`/Playwright aren't
containerized, and unlike `check:standards`'s pure-JS dependency closure, `test:unit` (vitest) needed the
baked-Linux-tree approach because of native/compiled deps. Confirmed before writing any code: scanned
`we:package-lock.json` for every optionalDependency with a `darwin-arm64`/native shape — esbuild, rollup, swc,
lightningcss, sharp, `@parcel/watcher`, `node-gyp-build-optional-packages` all appear, and the host's own
`we:node_modules/@esbuild/` directory holds only `darwin-arm64`, confirming vitest's own transform pipeline
(esbuild, reached via vite) cannot resolve inside a Linux guest mounting that host tree straight in.

**What was built — see `#3621`'s own 2026-09-14 (later) amendment for the full technical writeup; condensed
here:**

- `we:scripts/lib/container-exec/Containerfile.test-unit-deps` (new) — bakes a Linux `node_modules` via `npm
  ci` inside plain `node:22-alpine` (no build toolchain needed — every native dep ships a prebuilt Linux
  binary for this lockfile).
- `we:scripts/lib/container-exec/build-test-unit-deps.mjs` (new) — builds that image, creates/seeds a named
  `container volume` from its `/app/node_modules`, and stamps a lockfile-hash marker so a re-run with an
  unchanged lockfile is a cheap no-op; a `status` mode reports image/volume presence and staleness for a
  preflight.
- `we:scripts/lib/container-exec.mjs` — gained `nodeModulesVolume` support on `buildContainerRunArgs`/
  `execContainerized` (mounts a named volume at `<cwd>/node_modules`, shadowing the checkout's own rw mount for
  that one subtree only — proven empirically that a more-specific mount wins the shadow and that writes to it
  never touch the host) plus `frontieruiSiblingRoot`, which auto-mounts the `frontierui` sibling checkout
  read-only when `nodeModulesVolume` is requested (closing the sibling-mount gap named in `#2206`'s report, for
  `test:unit`'s own import graph specifically — `plateau-app` is a `vite.config.mts`/dev-server-only reference,
  confirmed not part of `test:unit`'s closure, so deliberately not mounted).
- `we:scripts/readiness/heavy-admission.mjs` — the `run` CLI gained a `--container-node-modules` flag (or
  `WE_HEAVY_ADMISSION_CONTAINER_NODE_MODULES=1`), layered on top of the existing `--container` flag, with the
  same fail-loud-with-actionable-message preflight `#2206` already established for a missing image, mirrored
  for a missing/stale node_modules volume.

**Real evidence, measured on this machine:**

- **Fidelity**: the same 35-file/441-test subset (`we:blocks/__tests__`) run on the host and inside the
  container produced IDENTICAL pass counts (35/35 files, 441/441 tests) both times — via the actual wrapper,
  `node we:scripts/readiness/heavy-admission.mjs run --container --container-node-modules -- npx vitest run
  we:blocks/__tests__`. The FULL suite (447 files / 12007 tests, ~9m48s wall-clock on the host, measured this
  session) was not re-run inside the container — a representative subset was used instead, per this task's own
  explicit allowance for a first proof.
- **Cap enforcement, reproduced a third time**: 8 unbounded busy-spin `node -e` processes inside a `--cpus 2
  --memory 2g` container held the host-side `com.apple.Virtualization.VirtualMachine` process at ~191-204% CPU
  (sampled twice during a live 15s run), versus ~800% (8 processes each pinned near 100%) running the identical
  workload unconstrained on the host — same containment result `#2206` measured for `check:standards`, now
  reproduced under this slice's own node_modules-volume + sibling-mount configuration.
- **Failure modes confirmed, not just predicted**: running `test:unit` in-container WITHOUT the node_modules
  volume reproduces the exact `MODULE_NOT_FOUND`-shaped failure `#3621` predicted (here surfacing as an esbuild
  transform error plus an unresolved `@frontierui/plugs/...` import) — confirming the shortcut genuinely does
  not extend from `check:standards` to `test:unit` without this slice's own fix.
- Unit tests added/extended: new cases in `we:scripts/lib/__tests__/container-exec.test.mjs` (the
  `nodeModulesVolume`/`frontieruiSiblingRoot` pure logic, plus REAL self-skipping integration tests proving the
  mount-shadow property against an actual container) and a new
  `we:scripts/lib/container-exec/__tests__/build-test-unit-deps.test.mjs` for the build script's pure helpers.
  `node we:scripts/check-standards.mjs` passes clean (0 errors) against this change.

**What is explicitly NOT done — left for a real follow-up, not overclaimed:**

1. Playwright is still not containerized — a different, likely harder shape again (needs a real browser inside
   the guest, not just a Linux dependency tree), genuinely unstarted.
2. The full `test:unit` suite (447 files / 12007 tests) was not run side-by-side in the container — only a
   representative subset, per this task's stated allowance. A future pass should measure the full-suite
   wall-clock cost inside the container (the mount I/O penalty `#3621`'s own research flagged may matter more
   at that scale).
3. Neither `--container` nor `--container-node-modules` is wired as a DEFAULT anywhere — every existing
   heavy-command call site still runs on the host exactly as before.
4. `check:standards`'s own image is still built by hand; only the `test:unit` deps image has a build/seed
   script. Generalizing image-build automation beyond this one case is unstarted.
5. The same `lane/mechanical-dispatcher` reconciliation risk `#2206`'s report named is unchanged by this
   slice — still an accepted, known risk, not resolved here.

### Design note (2026-09-14) — should heavy git operations share `we:heavy-admission.mjs`'s pool with vitest/check:standards? No current call site warrants wiring it; open forward-looking question only

Follow-up to tonight's runaway `git grep` incident (a one-off pathological command, already killed — see
above). The operator's architectural point, independent of that specific incident: `we:scripts/readiness/heavy-admission.mjs`'s
shared semaphore (cap 2, `run` CLI mode) already gates `check:standards`/`verify-lane`/`test:unit`. If a
genuinely heavy git operation (full-repo `gc`/`repack`/`fsck`, a multi-remote `fetch --all`, a `merge-tree`/
rebase loop across many commits) ever runs un-gated, it stacks CPU load against those same capped operations
uncoordinated, because git currently has no presence in the pool at all.

**Checked every git call site in `we:scripts/` (excluding `__tests__`) for anything at that weight class.**
None found:
- No `git gc`, no `fetch --all`, no full-repo `fsck` anywhere in `we:scripts/`.
- Every `fetch` call site (`we:scripts/lane-drain.mjs`, `we:scripts/lane-resume.mjs`, `we:scripts/lane-pool.mjs`,
  `we:scripts/backlog.mjs`, `we:scripts/merge-ai-prs.mjs`, `we:scripts/pr-land.mjs`,
  `we:scripts/conveyor/branch-sync.mjs`, `we:scripts/conveyor/branch-drift.mjs`,
  `we:scripts/conveyor/validate-and-promote.mjs`, etc.) fetches a single ref/branch with `--quiet`/`--prune` —
  narrow and cheap, not a multi-remote full fetch.
- `git merge-tree --write-tree` appears in `we:scripts/lane-pool.mjs`, `we:scripts/prune-landed-lanes.mjs`,
  `we:scripts/merge-ai-prs.mjs`, `we:scripts/lib/rebase-drop-content.mjs`, `we:scripts/lib/rebase-drop-manifest.mjs`,
  `we:scripts/lib/git-run.mjs`, `we:scripts/conveyor/branch-drift.mjs`, and
  `we:scripts/conveyor/parked-pr-conflict-watch.mjs` (the last one *describes* the plumbing but doesn't call
  it). Every real call site does exactly ONE `merge-tree` between two refs (`base` vs one lane/PR ref) —
  working-tree-free by design, deliberately chosen (per these files' own comments) *because* it's cheap
  compared to a real checkout+merge. `we:scripts/prune-landed-lanes.mjs` and `we:scripts/merge-ai-prs.mjs`
  each call it once per candidate branch/PR in a loop, but that's N cheap single-ref probes, not one big
  multi-commit rebase/merge — not the weight class the operator named.
- `git rebase` appears in `we:scripts/operations/poc-land.mjs` and `we:scripts/operations/ci-heal-dispatch-wrapper.mjs`
  — a normal single-branch rebase onto a fresh tip, not a loop across many commits.
- `we:scripts/conveyor/branch-sync.mjs` (named explicitly in this investigation's brief) fetches one ref and
  probes with `merge-tree` before ever attempting a real merge — same cheap pattern, not heavy.
- `we:scripts/lib/isolation-provider.mjs`'s `repack -a -d -f` (confirmed earlier tonight) runs only against a
  `--depth 1 --no-hardlinks` **shallow** clone built by its own `buildHistorySurgeryCloneArgv` for the
  history-surgery path — and per its own doc comment, **production wiring is still deliberately deferred to
  `#3630`**; today it is exercised only by `we:scripts/lib/__tests__/isolation-provider.test.mjs`. Not a live
  call site at all right now, so doubly not a concern.

**Recommendation:** nothing to wire in today. Every real git call site currently in `we:scripts/` is either
narrow-scope (single ref) or a single working-tree-free probe explicitly designed to be cheap — none reaches
the "full-repo gc/repack/fsck, multi-remote fetch, or a rebase/merge loop across many commits" weight class
the operator described. `git status`/`git diff`-class calls (the overwhelming majority of call sites: dozens
of `rev-parse`, `show`, `ls-tree`, `log`, `status --porcelain`, etc.) should stay ungated regardless — gating
those would slow dispatch-critical paths for no CPU-contention benefit. This stays a genuinely open,
forward-looking design question rather than a build: **if/when** a real heavy git operation lands in
`we:scripts/` (a full `gc`, a `fetch --all`, a many-commit rebase/merge loop), it should be wrapped through
`node we:scripts/readiness/heavy-admission.mjs run -- <command>` — the same one-line opt-in pattern the `run`
CLI mode already offers on `we:heavy-admission.mjs` — rather than inventing a second limiter. No new item
filed for this; there is nothing to schedule yet, only a rule to apply the next time such a call site is
actually written.

**A separate, harder limit, worth stating plainly rather than leaving implicit: `we:heavy-admission.mjs`
cannot catch an ad hoc/interactive git command no matter how many scripted call sites get wired into it.**
The module is a purely COOPERATIVE, opt-in semaphore — a caller must itself invoke `we:heavy-admission.mjs
run -- <command>` (or `acquire`/`release`) to participate; there is no OS-level enforcement and nothing
forces an arbitrary command through it. `we:heavy-admission.mjs`'s own header says this outright about
`we:guard-bash.mjs`'s adjacent PreToolUse deny: it "only reaches a MECHANICALLY-DISPATCHED agent (one with
`WE_DISPATCH_KIND` set)" — a `/workflow`/`/batch` parallel lane, or the operator's own interactive session,
carries no such env var and is unaffected. The identical limit applies here: tonight's runaway `git grep`
across 12k+ revisions was typed directly by an agent outside any script, so wiring every scripted git call
site into the pool — even a maximally thorough one — would still not have caught it, and would not catch the
next one either. "Add git to the shared queue" can only ever cap *scripted* call sites that opt in; it is
not, and cannot become without a different mechanism (e.g. a PreToolUse-style interception of raw `git`
invocations), a general governor over every heavy git command any agent might type.

## Session update (2026-09-14, later still) — three forward-looking capacity requirements recorded on `#3621`; live-tested whether `test:unit`'s worker pool respects a container's `--cpus` allocation

Tracked here as a progress note, same convention as the two container-POC entries directly above — see
`we:backlog/3621-real-os-level-resource-isolation-per-dispatched-lane-is-appl.md`'s own 2026-09-14 (later
still) amendment for the full technical writeup; condensed here.

**Why now.** The operator gave real forward-looking direction on the next phase of this work — reserved
capacity for heavy-command containers separate from lane capacity, per-command internal-parallelism
correctness inside whatever container allocation a command actually gets, and a resource-aware (not flat)
admission cap — and asked for it to be recorded precisely, not designed or built yet, plus one concrete,
checkable-now piece tested for real.

**Three requirements recorded on `#3621`, not designed here:**
1. A heavy-command container needs its own reserved CPU/memory budget, kept separate from
   `we:scripts/lib/lane-concurrency.mjs`'s lane cap — two pools, not one shared budget. Neither `#2206` nor
   `#2211` built this; both ran a single container ad hoc.
2. A heavy command (`vitest`/`test:unit`, `we:scripts/verify-lane.mjs`) must size its own internal
   worker/thread pool to fit the container it actually runs in, not assume the host's full core count. Tested
   live tonight (below) rather than assumed.
3. `we:scripts/readiness/heavy-admission.mjs`'s cap (currently a flat `DEFAULT_ADMISSION_CAP = 2`, its own
   header calling it "an EQUAL-COST NAMED SET") should become resource-aware per command — `vitest` plausibly
   costing more than `check:standards`. Cited as concrete, dated evidence, not hypothetical: a real live bug
   found and separately being fixed this same session — the cap's slot reentrancy keys ownership by lane PATH
   STRING, not process identity, so two genuinely different processes verifying the same lane back-to-back
   (the conveyor's auto-verify plus a manual re-verify) both read as "one slot," meaning real concurrent load
   was 3 processes while the gate reported a healthy 2/2.

**The one immediately-checkable piece — tested for real, using `#2211`'s already-built container
infrastructure (a fresh lane, `lane-20`, acquired specifically for this test).** `container run --cpus 2` gives
a guest where `os.cpus().length` reports **3** (a confirmed off-by-one, N+1, consistent across `--cpus 1`→2 and
`--cpus 4`→5) but `os.availableParallelism()` correctly reports **2**. THIS repo's own `test:unit` config
(`we:vitest.shared.ts#maxTestWorkers`) does not call either API — it is a **hardcoded literal `4`**, already
tuned (by an existing, unrelated `#3650` fix) for the HOST's core budget under a 3-concurrent-invocation
burst assumption, with zero awareness of whatever container it might run inside. Ran the real 35-file/441-test
`we:blocks/__tests__` subset inside an actual `--cpus 2 --memory 2g` container via `node
we:scripts/readiness/heavy-admission.mjs run --container --container-node-modules -- npx vitest run …` — passed
35/35 files, 441/441 tests, proving the pipeline works — but confirms `test:unit` would request up to 4 worker
threads against a container that only has 2 real cores, a genuine 2x oversubscription of that container's own
allocation. Diagnosed, not fixed, per the operator's own instruction — recorded as a confirmed instance of
requirement 2 above, left as real follow-up scope once requirement 1's capacity reservation is designed.

## Session update (2026-09-14, continued) — `#3673` (what clears a triggered calibration veto) ratified, all four forks

`#3673` — "Define what clears a triggered calibration veto so a role can graduate," filed and prepared
earlier this session (`PR #2228`, `preparedDate: "2026-09-14"`) — was ratified by the operator (Nicolas
Gilbert) in one pass, all four forks approved as prepared, no amendments. Now **resolved**, `codifiedIn:
we:docs/agent/platform-decisions.md#calibration-veto-clearing` — the same "full ruling earns statute"
posture `#3654` took, since this card's ruling *is* the shape of veto clearing, not a narrow rider under
an existing anchor.

Ratified, as recommended: **(1)** a documented root-cause finding, naming which
`we:scripts/lib/jury-core.mjs#deriveFindingDisposition` sub-answer diverged and why, is a mandatory
precondition before any post-miss trial counts toward clearing — trial volume alone never suffices; **(2)**
once eligible, a fixed minimum trial count plus at least one trial specifically targeting a case similar in
kind to the trigger (severity-ambiguous, a deliberately constructed test scenario permitted when a real one
is scarce) — N dissimilar clean trials never suffice; **(3)** decay alone (elapsed trials or elapsed time,
with no clean/relevant requirement) never clears the veto by itself — a cooling-off window may narrow which
trials count, never substitute for the affirmative evidence clauses 1–2 require; **(4)** a human override is
available only as a documented, reasoned factual reclassification of the trigger event, narrowly scoped to
identity/evidentiary errors — never a re-answer of the severity judgment itself, and never a blanket
trust/confidence grant.

**No concrete numeric N is fixed by this ruling**, consistent with `#3654`/`#3649`'s own deferred-N
precedent — a specific N is deferred to a follow-on ordinary (batched) finding once real post-clearing trial
data exists, never a separate ceremony. No `calibrationMiss` field is added to `we:model-probation.json` and
no clearing-check function is wired here — this card rules on the shape of clearing only. The live PR #2107
veto on Codex's `advisory-review` role is **not** cleared by this ruling itself: clearing it still needs
either clause 1's root-cause finding followed by clause 2's similarity-matched trials, or clause 4's narrow
reclassification override on its own facts.

## Session update (2026-09-14) — PR #2206's own independent jury review OWED 6 findings, filed; and its care-level shortfall confirms an existing open gap, not a new one

`PR #2206` (`readiness: heavy-command-pool container POC`, the `#3621`-sequenced slice recorded above) passed
independent jury review with `review:accepted` / `ready-to-merge` and has since merged to `main`
(2026-09-14). Its verdict
(`we:.operations/review/review-pr-744615b3-.../chalbert-web-everything-2206-verdict.md`) marked 6 non-blocking
findings `OWED — file it`, all `_[CONFIRMED]_`:

- **Filed as `we:backlog/3714-...md`** (now size 1) — three correctness findings in
  `we:scripts/lib/container-exec.mjs` were reported; re-checked against current `main`, only ONE is still
  live. `execContainerized` still spreads the whole caller `opts` bag (including `opts.env`) into the real
  `execFileSync` call for the container-launching host process, contradicting its own comment that `env` is
  not passed into the container. The other two are already fixed on `main` by `ad471675e`, with regression
  tests: the relative `opts.cwd` now resolves to an absolute path before the `--volume` mount argv is built,
  and `containerImageAvailable` now matches the NAME and TAG columns of the image listing exactly instead of
  prefix/substring matching (that last one was caught by two jurors at the same call site, one bug not two).
- **Filed as `we:backlog/3715-...md`** (size 2) — `we:scripts/lib/container-exec/Containerfile` pulls its
  base image by mutable tag (`node:22-alpine`), no `@sha256` digest pin, so a later rebuild can silently get a
  different image than the one this POC's own fidelity evidence was measured against.
- **Filed as `we:backlog/3713-...md`** (size 2) — `we:scripts/readiness/heavy-admission.mjs`'s
  `--container` fail-fast guard (~line 425) has no test coverage at all; breaking it would redden nothing.

All three parented under `#3621` (this PR's own decision item), following this session's own two-small-bugs
precedent (`719cb5e43`, filed separately rather than bundled) but grouped by theme per the operator's own
suggested split (correctness bugs together, supply-chain hygiene separate, test-coverage separate) since,
unlike that precedent, findings 1/3/4/5 here share one file and one root cause class.

**The 7th thing the review surfaced was NOT filed as a new item — checked first, and it is already tracked.**
The verdict recorded PR #2206's care-level scoring as `elevated` (blast-radius + size), for which the dial
asks 5 lenses; the verdict reported that `standards-conformance` + `claim-accuracy` — both real
`PANEL_LENSES` members — did not sit, "because the step list is fixed at registration", not anything this run
controlled. (The verdict file was not re-read for this entry; do not rely on it for that run's exact seat
roster.) Before filing this as a new gap, searched `we:backlog/` for
prior coverage: `#3393` (open, filed 2026-08-29, *"review-pr cannot seat the claim-accuracy lens, because its
step list is fixed at registration"*) already names this exact structural class, with its own `#3319`
citation for why. Its opening claim ("exactly two `judge` steps declared") was re-checked against current
`main` and is still accurate (`JUDGE_SEATS` lists `judge` and `judgeSecurity` only), so `#3393` is amended in
place with PR #2206 as a fresh confirming instance, with no seat-count change, rather than duplicated.
**Worth restating plainly for anyone scanning this tracker: this means any `high`- or
`elevated`-care PR can still get fewer lenses than its own dial says it earned, silently, because the record
only states what ran, not what the touch-set was owed.** `#3393` remains open and unresolved; this entry adds
evidence, not a fix.
