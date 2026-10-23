---
bornAs: xglhy4b
kind: decision
status: open
dateOpened: "2026-10-20"
tags: [architecture, delivery-system, statute, admission, memory, fail-closed, settings, overlays, operator-authority, decision-prep]
---

# Decision: standing architecture rules for the delivery system (shared data, admission, process ownership, fail-closed, settings, clocks, overlays, operator authority)

Proposes ten standing delivery-system rules from the 2026-10-19/20 incidents, each ratified rule-by-rule into the statute layer (we:docs/agent/platform-decisions.md).

Operator, 2026-10-20, verbatim: *"Ok"* (to drafting a decision card of standing architecture rules, ratified one rule at a time).

## How to rule on this card

Each rule below is its own fork, ruled on its own. Every rule offers the same three shapes:

- **(a) Adopt as stated** — the bold default unless the rule says otherwise.
- **(b) Adopt amended** — the narrower or wider variant named under the rule.
- **(c) Do not adopt** — the rule stays case law, and incidents keep being fixed one by one.

A ruled rule is written into `we:docs/agent/platform-decisions.md` under its proposed anchor. A rule that
**already exists** there is not duplicated: the ruling becomes an amendment clause on the existing anchor, named
under the rule. When every rule is ruled, the card resolves with `codifiedIn` set to the first new anchor and the
others listed in its Ruling section. Build work each rule implies is filed as child cards after the ruling, never
inside this card (no code here).

Evidence below comes from the 2026-10-19/20 orchestration log (operator-local handoff, not committed), PRs and
cards. Times are ET unless marked Z.

## Existing statute checked first

| Rule | Already in statute? | What this card does |
| --- | --- | --- |
| 1 Shared data loaded once | No | New anchor `#shared-data-served-once` |
| 2 Heavy work is admitted | **Partly** — [#heavy-command-admission-queue](../docs/agent/platform-decisions.md#heavy-command-admission-queue) (CPU, named list) | Amendment: memory-aware slots, review/red-team seats join the set, no fail-open on queue timeout |
| 3 Every child has an owner + max lifetime | **Partly** — [#resident-daemon-reload-lifecycle](../docs/agent/platform-decisions.md#resident-daemon-reload-lifecycle) clause 6 (child-call timeouts), [#daemon-jobs](../docs/agent/platform-decisions.md#daemon-jobs) | New anchor `#child-process-owner-and-lifetime`, generalising both |
| 4 Uncertain means hold | **Instances only** — operator-override clause 5, jury method move 6, merge-replay clause 7 | New anchor `#uncertain-holds-speedups-never-prove` (the general rule) |
| 5 Cascade settings with logged source | **Yes** — [#config-extends-platform-default](../docs/agent/platform-decisions.md#config-extends-platform-default) + [#operator-override-settings-layer](../docs/agent/platform-decisions.md#operator-override-settings-layer) | Amendment clause only (delivery-system policies are cascade keys) |
| 6 Time-dependent tests pin their clock | No (`we:docs/agent/testing.md` rule 5 covers default-argument clocks only) | New anchor `#time-dependent-tests-pin-clock` |
| 7 Small graduation, hold last good | **Partly** — `#resident-daemon-reload-lifecycle` clause 5 (b)/(c)/(f) | Amendment: clause 5(c)'s "drop for the pass" becomes "hold last good" |
| 8 Only operator records lift limits | **Partly** — `#operator-override-settings-layer` clause 3 (settings writes only) | New anchor `#operator-records-lift-limits`, generalising clause 3 |
| 9 Real-backlog tests avoid fixed global caps | No | New anchor `#real-backlog-tests-no-global-caps` |
| 10 Main health includes the merge queue | No | New anchor `#latent-red-main-from-merge-queue` |

---

## Rule 1 — Heavy shared data is loaded once and served; direct reads are only the fail-closed fallback

Fork-existence: per-caller reads and a shared service cannot both be the normal path. If each caller re-reads, the
memory and time cost scales with the number of callers.

**Statement.** Heavy datasets — the backlog index, the review run store, the PR store, and any later dataset over
an agreed size — are loaded once per host by a shared local data service and read from it. A caller reads the
files directly only when the service is down, and that fallback must give the same answer or hold (rule 4). It
must never return a partial result as complete.

**Why.** Many processes on one host each re-read the same large file sets. The cost multiplies by the number of
callers, and it is the main source of both slowness and memory pressure.

**Evidence.**
- 2026-10-19 22:09: mergeCascade was slow because the red-team evidence read re-read **6,474 run files (1.5 GB)
  on every call** — about 9 s per call and 200–600 s per pass. Epic `6786` (red-team evidence; operator ruled
  Option A on 2026-10-20 07:31).
- Four separate speed-ups of that same read were each audited WEAKENED that night (22:22, 22:41, 22:52, 23:00),
  because a per-caller cache has to re-prove freshness on every call. A single writer-kept index removes that
  problem. The 22:22 entry already names it: "needs a design call (writer-kept per-PR index)".
- About 10 concurrent review rounds use about 12 GB; a memory audit is in progress.

**Enforced by.** A `check:standards` rule listing the registered heavy datasets and refusing a new direct
reader outside the service and its declared fallback module. The service publishes a per-dataset generation
number, so readers can tell a stale answer.

**Exceptions.** One-off operator scripts and tests that use a temporary fixture store.

- **(a) Adopt as stated. (default)**
- (b) Adopt for the review run store only, and decide the backlog index and PR store when the memory audit lands.
- (c) Do not adopt.

Recommended: (a). The run-store case alone cost a night of rejected fixes. The backlog index and PR store have the
same shape (many readers, one writer).

## Rule 2 — Every heavy job takes a memory-aware admission slot; a queue timeout holds, it never runs unslotted

**Existing statute:** [#heavy-command-admission-queue](../docs/agent/platform-decisions.md#heavy-command-admission-queue).
This rule is an amendment to it, not a new anchor.

Fork-existence: if admission can be skipped on timeout, the cap is only a hint. Under load it turns off exactly
when it is needed.

**Statement (amendment).**
1. The heavy set adds **review seats and red-team seats** to `check:standards`, `verify-lane`/`test:unit`,
   vitest and Playwright.
2. A slot is **memory-aware**: admission checks free memory and swap as well as the slot count. It is a smoothed
   reading, not the point-in-time load gate the operator rejected.
3. **A queue timeout holds the job** (it reports `waiting-for-capacity` and retries). It never proceeds unslotted.
4. A gate time limit is counted from admission, not from the request, so a busy host defers work instead of
   killing it half-way.

**Why.** Admission that fails open let a pile-up become a host-wide outage.

**Evidence.**
- 2026-10-20 09:34: **12 concurrent verify-lane runs while the pool showed 0/2 held**, load 57, swap 5 of 6 GB.
  Git calls timed out (ETIMEDOUT), so red-main-hold read "shared freeze unreadable" and nothing landed (11 PRs
  ready, queue empty).
- The code says so in plain words: `we:scripts/verify-lane.mjs` (admission comment above
  `acquireSlotBlocking`) "Fails OPEN on a queuing timeout (proceeds unslotted with a stderr warning)".
- 2026-10-20 01:39: verify-lane was killed twice at its gate time limit (51 and 42 min) on the busy host, so a
  main PR could not open.

**Enforced by.** The `we:scripts/readiness/heavy-admission.mjs` wrapper (already the chokepoint) plus a unit test
that a timeout returns `waiting`, not `run`. The host sampler's pressure reading feeds the memory check.
`we:scripts/guard-bash.mjs` already denies raw heavy spellings.

**Exceptions.** `CI=true` and `WE_HEAVY_ADMISSION=off` stay pass-through. The `lane-pool acquire` `npm ci`
exception stays as ratified.

- **(a) Adopt all four clauses. (default)**
- (b) Adopt clauses 1, 3 and 4 now, and add the memory check (clause 2) after the memory audit gives a number.
- (c) Do not adopt.

Recommended: (a). Clause 3 alone would have prevented the 09:34 outage. Clause 2 is what keeps 10 review rounds
(about 12 GB) from pushing the host into swap.

## Rule 3 — Every spawned child has an owner and a maximum lifetime; orphans are reaped automatically

**Existing statute (partial):** `#resident-daemon-reload-lifecycle` clause 6 ("every child call a tick makes has a
timeout") and [#daemon-jobs](../docs/agent/platform-decisions.md#daemon-jobs) (durable job records). Neither
covers processes outside a daemon tick, or reaping. New anchor `#child-process-owner-and-lifetime`.

Fork-existence: a process with no recorded owner cannot be told apart from a live one, so either every child is
registered or orphans pile up silently.

**Statement.** Every process a delivery script spawns records an owner (the spawning job, lane holder slug or
daemon) and a maximum lifetime in a host-wide registry. A reaper pass ends any child whose owner is gone or whose
lifetime has passed. It ends only registered children, by recorded PID and start time, never by name pattern, and
it logs each one.

**Why.** Long-lived leftovers hold memory and slots, and today only the operator notices them.

**Evidence.**
- **154 orphaned `node -e setInterval` keep-alive processes**, up to 19 days old (2026-10-20 memory audit).
- A **bun-trial vitest hung for 8 h 42 min** (pids 90829/91313/91396). It was stopped only by hand, with operator
  OK, on 2026-10-20 09:34. The same strays were first seen at 03:58 (3–4 h old) and could not be acted on
  overnight.

**Enforced by.** A shared spawn helper that registers and sets a lifetime, plus a `check:standards` rule refusing
raw `spawn`/`exec` of long-running children in `we:scripts/` outside it. The reaper runs as a health-watch pass.

**Exceptions.** The operator's own processes (dev servers, editors) are never registered, so never reaped. Resident
daemons are owned by launchd and keep their heartbeat rule.

- **(a) Adopt as stated. (default)**
- (b) Report-only first: the reaper lists orphans in needs-you for a week, then the operator flips it to act.
- (c) Do not adopt.

Recommended: (a), with the reaper's act switch as a cascade setting (rule 5). The registry rule (end only
recorded PIDs) makes acting safe. The no-pattern-kill rule stays absolute.

## Rule 4 — Uncertain means hold; a speed-up may never turn "unknown" into "proven"

**Existing statute:** fail-closed instances exist (`#operator-override-settings-layer` clause 5, the merge-replay
rule's clause 7, the jury method's red-team move). There is no general anchor. New anchor
`#uncertain-holds-speedups-never-prove`.

Fork-existence: a guard either treats a missing or unreadable input as a block, or as a pass. Both cannot hold.

**Statement.** Any guard, gate or check that cannot get its input — unreadable, timed out, stale, partial — holds
and says why. A change made for speed (a cache, a skipped fetch, a narrower read) must keep every "unknown" an
"unknown". If it makes one count as proven, it is a weakening and is rejected. This is the guard-audit standard
already applied to hotfixes, stated once.

**Why.** Speed-ups are where fail-open slips in, because the fast path is usually the one that skips the proof.

**Evidence.**
- 2026-10-19 night: **four cascade speed-ups rejected as WEAKENED** — run-index cache v1 (stat-to-skip race),
  v2 (race moved to re-stat), tip cache, single-fetch (unknown→proven via `--no-tags`).
- 2026-10-19 23:00: the audit found a live fail-open — enqueue went ahead when the locked live-queue read errored.
  Fixed live as hot-queue-read-failclosed (hold `queue-read-failed`).
- 2026-10-20 09:34: red-main-hold failing on "shared freeze unreadable" was the rule working. It held instead of
  landing blind.
- Operator standing rule (2026-09-21): "If unsure we should have a design review."

**Enforced by.** The guard-audit (red-team) lens on every hotfix and graduation PR, already in use. `we:docs/agent/testing.md`
already requires a named test per fail-closed branch.

**Exceptions.** Purely advisory displays (a board, a report) may show "unknown" instead of holding.

- **(a) Adopt as stated. (default)**
- (b) Adopt for merge/land gates only.
- (c) Do not adopt.

Recommended: (a). Every rejected speed-up that night was outside the land gate itself (cascade, listing, fetch).

## Rule 5 — Every delivery policy is a cascade setting with its source logged (codify existing practice)

**Already exists:** [#config-extends-platform-default](../docs/agent/platform-decisions.md#config-extends-platform-default)
(strategy = configurable dimension) and [#operator-override-settings-layer](../docs/agent/platform-decisions.md#operator-override-settings-layer)
(standard < platform < tool < env < operator-override, each value logs its source). **No new anchor.** The
ruling adds one amendment clause to `#config-extends-platform-default`.

**Statement (amendment).** In the delivery system, every policy — caps, timeouts, round limits, switches,
reaper modes — resolves through `we:scripts/lib/policy-cascade.mjs` and logs its source. A hard-coded policy
constant outside the cascade is a defect.

**Evidence.** Operator standing rule (2026-10-03/04): "should be policy with configurable", "make it a
configurable dimension". On 2026-10-19 the gh slot class was shipped as settings-only, and conflict-class rework
was ruled "keep + restore test + setting" (2026-10-20 07:51).

**Enforced by.** Review lens today. A follow-on `check:standards` rule could flag numeric policy literals in
`we:scripts/conveyor/` and `we:scripts/lib/`.

**Exceptions.** Invariants (the confirmed-broken always-block, safety refusals) are never settings.

- **(a) Codify as an amendment clause. (default)**
- (b) Leave as practice (no text change).
- (c) Do not adopt.

Recommended: (a). It is already followed. Writing it down lets a reviewer cite it.

## Rule 6 — Time-dependent tests pin their clock

New anchor `#time-dependent-tests-pin-clock`. `we:docs/agent/testing.md` rule 5 covers a function's default
clock argument only.

Fork-existence: a test that reads the real date passes or fails depending on when it runs, so it either pins the
clock or carries a time bomb.

**Statement.** A test whose result depends on the date or time — windows, ages, expiry, "last 7 days" — injects or
fakes the clock and sets it next to its fixtures. A test never compares fixture dates with the real now.

**Evidence.** A ledger readiness drain-facts test held a fixture dated 10-13. At 00:00 ET on 2026-10-20 it fell
out of its 7-day ET window and **failed on plain main**. Every merge group failed from 04:39Z, and nothing merged
from 03:00Z until about 10:17Z. Fixed by PR #5736 (pins the clock).

**Enforced by.** A `check:standards` rule (or test lint) that flags `Date.now()` / `new Date()` in a test that
also holds date-literal fixtures without `vi.useFakeTimers`/`vi.setSystemTime` or an injected `now`.

**Exceptions.** Tests that measure real elapsed time (timeouts, performance budgets).

- **(a) Adopt as stated, with the lint. (default)**
- (b) Adopt the rule, with no lint (review only).
- (c) Do not adopt.

Recommended: (a). One test cost about six hours of no merges. A lint is cheap.

## Rule 7 — Hotfixes graduate as small PRs and retire on merge; a rebuild never silently drops an established overlay — it holds last good

**Existing statute:** `#resident-daemon-reload-lifecycle` clause 5 — (b) an overlay drops once `main` has it, (c)
an overlay that no longer merges "drops for the pass with an alert", (f) graduation is a normal PR. This rule
**amends clause 5(c)** and adds the small-graduation clause. No new anchor.

Fork-existence: when an overlay stops merging, the daemon either keeps running the last good tree or runs without
the overlay. It cannot do both, and running without it silently reverts a live fix.

**Statement (amendment).**
1. An overlay that no longer merges cleanly, and is not yet on `main`, makes the rebuild **hold the last good
   tree** and raise an alert. It does not drop the overlay. Clause 5(b) (retire on merge) is unchanged.
2. Hotfixes graduate as **small, one-concern PRs**, never one bundle of the whole overlay stack.

**Evidence.**
- Overlay drops on **2026-10-19 11:22 ET** and **2026-10-20 11:51Z**. On the second, the review clone dropped
  almost all overlays after graduated changes reached main (git-run, review-daemon, nightly-coroner job, daemon
  manifest, lane-pool). It was restored by hand at 09:04.
- PR #5757 (card `x9diisp`, the hold half: hold on last good instead of dropping live overlays).
- Operator rule "small graduation PRs". On 2026-10-19 22:57, seven small graduation PRs (#5729–#5735) cleared
  review, while about 30 overlays sitting on one prototype branch (171 files, ~8.5k lines) needed a split plan.

**Enforced by.** The daemon rebuild path (`we:scripts/lib/daemon-overlays.mjs`) with a test that a non-merging,
unmerged overlay yields `hold-last-good`. The graduation tooling refuses a PR over the small-file/size composite
unless split.

**Exceptions.** The operator removing an overlay on purpose (rollback, clause 5(d)) still drops it at once.

- **(a) Adopt both clauses. (default)**
- (b) Adopt clause 1 only.
- (c) Do not adopt.

Recommended: (a). Clause 1 is exactly what #5757 builds. Clause 2 records the operator's existing instruction.

## Rule 8 — Only operator-authored records lift limits; services never act as the operator

**Existing statute (partial):** `#operator-override-settings-layer` clause 3 (only an operator's verified GitHub
review authorizes a settings write; a terminal or local `gh` login can be forged). This generalises it to every
limit-lifting act. New anchor `#operator-records-lift-limits`.

Fork-existence: either a service may lift a limit on its own credential, or only a record the operator wrote can.
Both cannot hold, because a service that can lift its own limits has no limit.

**Statement.** Round grants, `review:human` clearances, standing rulings and any other limit-lift take effect
only from a record the operator authored — a verified review, a standing-ruling issue, a decision card. A service
may *apply* a standing ruling the operator wrote, within that ruling's own bounds. It never writes one, and it
never uses the operator's personal login.

**Evidence.**
- Standing ruling issue #5751 (automatic +1 review round for card-only PRs). The +1 was applied by hand about 11
  times on 2026-10-19 under that ruling, and the operator ruled it automated, capped at 3 per PR (2026-10-20 07:51).
- The personal-login exception was rejected (option B). PR #5729 (gh-auth graduation): daemons never fall back to
  the personal login.

**Enforced by.** The round-grant and clearance code paths read only operator-authored records, verified by
author, plus a test that a service-authored record is ignored. `we:scripts/guard-bash.mjs` / gh-shim refuse the
personal token for daemons.

**Exceptions.** None. Emergencies go through an operator-authored record too.

- **(a) Adopt as stated. (default)**
- (b) Adopt for clearances and settings only, and leave round grants to per-ruling text.
- (c) Do not adopt.

Recommended: (a). #5751 shows the pattern: the operator writes the ruling once, and the service applies it within
its cap.

## Rule 9 — Tests over the real backlog never use fixed global caps that unrelated card PRs can trip

New anchor `#real-backlog-tests-no-global-caps`.

Fork-existence: a test over live data either measures only what the PR changed (a ratchet or diff), or holds a
global count that any unrelated PR can push over the line.

**Statement.** A test or check that reads the real `backlog/` measures only the PR's own change (no new
violations), or a ratchet that only goes down. It never uses a fixed global cap that a PR can trip without having
touched the offending cards.

**Evidence.** The #3337 real-backlog stale-scope-path cap (`we:scripts/check-standards.mjs` §6d-septies,
`we:scripts/__tests__/check-standards.test.mjs`) hit "30 !< 30". Main already held 29 stale paths, and two
unrelated PRs added one each, so **merge groups failed** on 2026-10-20 from 01:31. Fixed by PR #5738, which
corrected 23 of the stale paths and kept the strict cap.

**Enforced by.** Review lens, plus converting the existing #3337 cap to a no-new-violations diff check.

**Exceptions.** A cap the operator set on purpose as a hard budget, stated as such in the check.

- **(a) Adopt as stated. (default)**
- (b) Keep fixed caps, but require headroom (cap at least current + N).
- (c) Do not adopt.

Recommended: (a). Headroom (b) only delays the same failure.

## Rule 10 (found in the handoff) — Main's health includes the merge queue; repeated merge-group failure is a latent red main

New anchor `#latent-red-main-from-merge-queue`.

Fork-existence: red-main handling either listens only to push CI on `main`, or also to merge-group results.
Listening to push CI alone misses a failure that only shows up in the merge queue.

**Statement.** If merge groups fail repeatedly on the same check while push CI on `main` is green, the system
treats it as **latent red main**. It raises the red-main alert and lets a main-fix PR jump the queue. It does not
keep re-planning doomed groups.

**Evidence.** 2026-10-20: push CI was green, but every merge group failed from 04:39Z (the rule 6 time bomb and
the rule 9 cap). "Red-main machinery idle" (03:33). The fix PRs #5736/#5738 sat behind doomed groups for
hours. They were batching-deferred and skipped as "already pending" (03:33–05:09), and the main-fix priority was
ignored by the full pass (04:50). Three detector attempts that night were audited WEAKENED (malformed rows, streak
filter, duplicate needs-you), so the build needs its own design.

**Enforced by.** A detector in the drain's red-main inputs, with tests for malformed run rows and dedup.

**Exceptions.** A single flaky group failure is not a latent red main (streak threshold is a cascade setting).

- **(a) Adopt as stated. (default)**
- (b) Alert only (needs-you), with no queue-priority effect.
- (c) Do not adopt.

Recommended: (a). The alert alone would not have moved #5736 sooner. Priority for the main fix is what was missing.

---

## Not proposed (considered and left out)

- "Priority wins in every planning path" (the drain ignored `priority:now` on 2026-10-20). Too narrow for statute.
  It is a drain bug, and rule 10 covers its main-fix case.
- Lane commits authored as `test` (global git identity). A host setup fix, not an architecture rule.

## Acceptance

- [A1] **Executable** — for each rule ruled (a)/(b), its anchor (new or amended) is present in
  `we:docs/agent/platform-decisions.md`: a `grep -c` for `{#shared-data-served-once}` in that file returns 0
  before and 1 after, and likewise for every new anchor ruled in.
- [A2] Every rule ruled (a)/(b) has a child build card for its "Enforced by" line, filed after the ruling.

## Non-goals

- [N1] No code, no enforcement build in this card. Builds are child cards.
- [N2] Does not re-open the ratified clauses of the existing anchors; it only amends the named clauses.

## Edge cases this change must handle

1. **Untrusted text** — n/a: a decision card; quoted operator words are stored as quotes.
2. **Truncated reads** — Rule 1 fallback and rule 4: a partial read holds, never counts as complete.
3. **Shared state files** — Rules 1 and 3: one writer per dataset and per process registry.
4. **Fail closed** — Rule 4 is the general statement; rules 2 and 7 apply it to admission and rebuilds.
5. **Identity scoping** — Rule 8: authority comes from the record's verified author, never the caller.
6. **State over time** — Rules 3 and 6: lifetimes and clocks are explicit, never implied by the real now.
7. **Who wrote it** — Rule 8: every limit-lift names its operator-authored record.
