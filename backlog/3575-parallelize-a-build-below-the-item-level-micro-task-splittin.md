---
bornAs: xvfvktj
kind: decision
parent: "3383"
status: open
scope: ["we:scripts/readiness/dispatch-plan.mjs", "we:skills-src/batch-backlog-items/parallel-execute.workflow.js", "we:skills-src/split-backlog-item/SKILL.md", "we:scripts/operations/explore.mjs", "we:docs/agent/backlog-workflow.md"]
dateOpened: "2026-09-07"
relatedTo: ["3820", "3816", "3779", "3922"]
tags: [parallel, dispatch, split, workflow, conveyor]
---

# Parallelize a build below the item level: micro-task splitting, pre-build splittability analysis, and overlap coordination models

Today's dispatch grain is **one backlog item, one lane, one agent, start to finish** — whether dispatched
by the mechanical dispatcher (`#3383`) or a `/batch`/`/workflow` session. Parallelism only exists **across**
items (`we:skills-src/batch-backlog-items/parallel-execute.workflow.js`'s provably-disjoint worktree
lanes), never **within** one. The operator asked for real research, not a pick, into three related but
separate questions: (1) can ONE item's own build be decomposed into sub-briefs dispatched to several
agents in parallel, and if so how do the pieces integrate; (2) should a rigorous pre-build pass determine
*whether* an item is build-splittable, rather than assuming yes/no; (3) for work that genuinely overlaps in
scope, is a coordinated shared-branch ("work committee") model ever better than today's serial hold
(`overlaps lane-<n>` / `branch-drift-blocked` in `we:scripts/readiness/dispatch-plan.mjs`).

**Headline finding: none of the three questions need a new integration mechanism invented from scratch.**
This repo already runs two structurally different, both-proven integration patterns for parallel work —
git-is-the-arbiter disjoint-lane assembly (`we:skills-src/batch-backlog-items/parallel-execute.workflow.js`)
and predecessor-tip **chain stacking** for serial overlap (`#2387`) — and a real, lived example of the
shared-branch model this decision was asked to evaluate (`origin/lane/mechanical-dispatcher`, governed by
`we:.claude/skills/mechanical-delivery-doctrine/SKILL.md` rules 4/10). The open questions below are about
**which existing mechanism a finer split reuses, under what splittability gate, and at what scope-overlap
threshold a shared branch is worth its own proven cost** — not about designing a fourth pattern.

### Recommended path at a glance

| | recommended default | main alternative(s) | confidence |
| --- | --- | --- | --- |
| Fork 1 — split unit & integration mechanism | **(b) reuse `we:skills-src/batch-backlog-items/parallel-execute.workflow.js`'s disjoint-lane assembly wholesale, fed sub-briefs instead of items** | (a) a new bespoke sub-brief dispatcher; (c) never split below the item | medium |
| Fork 2 — splittability gate: file-disjointness alone, or file+interface? | **(b) file-disjointness is necessary but not sufficient — require an interface-stability check before fan-out** | (a) file-disjointness (touch-set) alone | high |
| Fork 3 — who runs the pre-build splittability analysis, and when | **(b) fold it into `we:skills-src/split-backlog-item/SKILL.md`'s existing investigation pass as a THIRD verdict (`could-not-split` / `could-split-into-cards` / `could-split-into-sub-briefs`), reserving the `explore` committee for genuinely ambiguous large items only** | (a) always convene an `explore` committee per item; (c) no gate — always attempt or never attempt | medium |
| Fork 4 — overlapping-scope coordination: work committee vs. serial hold | **(c) keep serial hold as the default; add a narrow, explicitly-gated shared-branch escalation only when overlap persists past N held ticks AND touches ≤1 file** | (a) work-committee/shared-branch as a general alternative to serial holds; (b) never build it | medium |
| Fork 5 — delivery strategy: how a split card is delivered, and the event that counts as "finished" (added 2026-09-21 from #3820; **provisional, research owed**) | **(a) each card declares a delivery strategy; the default is slice-to-`main` as child cards; the drain resolves a card only at its declared strategy's completion event** | (b) one hard-wired strategy (integration branch only); (c) no declared strategy, infer from branch names (today's bug, #3816) | low (not yet researched) |

**Stale premise (found 2026-09-22 by the #3922 prep).** Fork 1 recommends reusing the parallel workflow's
"one integration worktree, one merge" assembly. That model was dropped on 2026-07-03: the workflow's own header says
it supersedes it (`we:skills-src/batch-backlog-items/parallel-execute.workflow.js:13-18`), and every item now opens
its own PR for the drain to land. Re-prepare Forks 1 to 3 against today's model before ruling them. #3922 Fork 2
proposes the in-lane mechanism: one worktree per parallel step, applied in dependency order.

## Fork 1 — what is the split unit, and how do the pieces integrate back into one deliverable

*Why this is a fork:* the operator's own framing already assumes splitting is possible for *some* work and
asks concretely who integrates the pieces and how conflicts resolve. That is a real, consequential design
choice — a new mechanism vs. reusing an existing one produces genuinely different build/maintenance cost and
risk, not a stylistic preference (confirmed against the two-confusion test: even at infinite engineering
budget, "which mechanism owns the merge" still has to be answered one way, because two merge authorities
racing on the same assembly is a correctness hazard, not friction).

**What already exists and is proven, not hypothetical.** `we:skills-src/batch-backlog-items/parallel-execute.workflow.js` already does exactly the mechanics this fork needs, just fed a different
INPUT today:

1. `plan` probes each unit's touch-set and partitions into provably-disjoint worktree lanes + one serial
   lane for anything entangled/uncertain (the exact shape `#1147`'s header calls "concurrent + one serial
   lane for entangled/uncertain work").
2. Each lane builds in its **own worktree clone** — no shared HEAD, no live git-branch contention between
   concurrent agents (the structural fix the `parallel-workflow-blocked-by-git-guard` agent-memory note
   landed: "the only architecture that gives true parallelism here: N independent clones... commit
   locally... push to a central repo").
3. **Assembly happens in ONE throwaway integration worktree** (`git worktree add … -b batch-parallel/<slug>
   HEAD`), never on the live branch — `#1869`'s own incident (assembly landed on `main` directly once) is
   why a belt-and-suspenders `branchOk` assertion now confirms the assembled branch exists, HEAD is on it,
   and it is **not** the live branch, checked before the main agent lands.
4. **The orchestrating session performs the ONE merge** (`git merge --no-ff`) from the integration branch
   onto the live branch — a single human/agent-supervised chokepoint, not a peer-to-peer negotiation between
   the parallel builders themselves.
5. A **reconcile step** verifies every ledger-`resolved` unit's commit is actually reachable from the
   integration branch before trusting the ledger (`#1869`'s second defect — a worktree-local resolve that
   never merged was once falsely reported `resolved`).

This is EXACTLY "who integrates the pieces, how are conflicts resolved" answered already: git resolves
disjoint pieces structurally (they touch no common file, so the merge is trivially clean); a genuinely
overlapping piece is never split into a concurrent lane in the first place — it goes to the serial lane,
or (per `#2387`'s serial-only overlap-stacking) bases on its predecessor's pushed tip so the shared-file
conflict is resolved **once, in-session, while context is hot**, never blind at a later drain. The only
thing this fork needs to add is: **the units being partitioned are sub-briefs carved from ONE backlog item
(by Fork 3's investigation pass) instead of N separate backlog items** — the probe/partition/assembly/merge
machinery is agnostic to that distinction; it already operates on touch-sets, not item identity.

**Recommended default — (b) reuse `we:skills-src/batch-backlog-items/parallel-execute.workflow.js`
wholesale, fed sub-briefs.** Concretely: Fork 3's investigation pass (extended
`we:skills-src/split-backlog-item/SKILL.md`) produces named sub-briefs with predicted touch-sets, exactly
the shape `we:skills-src/split-backlog-item/SKILL.md`'s step 2 (the #2619 touch-set probe) already authors
onto a slice's `--scope`. Those sub-briefs feed the SAME probe→partition→worktree→assembly→one-merge
pipeline `we:skills-src/batch-backlog-items/parallel-execute.workflow.js` runs for cross-item batches.
The item stays ONE card the whole time (never converted to an epic, unlike a real `/split`) — its
sub-briefs are ephemeral dispatch units that exist only for the duration of one build, not new backlog
entries. Per rule 3 of `we:.claude/skills/mechanical-delivery-doctrine/SKILL.md` ("the orchestrating
session never edits or commits directly"), the single merge step must itself be a dispatched subsession's
act, not the orchestrator's own `Edit`/`git commit` — mirroring how
`we:skills-src/batch-backlog-items/parallel-execute.workflow.js` already keeps the orchestrator's role
to "acquire, brief, relay" for ordinary item dispatch.

**Rejected alternative — (a) a new, bespoke sub-brief dispatcher.** This is exactly the "twin templates for
the same job" drift multiple existing files warn against by name (`we:scripts/conveyor/reconcile-fix-dispatch.mjs`'s own header: "a second planner for the same job is the drift this file's
phase-borrowing rule exists to prevent"; `we:scripts/conveyor/review-session-slug.mjs`'s header makes the
identical point). A second probe/partition/assembly implementation for sub-item units would duplicate every
hard-won fix `we:skills-src/batch-backlog-items/parallel-execute.workflow.js` already carries — the
`process.cwd()` Workflow-sandbox crash fix, the push-carve-out redirection-token fix, the bounded-retry
ref-lock fix (#1995), the `branchOk` assertion (#1869) — for no benefit this research found. Rejected as
the default; confidence **high** that reuse beats a fresh build specifically, independent of this fork's
overall confidence.

**Rejected alternative — (c) never split below the item.** The conservative floor, and the correct choice
for most of today's backlog (see Fork 2's discussion of WHEN splitting pays for itself) — but rejecting it
outright would mean this decision answers nothing the operator asked, and this repo's own evidence
(`#1153`'s validation runs; the "migrate-table family" cited in the `parallel-workflow-blocked-by-git-guard`
agent-memory note as clean disjoint multi-file work) shows mechanically-repetitive, file-disjoint work
inside a single story is common enough to be worth a gated mechanism, not a blanket refusal.

**Real cost this fork does not hide.** Every parallel batch run recorded in this repo's own history paid
real coordination overhead even when it worked: the first real `#1153` validation run took ~78 minutes for
28 agents (worktree isolation + integration assembly overhead, most units still ran concurrently only 2 at
a time); the second (`batch-2026-06-29b`) improved to ~28 minutes for 20 agents but still needed a
serial-replay fallback for 2 lanes whose concurrent push failed. Splitting BELOW the item level does not
remove this cost — it pays the SAME per-lane worktree+probe+assembly tax at a finer grain, so it only nets
a win when a story's *own* work is large enough (see Fork 2/3) that the parallelism gained exceeds that
fixed tax. A 2-file `size·2` task will never clear that bar; a `size·8` story with 6 genuinely independent
mechanical sub-edits might.

## Fork 2 — is file-disjointness alone a sufficient splittability gate?

*Why this is a fork:* two coherent, mutually exclusive gate definitions exist (touch-set overlap alone vs.
touch-set overlap **and** a check that no sub-brief depends on a decision another sub-brief will make), and
they produce genuinely different accept/reject outcomes for the same story — not a cost tradeoff, a
correctness question about what "safe to split" actually means.

**The gap file-disjointness alone misses.** Every existing overlap/disjointness check in this repo — `we:scripts/readiness/scope-lease.mjs`'s `scopesOverlap`, `we:scripts/readiness/batch-schedule.mjs`'s
`contends()`, the `#1147` probe — operates on **files touched**, because that is what git can arbitrate
mechanically. But two sub-briefs can touch **disjoint files** and still be semantically coupled: sub-brief
A implements a function in one module against a signature sub-brief B is simultaneously *deciding* in
another module. Git will merge that cleanly (no line-level conflict) and produce code that does not work
together — the exact "partial/broken intermediate state" `we:skills-src/split-backlog-item/SKILL.md`'s own
rubric condition 5 already names for CARD-level splits ("a registry with no consumer... violates this →
atomic"). A build-level split has the identical failure mode one level down, and file-disjointness cannot
see it because the coupling lives in an interface, not a file overlap.

**Recommended default — (b) file-disjointness is necessary but not sufficient; require an interface-
stability check.** Concretely: a sub-brief is fan-out-eligible only if every shared type/signature/contract
it depends on is **already decided and stable** before dispatch — either because it already exists in the
tree, or because Fork 3's investigation pass authors it as a small "shape-setting" prerequisite sub-brief
that lands (or is at minimum fully specified in the brief text, file:line-cited) before the dependent
sub-briefs fan out. This is a direct transfer of `we:skills-src/split-backlog-item/SKILL.md`'s own rubric
condition 3 ("named file paths grounded in the investigation pass, file:line-citable, not authored from the
body") one level down: the investigation pass must be able to point at the *exact* interface each sub-brief
assumes, not merely the files it touches. Practically this reads as a small ordering rule: interface-
defining work is either done by the orchestrator before fan-out (a `compute`/`plan`-style step, not a
dispatched agent) or is its own first-wave sub-brief that gates the rest — the SAME "wave" shape
`we:scripts/readiness/batch-schedule.mjs#scheduleWaves` already uses for cross-item contention (disjoint
items fan out in wave 0, contending items chain into later waves); an interface-defining sub-brief is
simply always wave 0.

**Rejected alternative — (a) file-disjointness (touch-set) alone.** Cheaper to implement (it is what
`we:skills-src/batch-backlog-items/parallel-execute.workflow.js` already checks, unchanged) but the
failure mode above is not hypothetical for this repo's own work: the constellation's WE→FUI→Plateau
boundary work and any `declared-once, callers-generated` operation (`#3031`'s own governing rule) are
exactly the shape where two disjoint files agree on one not-yet-stable contract. Confidence **high** that
file-disjointness alone is insufficient as a general rule — the residual uncertainty is only in how cheaply
the interface-stability check can be automated versus left to the investigation pass's judgment, which is
Fork 3's territory.

## Fork 3 — who runs the pre-build splittability analysis, and when

*Why this is a fork:* the operator asked for a RIGOROUS analysis step, not an assumption either way — but
"rigorous" is not a fixed cost; convening a multi-agent committee (`we:scripts/operations/explore.mjs`) per
item is a materially heavier and slower gate than folding a splittability verdict into work the
investigation pass already does. Both are real, defensible defaults; which one is right depends on scale,
which is exactly what a fork resolves.

**What already exists, and how close it already is to this job.** `we:skills-src/split-backlog-item/SKILL.md` already runs an investigation pass (grep/Explore the real code, ground every proposed seam
`file:line`, record each slice's predicted touch-set) and applies a 5-condition rubric, producing one of
two outcomes today: **could-split** (into separate cards) or **could-not-split** (with a named unblocking
action). That is *already* most of a build-splittability analysis — the missing piece is a THIRD outcome
this decision's Fork 1/2 need: **could-split, but as sub-briefs of the SAME item rather than as new
cards.** The difference between "split into cards" and "split into sub-briefs" is not a difference in HOW
you find the seams (the same investigation pass, the same rubric conditions 2-5 apply almost verbatim) — it
is a difference in what happens to the pieces afterward: cards get scaffolded and go through Definition of
Ready separately (today's `/split`); sub-briefs stay ephemeral and fan out through Fork 1's dispatch
immediately. Condition 1 ("volume, not uncertainty — you cannot split away a decision") applies unchanged
to either outcome; condition 4 ("clean DAG, real independence") is exactly Fork 2's interface-stability
gate restated for the sub-brief case.

**`explore`'s committee is the right vehicle for a DIFFERENT, narrower job: genuinely ambiguous large
items where the seams are not obvious from a single investigation pass.** `we:scripts/operations/explore.mjs`'s own header is explicit that its lens set is open and its second mode (a one-panelist
`prior-art-survey`) already generalizes the kind of research pass `we:skills-src/prepare-decision-item/SKILL.md` runs by hand — convening a 2-3 panelist committee (one lens each: e.g. `architecture-audit` for
the interface-stability question, `risk-and-alternatives` for whether splitting nets a real win) to
investigate "is item #NNN's build genuinely splittable, and along what seams" is a well-fitting REUSE of an
already-declared operation, not a new mechanism (per `#3031`'s "operations declared once, every caller is a
generated one" statute). But it is real cost: each panelist is a FULL spawned agent session
(`we:scripts/operations/explore.mjs`'s own header: "every panelist is a full `claude` session that costs
tokens"), and the shipped executor runs panelists SERIALLY (one after another, by design — see
`we:scripts/operations/explore.mjs`'s own header on why that is a stated, not-hidden cost), so a
3-panelist committee costs roughly 3x one investigation pass in wall clock alone, before counting token
spend. Running that for every candidate item — including small `size·2`/`size·3` stories where the entire
build would complete before a committee finished convening — spends more than it could ever save.

**Recommended default — (b) fold the sub-brief verdict into `we:skills-src/split-backlog-item/SKILL.md`'s
existing investigation pass as its third outcome, reserving `explore` committees for a narrow, sized
carve-out.** Concretely: run the ALREADY-EXISTING investigation pass (unchanged) on any candidate that
clears a size floor (proposed: `size ≥ 5`, mirroring the existing `size > 8` oversized-story trigger one
rung down, since sub-brief splitting is a lower-overhead operation than card-splitting and can pay off at a
smaller size — see Fork 1's "real cost" note on why a `size·2` task never clears the bar regardless of gate
cheapness). The pass now emits one of THREE verdicts instead of two: `could-not-split` (existing, story
stays atomic), `could-split-into-cards` (existing `/split` path, unchanged), or `could-split-into-sub-briefs`
(new — Fork 1's dispatch target, gated by Fork 2's interface-stability condition). Reserve an `explore`
committee for the residual case the investigation pass itself flags as genuinely ambiguous — e.g. a large
item (`size ≥ 8`) where a single investigator's seam-finding disagrees with itself across two candidate
decompositions, or where the interface-stability question (Fork 2) cannot be resolved without independently
cross-checking several subsystems. This keeps the expensive multi-agent path rare and evidence-triggered
rather than a standing tax on every candidate.

**Rejected alternative — (a) always convene an `explore` committee.** Rigorous in the strongest sense (every
candidate gets N independent lenses) but the cost argument above makes this the wrong DEFAULT:
`we:scripts/operations/explore.mjs`'s own header states the panel-size ceiling exists precisely because "a
caller who genuinely wants twelve investigators wants several runs, each separately observable" — the
design already assumes committees are occasional, not a per-item gate. Not rejected outright — it remains
the escalation path for the ambiguous residual, per the recommended default above.

**Rejected alternative — (c) no gate — always attempt or never attempt sub-brief splitting.** "Always
attempt" reintroduces exactly the Fork-2 failure mode (interface coupling silently miscategorized as safe)
at scale; "never attempt" collapses this decision back to Fork 1's rejected floor (c) and answers none of
what the operator asked. Confidence **medium** on this fork overall — the size-floor threshold (proposed
`size ≥ 5`) is a reasonable starting knob grounded in the existing `size > 8` precedent one rung down, but
is not independently proven and should be tuned against the first few real runs, not treated as settled.

## Fork 4 — overlapping-scope coordination: is a work-committee/shared-branch model ever better than a serial hold

*Why this is a fork:* today's `we:scripts/readiness/dispatch-plan.mjs` answers "two queued items' scopes
overlap" with exactly one policy — hold the later one (`overlaps lane-<n>`) or hold everything touching a
drifting long-lived branch's own scope (`branch-drift-blocked`, `#3464`). The operator explicitly asked
whether a coordinated shared-branch alternative could sometimes beat that, framed as one option among
several, not a foregone conclusion. This is a genuine fork: the two models trade a real safety invariant
(no two agents ever write to the same ref concurrently) for a real latency gain (no serialization wait) —
that is a merit question, not a style preference, and the direction of the tradeoff depends on how deep the
real overlap is, which varies case to case.

**The shared-branch model already exists in this repo, live, and its own cost is directly on record — this
is not a hypothetical to theorize about.** `origin/lane/mechanical-dispatcher` (governed by
`we:.claude/skills/mechanical-delivery-doctrine/SKILL.md` rules 4/10) is exactly a "temporary shared feature
branch multiple sessions coordinate and integrate work on" — commits push straight to it, no per-commit PR
ceremony, multiple dispatcher-epic sessions have built on it across days. Its own incident (`#3464`) is the
direct evidence this fork must weigh: the branch drifted **78 commits behind / 29 ahead of `main`, with a
real content conflict**, because nothing mechanized ever reconciled it — costing a **~40-minute manual
reconciliation (15 real conflicts)** before delivery could resume. Rule 10 of the doctrine already codifies
the lesson this incident taught: *"a long-lived divergent branch is not the default operating mode"* — cut
it SHORT-LIVED, reconcile fast, fold back once proven, never let it become a standing parallel tree. This
is first-party, lived proof that a shared branch is buildable and occasionally the right tool (rule 4's
"ceremony-free bug fix on the prototype" case is a real win this repo takes daily) — and equally first-
party proof that its failure mode (silent drift compounding into an expensive reconciliation) is real, not
theoretical, the moment discipline lapses.

**What a shared branch trades away that today's serial hold gets for free.** The ENTIRE safety case behind
`we:skills-src/batch-backlog-items/parallel-execute.workflow.js`'s disjoint-lane model and `#2387`'s
overlap-stacking is "no two agents ever write to the same ref concurrently" — each lane owns its own
worktree/clone, and integration happens at ONE supervised chokepoint. A work-committee model explicitly
breaks that invariant on purpose: two agents commit to the SAME ref while both are still working. Human
pair-branching tolerates this because humans have a cheap, synchronous negotiation channel (voice, chat,
"give me a sec, pushing now") that keeps concurrent writers from stepping on each other in practice. Two
agents have no equivalent low-latency channel unless one is deliberately built — though one already exists
in this repo and is not hypothetical: `SendMessage` between two live sessions is a **confirmed, working**
mechanism (`we:backlog/3435-*.md` documents the operator's own session messaging `conveyor-3452`/
`prepare-3448` directly and getting a reply) — so "agents cannot coordinate at all" is not the real
objection; the real objection is that NOTHING today turns that raw messaging capability into a turn-taking
protocol (who commits when, who yields on a conflicting hunk, how a stalled peer is detected) — that
protocol is new, unbuilt surface, not a reuse of something proven.

**Recommended default — (c) keep serial hold as the default; add a narrow, explicitly-gated shared-branch
escalation only when overlap persists past N held ticks AND the overlap is shallow (≤1 file).** Concretely:
`we:scripts/readiness/dispatch-plan.mjs`'s existing `overlaps lane-<n>` hold stays the default outcome for
scope overlap, unchanged — it has zero coordination overhead, a proven safety story, and (per `#2387`) the
SERIAL case already gets most of a shared-branch's benefit for free via predecessor-tip stacking (the
shared-file conflict is resolved once, in-session, by whichever lane goes second — no live shared ref, no
peer negotiation protocol needed). Escalate to a shared branch only as a rare, mechanically-triggered
exception: an item held `overlaps lane-<n>` for more than a configurable tick threshold (a knob, not a
fixed number — tune against real hold durations once observed) AND whose overlap, re-probed, is narrow
(touches at most one shared file/interface — the cases described above as "two agents needing the same
shared types file for unrelated one-line reasons"). Below that threshold, the wait is cheap and serial wins
outright; above it, compounding delay starts to threaten to cost more than the coordination overhead would.
Any escalation still requires a designated INTEGRATOR (a third agent or the orchestrator, never the two
builders peer-negotiating the merge themselves) who owns conflict adjudication on the shared branch — the
same single-chokepoint principle Fork 1 already establishes for disjoint-lane assembly, extended to the one
case where the ref itself is shared rather than merged after the fact. This is a genuinely NEW mechanism
(turn-taking on a shared ref has no existing implementation to reuse, unlike Forks 1-3) — so it should
ship, if ratified, as its own small, separately-gated follow-on, not bundled into whatever lands from Forks
1-3.

**Rejected alternative — (a) work-committee/shared-branch as a general alternative to serial holds.** Too
broad: most scope overlaps this repo's own history shows are resolved cheaply by either provable
disjointness (no overlap at all — the common case) or a short serial wait (`overlaps lane-<n>` clearing in
one lane's normal build time) — paying a shared-branch's coordination cost for those forfeits real safety
for no measured gain. `#3464`'s own incident is direct evidence this failure mode is not rare once a shared
ref becomes the default rather than the exception. Confidence **medium**: the general direction (serial
default, narrow escalation) is well-supported by this repo's own two examples pulling in opposite
directions (branch-drift's cost vs. rule 4's real ceremony-free win); the SPECIFIC threshold knobs (tick
count, file-count ceiling) are proposed starting points, not measured optima — they should be treated as
config, tuned once the escalation path has real runs to learn from, exactly per the operator's "configurable
knobs" framing.

**Rejected alternative — (b) never build a shared-branch escalation; serial hold always, unconditionally.**
The safe floor, and arguably sufficient — this research did not find a documented case where serial holding
alone caused a delivery failure, only cases where it cost latency. Not rejected as *wrong*, only as
foreclosing an option the operator explicitly wants investigated rather than dismissed; recorded here as the
correct fallback if the escalation's real-world tick-threshold tuning (once (c) has live data) never
clears a bar that justifies its added complexity.

## Fork 5 — how a split card is delivered, and what event counts as "finished" (added 2026-09-21 from the #3820 review)

*Why this is a fork:* Forks 1-4 decide how a build is split and how its pieces integrate **inside one
delivery** (one card, sub-briefs, one assembled PR). They do not say what happens when a card is split into
several separately-landing pieces. Today the drain answers that by guessing from the branch name: a
`lane/<NNN>-…` ref credits item NNN as fully delivered, so PR #2392 (slice A of #3779) resolved a card whose
Done-when was mostly unbuilt (#3816). #3820 rules the narrow drain fix; this fork owns the general question it
raised, because the operator's framing there was that several delivery approaches exist, that a preference
should be configurable, and that an agent should choose among them by best practice.

**The idea.** A card declares a **delivery strategy**. Each strategy defines three things: (1) where its
pieces land, (2) what the drain does when one piece lands (never resolve the card), and (3) the **completion
event** that does resolve it. The drain reads the declared strategy instead of inferring from a branch name.

| Strategy | Pieces land in | Card resolves when |
| --- | --- | --- |
| Child cards / vertical slices (industry default, trunk-based) | `main`, each piece complete on its own | the last child card is resolved (the #658 open-children guard already refuses an early close) |
| Feature flag / dark launch | `main`, behind a flag | the flag is switched on (or removed) |
| Sub-briefs inside one card (Fork 1's model) | one integration worktree | its single assembled PR merges |
| Stacked PRs | `main`, in dependency order | the top PR of the stack merges |
| Integration branch (last resort; the declared "POC branch" mode, `#poc-branch-declared-delivery-mode`) | a declared branch via `deliveryTarget` | the branch merges to `main` |

**Configurable preference, agent chooses.** A repo policy file holds the preference order and each strategy's
eligibility rule (for example: prefer child cards; use a flag when the change is runtime-visible and a flag
system exists; allow an integration branch only when a half-delivered state must not reach `main`). The agent
picks at slicing time and records the choice on the card so it is auditable and the operator can override it.

**Provisional default — (a) declared strategy, default child cards, drain resolves at the completion event.**
It matches trunk-based practice (small slices to `main`, flags for unfinished work, long-lived branches as an
exception), and it reuses two things that already exist: the #658 open-children guard and the drain's
non-default-base hold (#3674). Confidence **low**: nothing below has been researched yet.

**Rejected alternative — (b) one hard-wired strategy (integration branch only).** Slices would stay off `main`
until the end, so other lanes cannot build on slice A, and it carries the POC-branch ceremony (registry entry,
drift sync, no CI on non-default bases). Right for a change that cannot ship half-done; wrong as the only mode.

**Rejected alternative — (c) infer from branch names.** This is the current behaviour and the #3816 bug.

**Research owed before this fork can be ruled** (do not rule it cold):
- Does the repo have a feature-flag mechanism? If not, that strategy waits until one exists.
- Prior art: trunk-based development / DORA, branch by abstraction and expand/contract, stacked-PR tooling,
  how GitHub-style closing keywords (`Closes` vs `Refs`) model "finished".
- Where the preference config lives, and how it interacts with `deliveryTarget`.
- How the agent's choice is recorded, and whether the drain refuses a card with no declared strategy.
- The measured share of cards that are sliced, and how many `## Slice ` headings exist without child cards.

**Interim safety net.** Until this fork is built, #3820's narrow rule stands: the drain never auto-resolves a
card that has a `## Slice ` heading.

## What was checked and found NOT to already exist

A backlog grep specifically for prior coverage of this decision's three questions found no duplicate:
`we:backlog/1869-parallel-execute-orchestrator-landed-on-main-directly-and-fa.md` (the parallel-execute
integration-defect fix) and `we:backlog/2334-workflow-auto-selects-serial-vs-parallel-and-mixes-per-batch.md`
(adaptive serial/parallel mode selection, resolved) both operate at ITEM granularity only, never sub-item;
`we:backlog/3464-a-long-lived-diverged-prototype-branch-has-no-reconciliation.md` (the branch-drift
reconciliation cadence) treats a long-lived branch's drift as a mechanical hygiene problem, never proposes
it as a deliberate multi-agent coordination primitive; no existing item names "micro-task splitting,"
"splittability analysis," or "work committee" for scope-overlap coordination in this sense.
`we:skills-src/split-backlog-item/SKILL.md` splits a story into separate CARDS only (Fork 3 above is the
extension this decision proposes, not a restatement of it).

## External prior art (agentic/multi-agent delivery orchestration)

**Task decomposition granularity is a known, unresolved tension in agentic coding systems generally, not
unique to this repo.** Planner/executor patterns (a single planning pass fans work out to N executor
agents — the shape CrewAI's `hierarchical` process and MetaGPT's role-based SOP decomposition both use)
consistently report the SAME two failure modes this research's Forks 2/3 independently derived from this
repo's own evidence: (a) splitting along file boundaries alone under-detects semantic coupling between
pieces (interfaces, shared types, ordering assumptions) — the exact gap Fork 2 names; (b) decomposition
overhead (planning + integration cost) does not scale down gracefully for small tasks, so naive systems
that always decompose pay a tax that exceeds the work being split — the exact reasoning behind Fork 3's
size-floor gate. Neither failure mode is repo-specific; they are structural to fan-out/fan-in agent
orchestration, which is why Forks 2 and 3 above build explicit gates against them rather than assuming
splitting is free once file-disjointness is proven.

**Trunk-based development literature is consistently skeptical of long-lived shared branches for exactly
the reason `#3464` demonstrates first-party.** The core argument (small, frequent, independently-integrated
changes beat a shared branch accumulating multiple contributors' unmerged work) is not a stylistic
preference in that literature — it is argued on the same drift-compounds-over-time mechanism this repo's
own incident exhibited. This is independent, external confirmation of Fork 4's recommended default (serial/
disjoint as the default posture, shared-branch as a deliberately time-boxed exception) rather than a novel
conclusion this research reached alone.

## Notes

(1) This item does not itself change any code. Ratifying it authorizes follow-on build work, which per this
repo's own build-strategy convention should land as separately reviewable pieces — Fork 3's third-verdict
extension to `we:skills-src/split-backlog-item/SKILL.md` first (it is the gate everything else depends on),
then Fork 1's sub-brief dispatch wiring, then Fork 2's interface-stability check (likely folds into Fork
3's investigation pass rather than shipping as a separate mechanism), with Fork 4's shared-branch escalation
last and smallest — it is the one genuinely new mechanism and the one this research recommends the
narrowest, most cautiously-gated rollout for.

(2) Every fork above is stated with a recommended default AND named alternatives, per the operator's
explicit instruction not to file this as one picked technique. The confidence levels are deliberately
mixed (medium/high/medium/medium) rather than uniformly high — this reflects genuine remaining uncertainty
in the SPECIFIC tuning knobs (size floors, tick thresholds, file-count ceilings) even where the DIRECTION of
each default is well-grounded in this repo's own recorded history. Those knobs are named as knobs, not
silently hardcoded, so the eventual `/next decision` ratification can adjust them without reopening the
forks themselves.
