---
bornAs: xev8pnf
kind: decision
parent: "4075"
status: resolved
dateOpened: "2026-09-24"
dateStarted: "2026-09-24"
dateResolved: "2026-09-24"
codifiedIn: "docs/agent/platform-decisions.md#automated-health-daemon"
preparedDate: "2026-09-24"
preparedAgainstSha: "aad340b97cfbab097a92ff8fd875422ded4b76e3"
relatedReport: reports/2026-09-24-health-daemon-design.md
relatedTo: ["4045", "4051", "4052", "3639", "3615", "4010"]
tags: [conveyor, daemons, health-daemon, monitoring, alerting, incident-2026-09-24, decision-prep]
---

# Automated health daemon — resident smell probes, auto-dispatched investigations, operator recommendations without a chat session

**TOP PRIORITY of epic 4075.** Operator, 2026-09-24 ~6:25 PM ET, verbatim: "In general we should
prioritize the automated health daemon that listen to multiple smell and auto dispatch investigations if
needed and can tell me what it think we should do without needing a session".

On 2026-09-24 every conveyor problem was found by a person in a chat session: daemons alive but dispatching
nothing, bots getting 401 "Bad credentials" while the live smoke gate passed, lanes running out, the pool
past 100 clones, high load, stood-down and stuck PRs piling up. Each had a cheap mechanical signal; nothing
turned the signals into "here is what is wrong and what to change". This card rules the design of the daemon
that does. Grounding: `we:reports/2026-09-24-health-daemon-design.md` and
[/research/automated-health-daemon-smells/](/research/automated-health-daemon-smells/) (prior art: SRE
symptom-based alerting, Prometheus `for:` durations, Alertmanager grouping/inhibition/silences with expiry,
the Watchdog/dead-man's-switch pattern, diagnose-then-human-approved remediation).

**Prep history.** First authored 2026-09-24 with six forks. One adversarial Opus skeptic round and one
fresh-context screen then ran. Result: Fork 5's default was refuted and flipped (the daemon never clears its
own cards); Fork 4 was refuted as written and amended (the notifier it reused runs inside the dispatcher it
watches); Fork 6 dissolved into "Supported by default" (already ruled by clause 6 of
`#resident-daemon-reload-lifecycle`); Forks 1–3 survived with amendments. Each fork's `Skeptic:` and
`Screen:` lines record what changed.

**Ratification review (2026-09-24, decision session).** Currency: `check:item` clean; no
`we:docs/agent/platform-decisions.md` change since `preparedAgainstSha`; health flags only low prose-edges to #4045/#4052
(stories that block slices 4077/4081, not this ruling); no G8. Cited statute clauses re-read verbatim and
they hold. Independent skeptic (`judgePanel`, run `ratify-4065`, ok) raised three points, none refuting a
default: (1) cite clauses verbatim — re-checked, they hold; (2) Fork 4 widens the notify contract — already
explicit below, so it is the operator's call at ratification; (3) Fork 5 defers filing during lane
starvation — accepted: the report and notification still fire, and the request waits in the ledger.
Fork 1 was then amended by the operator: the health clone is dedicated and may run overlays of its own
code only (not `main`-only) — see Fork 1's operator-amendment line.

## Ruling (2026-09-24)

**Ratified** by the operator (*"I ratify"*): all five forks at their defaults — Fork 1 as amended by the
operator (dedicated clone running overlays of its own code only), Fork 4 with the notification widening
explicitly accepted. Codified as
[#automated-health-daemon](/docs/agent/platform-decisions/#automated-health-daemon). Build slices 4077, 4078,
4068, 4066, 4079, 4081 are now unblocked by this card.

## Axes

- **Isolation** — where the watch runs, relative to what it watches (Fork 1).
- **Response** — per smell: alert, deterministic diagnosis, or agent investigation (Fork 2).
- **Dedup** — what one "event" is (Fork 3).
- **Channel** — where the recommendation lands without a session (Fork 4).
- **Authority** — whether it may turn a finding into a card (Fork 5).

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Where does it run? | **Its own resident process in its own failure domain: not inside any daemon it watches, from its own dedicated clone (`main` plus overlays of its own code only, never shared), with a hard per-tick timeout and a last-tick-completed stamp** | Folded into an existing daemon | High |
| 2 — Which smells get an agent? | **Deterministic diagnosis first; an agent only for a symptom with several plausible causes, whose evidence must be read, no other watch already dispatches for, and no inhibiting episode is open** | Dispatch on every smell no other watch covers | High |
| 3 — What is one event? | **An episode per (smell, subject) with open/close hysteresis, a flap cap, a high-severity reminder, and tracked-silences that expire** | A cooldown keyed per (smell, subject) | High |
| 4 — Where does the recommendation go? | **A scrubbed durable episode report + a HEALTH section in the operator queue + an OS notification for high severity, delivered by the health process itself** | A GitHub issue per episode | High |
| 5 — May it turn findings into cards? | **Yes, as a filing request landed UNCLEARED through a lane-bound declared operation; the daemon never clears readiness, and never auto-clears a card scoped to daemon code** | Recommend only; a person files | Med-high |

## Fork 1 — Where does the health watch run, relative to what it watches?

Fork-existence: (b) is broken, not just worse — a watcher running inside a daemon it watches stalls and dies
with that daemon, which is exactly 2026-09-24's failure mode ("alive but dispatching nothing"). (c) is broken
on the day's own evidence: a clone shared with other daemons' live overlays shares their failure domain (one
bad overlay or a conflicted self-sync, both seen 2026-09-24, takes the watcher down with the watched).

- **(a) Its own resident process, in its own failure domain.** One per host, singleton lease, under the
  ruled reload lifecycle. It runs from its **own dedicated clone, shared with no other daemon**, tracking
  `main` plus **overlays of its own code only** — so, per clause 5 of
  [#resident-daemon-reload-lifecycle](/docs/agent/platform-decisions/#resident-daemon-reload-lifecycle),
  a fix to the health watch can run live before it merges, while no other daemon's overlay can take it down.
  A bad health overlay only breaks the health process, and the outside check of clause 6 (plus clause 5(d)'s
  outside rollback) catches that. It is NOT a clause 5(e) carve-out: it does not merge to `main`. Every tick has a **hard wall-clock timeout on its child calls** (clause 6)
  and writes a **last-tick-completed stamp** from inside the tick, separate from the lease heartbeat —
  because the generic pass runner's heartbeat runs on an independent timer
  (`we:skills-src/conveyor/pass-daemon.mjs:194`) and keeps moving while a tick hangs
  (`spawnPassOnce`, line 159, has no child timeout).
- (b) Folded into the dispatcher runner or the review daemon. Excluded (above).
- (c) Its own process, but from a clone shared with other daemons' overlays. Excluded (above).

Build note for slice 4077 (not ruled here): a `health-watch` entry in `DAEMON_MANIFEST`
(`we:skills-src/conveyor/daemon-manifest.mjs:126`, shape `{script, args, intervalMs}`) run by the pass-daemon
is the expected vehicle; self-sync is opt-in on that runner, so the plist sets it explicitly.

Default: **(a)**.

Skeptic: SURVIVES-WITH-AMENDMENT (real Opus skeptic). The first draft said the pass-daemon "inherits the
heartbeat" — the skeptic showed that heartbeat is blind to a hung tick and that self-sync is opt-in
(`we:skills-src/conveyor/pass-daemon.mjs:72-90`), and that running from the shared overlay clone re-created
the very shared failure domain the draft's Fork 6 excluded. Folded in: the `main`-only clone, the per-tick
timeout, the last-tick-completed stamp; option (c) added and excluded.

Screen: flagged(impl+prio) → fixed (real fresh-context agent). The draft ruled "manifest entry vs bespoke
daemon", which no consumer can observe and which differed only in build cost. Re-ruled as the observable
policy (its own failure domain); the vehicle moved to a build note on slice 4077.

Operator amendment (2026-09-24, decision session, "amend 1 as suggested"): the prepared default was a
`main`-only clone with no overlays. That over-reached — the failure-domain argument only excludes a clone
*shared* with other daemons' overlays, and the operator's clause 5(e) choice was that every daemon may run
overlays unless it merges to `main`. Amended to a dedicated clone running overlays of its own code only.

## Fork 2 — Which smells get an agent, and which only alert?

Fork-existence: (c) "nothing dispatches" contradicts the operator's explicit ask. The strongest rival, (b)
"dispatch on every smell no other watch already covers", is excluded on merit, not cost: many smells are
self-explaining (load 12 against the host core count), so an agent report adds noise and no diagnosis; and some smells break
the investigator's own tools (a failing GitHub App token breaks the gh shim the investigator would use).

- **(a) Deterministic first, agent last.** Every smell may carry a **deterministic diagnosis** (a declared
  read operation) that runs before anything else — for "daemon owed work, 0 dispatches" that is the existing
  `we:scripts/operations/dispatch-eligibility.mjs`. An agent is dispatched only when all four hold: the
  symptom has **more than one plausible cause** the deterministic diagnosis did not settle; the evidence
  lives in **transcripts, logs or histories an agent must read**; **no other watch already dispatches for
  that subject** (per-PR stalls belong to the stuck-PR watch, `we:scripts/conveyor/stuck-pr-watch-core.mjs:261`;
  conflicts to the parked-PR conflict watch); and **no inhibiting episode is open** (App token / rate limit,
  host load high). Otherwise alert.
- (b) Dispatch on every smell no other watch covers. Excluded (above).
- (c) Nothing dispatches. Excluded (above).

Applied to the 15 seed smells (table in the report): agent-eligible — daemon owed work with 0 dispatches
(after `dispatch-eligibility`), lane starvation, self-sync conflict, smoke-gate failure, stale live-process
bindings, drain pass over budget / merge-rate drop; deterministic diagnosis + alert — repeated 401s and App
token / rate limit (read `we:scripts/conveyor/github-app-status.mjs`; an investigator would hit the same
401s); alert only — a systemic cluster of ≥ 3 PRs stuck in one stage (its recommendation aggregates the
stuck-PR inspections already posted, so no third agent reads one incident), clone behind main, open PRs over
the limit, stood-down PRs, lane pool growth, machine load, the watch's own overrun.

The investigator's tool surface is **declared read operations only** (`runner-activity`, `stale-state`,
`dispatch-eligibility`, `github-app-status`, bounded transcript reads) with Edit, Write and every `gh` write
(including `gh pr comment`) denied — it reads untrusted transcript text, and a raw shell under injected text
is an exfiltration and forgery path (it could post fake stuck-dispatch markers). It is launched as a new kind
on the declared `dispatch-lane` operation, not by importing the spawner.

Default: **(a)**, with the per-smell `action` and `diagnose` fields as data, not code.

Skeptic: SURVIVES-WITH-AMENDMENT (real Opus skeptic). Found the draft's table broke its own rule (the
systemic stuck-PR row dispatched over PRs the stuck-PR watch already inspects), that the 401 and App-token
smells would launch an investigator through the failing shim, that `dispatch-eligibility` already explains
smell 1 deterministically, and that the stuck-PR inspector's Bash deny-list leaves Edit, Write and
`gh pr comment` open. Statute-overlap: launching via `dispatch-lane-io` directly collides with
[#conveyor-dispatch-calls-the-declared-operation](/docs/agent/platform-decisions/#conveyor-dispatch-calls-the-declared-operation)
clause 1 → reconciled (a new kind on the declared operation). Citation-scope:
[#reviewer-tool-surface-and-containment](/docs/agent/platform-decisions/#reviewer-tool-surface-and-containment)
governs reviewer seats, not investigators — cited as supporting context for the declared-reads surface, not
as authority. All folded in.

Screen: clear (real fresh-context agent) — which smells spend an agent is observable (cost, noise, duplicate
inspectors) and keeps a merit difference with cost removed. Amended per the screen: the rival is named as
the stronger "every smell no other watch covers", excluded on noise, not cost.

## Fork 3 — What counts as one event (dedup)?

Fork-existence: the strongest rival (b), a cooldown keyed per (smell, subject), fixes the subject problem
but is still broken on a persistent problem — it re-fires unchanged every time the cooldown expires — and it
has no "closed" or "tracked" state, so it cannot tell "fixed" from "still broken but known".

- **(a) Episodes.** Key = `(smell id, subject)` (the daemon, repo, host or PR stage). Open after `openAfter`
  consecutive breaching samples, close after `closeAfter` consecutive clean samples. One agent and one
  notification per episode. Plus the three controls the skeptic showed were missing:
  - **Flap cap** — a (smell, subject) that re-opens more than 3 times in 24 h becomes one `flapping` episode
    instead of a new episode each time.
  - **High-severity reminder** — an open, unacknowledged high-severity episode re-notifies once after 4 h.
  - **Tracked silences expire** — an episode linked to an open card or PR goes quiet, but the silence lapses
    after 72 h unless that card is `active` (being worked). Alertmanager silences always expire; a card that
    sits uncleared for weeks must not mute a live high-severity problem.
- (b) A cooldown keyed per (smell, subject). Excluded (above).

The episode store lives under the pinned daemon state root, so slice 4077 is blocked by #4052.
Illustrative record (a build detail, not ruled):

```json
{ "id": "lane-starvation:host:mbp-1:20260924T1805Z", "smell": "lane-starvation", "subject": "host:mbp-1",
  "state": "open", "severity": "high", "breaches": 2, "clean": 0, "reopens24h": 0,
  "diagnosis": { "op": "stale-state", "summary": "4 leases held by finished sessions" },
  "investigation": null, "trackedBy": null, "silenceExpiresAt": null }
```

Default: **(a)**.

Skeptic: SURVIVES-WITH-AMENDMENT (real Opus skeptic). Classification: the draft's cooldown was a strawman;
the per-(smell, subject) cooldown is the honest rival and still loses. The draft's "same model as the
stuck-PR watch's marker (`we:scripts/conveyor/stuck-pr-dispatch-marker.mjs:157`)" was a citation error —
that keys on a PR's `activityAt` in a PR comment, with no hysteresis — now cited only as "same
one-agent-per-episode idea". Folded in: flap cap, reminder, expiring silences, the #4052 dependency.

Screen: clear (real fresh-context agent) — episode vs cooldown changes what the operator sees (re-fires,
missed alerts) and keeps a merit difference with cost removed; the numbers stay config.

## Fork 4 — Where does the recommendation land, with no chat session?

Fork-existence: (b) is excluded by standing rule — the backlog is the tracker (memory rule 106,
`we:docs/agent/backlog-workflow.md`); a GitHub issue per episode starts a second, parallel tracker the
conveyor never reads. (c) is broken for most smells: a daemon, a host or a lane pool has no PR to comment on.

- **(a) Three layers, one source, delivered by the health process itself.** (1) A durable per-episode
  report: what is wrong, the measurements, the deterministic diagnosis, the investigation's evidence with
  cited command output, the product change that fixes it (existing card or filing request), and one line
  "what you should do". Model-authored text passes the privacy scrub required by clause 3 of
  [#automated-session-introspection](/docs/agent/platform-decisions/#automated-session-introspection)
  before it is written or rendered, because the investigator read raw transcripts. (2) A HEALTH section in
  the operator queue (`we:scripts/operations/operator-queue.mjs`), one row per open episode, and the health
  process's last-tick-completed age as the queue's first line. (3) An OS notification when a high-severity
  episode opens, **sent by the health process itself** under its own once-per-episode state — not through
  the `operator-notify` pass, which the dispatcher runs (`we:skills-src/conveyor/runner.mjs:335`) and so
  cannot announce the dispatcher's own stall.
- (b) A GitHub issue per episode. Excluded (above).
- (c) A PR comment or Discussion post. Excluded (above).

**Ratifying this fork widens the notification contract.** Today only "NEEDS YOU" PRs notify (the operator's
"I only review human tag" rule, `we:scripts/operations/operator-notify.mjs` header). (a) adds exactly one
more class: a *high-severity* health episode opening (and its one 4-hour reminder). Nothing else notifies.
Operator approval (2026-09-24, decision session): "ok to add new kind for fork 4" — the widening is accepted
as its own explicit call, answering the ratify-4065 skeptic's scope-bundling point.

Supported by default (not a fork): the plateau /wip panel and the live status page (4067) render the same
episode reports; they read (a), they do not compete with it. On a host with no desktop (a future VM), layer 3
is simply absent; layers 1–2 carry the message.

Default: **(a)**.

Skeptic: REFUTED as written → amended (real Opus skeptic). The draft reused `operator-notify`, but the
dispatcher runs that pass, so "dispatcher stalled" would be announced by the dispatcher; and that pass's
contract is "only NEEDS YOU notifies". Also found the report text unscrubbed. Folded in: self-delivered
notification, the explicit contract widening, the scrub (statute-overlap with
`#automated-session-introspection` clause 3 reconciled by applying it).

Screen: flagged(impl) → fixed (real fresh-context agent). The draft bound paths and function names (the
episode directory layout, a row-builder "like `stuckInspectedRow`") into the ruling; moved to slice 4077.
The "no App issue-write permission today" reason was a cost reason, dropped.

## Fork 5 — May the daemon turn a finding into a card, and who clears it?

Fork-existence: (b) "recommend only" is excluded by the operator's ask ("it can file a card rather than just
talk") and by the standing rule that failures improve the product, never manual intervention
(`we:agent-memory-src/failure-is-a-product-improvement.md`) — a recommendation a person must re-type as a card
is a manual step. (c) "file and clear" is excluded by statute: a dispatcher/scheduler consumes readiness and
never produces it
([#state-lives-where-its-nature-dictates](/docs/agent/platform-decisions/#state-lives-where-its-nature-dictates)
clause 3), and a card clearing itself onto the conveyor that then changes daemon code is the self-approval
loop [#drain-daemon-self-hosting-boundary](/docs/agent/platform-decisions/#drain-daemon-self-hosting-boundary)
clause 3 forbids.

- **(a) A filing request, landed uncleared.** The daemon writes a *filing request* (title, digest, scope,
  size, the episode id) into the episode report and a request ledger in its state root. A lane-bound
  declared operation lands it the normal way — lease a lane, `file-item --queue=false`, verify, open a PR —
  so the daemon's own clone is never dirtied (clause 4 of `#resident-daemon-reload-lifecycle` refuses to
  rebuild a dirty clone, which would freeze self-update fleet-wide). The card arrives **uncleared**; it is
  cleared through the normal readiness path (the operator, or the existing clear-operator path). A card
  whose scope touches daemon code is never auto-cleared by any path; it waits for the ruling on how daemon
  fixes are built (4060). No filing while a lane-starvation episode is open (requests wait in the
  ledger). Dedup: the ledger maps (smell, subject) → the request and the card it became; at most 3 requests
  a day.
- (b) Recommend only. Excluded (above).
- (c) File and clear at birth. Excluded (above).

```bash
# the default option above: what the lane-bound operation runs, inside its own leased lane — never in the daemon clone
node scripts/operations/run.mjs file-item --kind=story --size=2 --parent=4075 --queue=false \
  --title="Lane litter allowlist misses .fix-* scratch" --scope="we:scripts/lib/lane-litter.mjs" \
  --digest="Filed from health episode lane-pool-dirty:repo:we:20260924T1805Z (health daemon filing request)."
```

Default: **(a)**.

Skeptic: REFUTED → default flipped (real Opus skeptic). The draft filed from the daemon and cleared static
known-fix cards at birth. The skeptic showed: `file-item` only writes the card into the working tree
(`we:scripts/operations/file-item.mjs`), so filing from the daemon clone dirties it and freezes the fleet's
self-update; clearing at birth produces readiness from a scheduler (statute collision above); the draft's own
example scoped `we:scripts/lib/lane-litter.mjs`, which a resident watch imports — a self-modification loop;
and `file-item` has no tags input, so "dedup by `healthSmell:` tag" had no mechanism. Also a classification
finding: cleared vs uncleared was a per-smell knob, not a fork — now settled by statute instead. All folded
in.

Screen: clear (real fresh-context agent) — whether model-written findings enter the conveyor without a
person is a real authority question with a merit difference at zero cost; cap and parent are config.

## Supported by default (config dimensions, precedents and compositions — not forks)

- **Watching the watcher** (was draft Fork 6; dissolved — already ruled). Clause 6 of
  [#resident-daemon-reload-lifecycle](/docs/agent/platform-decisions/#resident-daemon-reload-lifecycle)
  already requires an outside check that alerts when a daemon's heartbeat stops; #4045 builds it for every
  daemon. The health process is one more daemon under it. The one addition this design needs, and asks #4045
  to adopt: the outside check reads the **last-tick-completed stamp**, not only the lease heartbeat, since
  the heartbeat keeps moving through a hung tick. Slice 4081 is therefore blocked by #4045 and only adds
  that stamp check and the operator-queue header.
- **Probation (shadow first).** By the precedent of clause 9 of
  [#planner-build-plan-and-execute](/docs/agent/platform-decisions/#planner-build-plan-and-execute) ("starts
  at `shadow`; `on` is a ratified settings change … exit from probation is the operator's act"), the health
  process starts in `shadow`: smells, episodes, deterministic diagnoses and reports run; agent dispatch,
  notifications and filing requests are off. Turning each on is the operator's settings change, with the
  shadow run's per-smell episode counts in the report as the evidence. Composes with #4010 (one probation
  system) when that rules.
- **Recurrence stops the spend** — after 3 agent investigations on the same (smell, subject) within 7 days,
  no fourth is dispatched; the episode is marked "recurring — needs a product fix" in the HEALTH section.
  This is a count, not a model judging whether the diagnoses "agreed".
- **Noise marking** — the operator marks an episode "not a problem" from the operator queue or the /wip
  panel (a CLI verb; build detail); the per-smell count of such marks is shown next to the smell.
- **Investigation budget** — the model comes from the dispatch routing for the investigator role, never
  hand-set (memory rule 148; Sonnet expected). One agent per episode; 1 at a time (separate from the stuck-PR
  watch's cap of 2, and inhibited while host load is high); 6 per rolling 24 h; a 20-minute wall clock the
  health process enforces by stopping the session through the session reaper. Over budget → the episode is
  marked `budget-exhausted` and stays alert-only.
- **Cadence** — a 5-minute tick; local probes every tick; GitHub probes every 15 min sharing one `gh pr list`
  per repo; transcript scans every 10 min over a bounded tail. Tick budget 60 s and ≤ 20 `gh` calls; an
  overrun is itself a smell.
- **Single host now, multi-host ready** — one health process per host; each smell declares
  `scope: host | repo`; repo smells iterate the constellation repos like the other cross-repo passes. Host
  smells run on every host; repo smells run where the leader lease that #3639 / #3615 / #4010 rule puts them.
  This card does not pre-empt that ruling.
- **Findings parent** — config, default 4075.
- **Seed smells and thresholds** — the 15-row table in the report; every threshold is config.

## Proposed codified text (drafted; ratify verbatim or amend)

A new anchor `#automated-health-daemon` in `we:docs/agent/platform-decisions.md`:

> 1. A resident health process watches the conveyor from its own failure domain: never inside a daemon it
>    watches, from its own dedicated clone that runs overlays of its own code only, with a per-tick
>    timeout and a last-tick-completed stamp that the outside check of `#resident-daemon-reload-lifecycle`
>    clause 6 reads.
> 2. A smell is a cheap mechanical probe with a threshold. Deterministic diagnosis runs first; an agent is
>    dispatched only for a multi-cause symptom whose evidence must be read, that no other watch dispatches
>    for, while no inhibiting episode is open. The agent is diagnose-only, holds declared read operations
>    only, and is launched through the declared `dispatch-lane` operation.
> 3. One event is an episode per (smell, subject) with hysteresis, a flap cap, a high-severity reminder and
>    expiring silences.
> 4. The recommendation lands in a scrubbed per-episode report and the operator queue's HEALTH section; the
>    health process itself sends an OS notification for a high-severity episode, the only class besides
>    NEEDS YOU that notifies.
> 5. A finding becomes a card only as an uncleared filing request landed through a leased lane; the health
>    process never clears readiness and never edits code.
> 6. It ships in `shadow`; turning dispatch, notification or filing on is the operator's settings change.

## Build slices (carved; each blocked by this card, filed uncleared until ratification)

1. 4077 — the health process, smell framework, seed smells 1–3 and 15, deterministic diagnoses, episode
   store, report + HEALTH section, shadow mode. Scope: `we:scripts/conveyor/health-watch-core.mjs`,
   `we:scripts/conveyor/health-watch.mjs`, `we:scripts/conveyor/health-smells/`,
   `we:skills-src/conveyor/daemon-manifest.mjs`, `we:scripts/operations/operator-queue.mjs`. Also blocked by
   #4052.
2. 4078 — agent investigation per episode (new `dispatch-lane` kind, declared-reads tool surface, scrub).
3. 4068 — daemon-code smells (4–7).
4. 4066 — queue and host smells (8–14).
5. 4079 — filing requests landed uncleared through a lane-bound operation (Fork 5).
6. 4081 — last-tick-completed check in #4045's outside watcher + operator-queue header. Blocked by #4045.

Composing: 4067 (live status page), 4080 (stall alerts — the notification for smell 1).

### Review jury (provisional — pre-registered #2638)

Care level: `elevated`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |

## Done when

1. **Executable** — each fork carries a ruling, `codifiedIn:` is set to the new anchor, and on ratification
   the six slice cards are cleared to the conveyor (`we:scripts/conveyor/queue.mjs add 4077 …`).
