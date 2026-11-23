---
bornAs: xljqux3
kind: decision
parent: "2445"
size: 3
status: resolved
reopenedReason: "resolved-not-closed-so-2469-blockedBy-stays-valid"
dateReopened: "2026-11-23"
priority: low
dateOpened: "2026-07-11"
dateResolved: "2026-11-23"
graduatedTo: 5488
codifiedIn: docs/agent/platform-decisions.md#devtools-placement
preparedDate: "2026-07-28"
researchTopic: delivery-coordinator-placement
relatedReport: reports/2026-07-12-delivery-coordinator-placement.md
tags: [plateau-loop, constellation, placement]
---

# Where does Plateau Loop live — plateau-app module, own repo, or product line inside Plateau

Constellation placement for the coordinator: inside plateau-app (a `tools/` sibling of the
dev-panel), a fourth constellation repo, or the core of the Plateau product itself. Weighs the
repo-constellation rules (WE zero-impl), multi-project registry needs, and later SaaS packaging.

## Digest

The parent epic ([#2445](/backlog/2445-plateau-loop-extract-the-delivery-machinery-into-a-coordinat/))
extracts the delivery machinery — lane/worktree pool, `pr-land`, the drain, review contracts, the
backlog CLI — into a resident coordinator managing a registry of projects (WE, FUI, plateau-app).
Today that **engine core** is ~4,600 lines of already-repo-parameterized Node under WE's scripts dir
(`we:scripts/merge-ai-prs.mjs` 2448 lines, `we:scripts/pr-land.mjs` 1015, `we:scripts/lane-pool.mjs`
1124), keyed by a hardcoded three-name registry (`CONSTELLATION_REPO_NAMES` at
`we:scripts/merge-ai-prs.mjs:826`; **re-verified 2026-08-15: now 6,776 lines** — `we:scripts/merge-ai-prs.mjs`
4121 / `we:scripts/pr-land.mjs` 1206 / `we:scripts/lane-pool.mjs` 1449 — **still 100% single-sourced in
`we:scripts/`**, the registry constant unchanged in content and now at `we:scripts/merge-ai-prs.mjs:1736`;
growth only sharpens the statute violation below, it does not change the shape of the call). **WE holds
zero implementation by statute
([#constellation-placement](../docs/agent/platform-decisions.md#constellation-placement) rule 1, #1282),
so the engine cannot stay in WE** — that is the forced invariant, not a live option.

Two pieces move on different tests, and keeping them separate is what un-tangles this call:

- **The operator-facing console** (the `plateau:tools/dev-panel/drain-daemon.html` surface + its
  observability) is a human-run *inspect/operate* surface, which
  [#devtools-placement](../docs/agent/platform-decisions.md#devtools-placement) (#1565/#1579) routes
  to **plateau-app** — and it is *already there*. This is not in dispute.
- **The engine core** (lane pool + drain + PR-lander) is *shared infrastructure reusable against every
  constellation repo* — the question the single fork below decides.

There is **one real fork** (the engine core's canonical home); the migration *timing* is not a second
fork — with cost removed it collapses to "when do we pay the move," pure prioritization — so it is folded
into the recommended default as a **staged rollout with a named trigger**, not ratified separately.

## For the ratifying human — the two things to weigh (2026-08-15)

This item is fully researched; what's left is a genuine either/or, not a research gap, so it is **not**
auto-ratifiable (the fork-existence test names two coherent branches, (a) and (b) — see Fork 1) and
needs your explicit ratify/override. There are **two** independent judgments, not one — the bullets below
each name a distinct route to (a):

1. **The interpretive call:** do you read
   [#reusable-neutral-home](../docs/agent/platform-decisions.md#reusable-neutral-home) (#1788) by its
   letter (it names *plateau* as the neutral home → (a)), or by its principle ("the member that is not
   itself coordinated" → (b), because plateau-app *is* a coordinated subject of this engine)?
2. **The risk-tolerance call:** independent of how you read #1788, do you judge the coordinated-subject
   coupling (plateau-app hosting the engine that also lands its own PRs) an acceptable version-lock risk,
   or does the prior-art survey's warning (no bors/Prow/Zuul-class coordinator lives inside a repo it
   coordinates) tip you to (b) regardless of the text question?

Everything else in this item — the prior-art survey, the skeptic pass, the statute reconciliation, the
staged rollout mechanics — is downstream of these two judgments, not of either one alone.

- **Ratify (b) as written** (own repo, staged, graduation triggers below) — the prepared default, and
  the one the skeptic/screen passes survived. Also amends #1788 as drafted in *Statute reconciliation*.
- **Override to (a)** (plateau-app permanent) — valid if you judge the coordinated-subject coupling
  tolerable, or prefer #1788's letter over its principle. Cheaper today, accepts the version-lock risk
  the prior-art survey flags (no coordinator in the bors/Prow/Zuul survey lives inside a repo it
  coordinates).

Both are real; this call does not resolve on more research.

## Un-defer (2026-07-28)

The 2026-07-11 operator defer set the un-defer trigger as *"[#2449](/backlog/2449-ship-the-phase-1-resident-drain-daemon-merge-queue-only/)'s
operating evidence"*, reviewed under
[#2456](/backlog/2456-review-the-drain-daemon-s-first-weeks-of-operating-evidence/).
That evidence now exists — **and its shape matters, read precisely.** #2456's interim review (26.1 h /
633 passes) reports the extraction grew **+2137 lines across 8 commits, all observability**, landing in
**plateau-app** while **the drain core stayed single-sourced in `we:scripts/`**. So the window shows
**the console/observability wanting to live in plateau-app** (confirming the split above) and that **the
extraction wants to grow at all** (validating the #2445 thesis) — it does **not** measure where the
*engine core* belongs, because the core did not move in that window. The core's canonical home is
therefore settled by the statute + prior-art survey below, not by this operating window.

**Scope note (honest):** #2456 also says its multi-week *unattended-autonomy* gate is **not** met and
explicitly blocks preparing **[#2444](/backlog/2444-decide-the-phase-1-agent-runner-the-runner-that-spawns-and-s/)**
(the agent-runner) until it is. That gate governs #2444's runtime-stability question, **not** placement.
Preparing #2446 does **not** un-defer #2444.

## Fork 1 — What is the extracted engine core's canonical home?

<!-- glance table -->

| Option | Canonical home | Verdict |
|--------|----------------|---------|
| (a) | plateau-app `tools/` module (permanent) | rejected — coordinated-subject coupling |
| **(b)** | **own fourth repo, reached via a staged rollout** | **default** |
| (c) | core of the Plateau product | rejected — severable, → #554 |

*Fork exists because:* the engine core's canonical home is exactly one repo — (a), (b), (c) genuinely
cannot coexist, a real either/or. The **excluded** branch is "stay in `we:scripts/`":
[#constellation-placement](../docs/agent/platform-decisions.md#constellation-placement) rule 1 (#1282)
forbids WE hosting delivery runtime, so staying-in-WE is broken, not an option.

- **(a) plateau-app module, as the permanent home** — cheapest, and it is where the phase-1 daemon and
  console already sit. **Rejected as the *canonical* home** on two grounds the prior-art survey and
  statute make dispositive: (1) the engine coordinates **plateau-app itself** (one of its three
  registry members), so hosting it there makes plateau-app both **host and coordinated subject** — its
  release cadence would gate a coordinator that also lands WE and FUI, the version-lock the survey's
  "a coordinator spanning N repos structurally cannot version-lock with any one of them" line warns
  against; (2) **no** coordinator in the survey (bors → rust-lang/bors, Prow → kubernetes-sigs/prow,
  Zuul) lives inside a product repo it coordinates. plateau-app remains the right home for the
  **console** (a per-consumer operator surface), not the engine.
- **(b) own fourth repo, reached staged** *(default)* — the neutral home that is **not itself a
  coordinated subject**: the clean self-hosting story (the Loop lands its own PR, redeploys, resumes
  from persisted state — a solved non-problem: bors-ng / Prow-Tide / Zuul all land into their own
  source and decouple the deployed instance from the tree) and clean SaaS packaging. **Rolled out
  staged**, not paid now (the trigger below) — so its costs (a new constellation member: CI, drain/PR
  transport parity [#2241](/backlog/2241-constellation-ci-pr-merge-parity-bring-frontierui-plateau-ap/),
  one more pool checkout; and the statute amendments below) land only when a real requirement forces
  them.
- **(c) core of the Plateau product** — "Plateau Loop" as a product line. **Rejected**: every
  productized coordinator (GitHub merge queue, Mergify, Graphite) was *born* standalone as a business
  commitment, never grown from an internal module, and homu.io shows the product bet dies without a
  committed operator. Productization is severable from placement and belongs to the parked hosted-suite
  trigger ([#554](/backlog/554-plateau-hosted-saas-product-suite-shell-multi-product-accoun/)). Weigh
  SaaS lightly here (the 2026-07-11 red-team's instruction).

**Default: (b) own repo as the canonical home, reached via a staged rollout.** The engine core is
shared infra reusable across all three repos; its neutral home is the one repo that is not itself a
coordinated subject. Staging keeps it cheap now (see below). The honest tension the decider resolves:
the **letter** of [#reusable-neutral-home](../docs/agent/platform-decisions.md#reusable-neutral-home)
names *plateau* as the neutral home, but its **principle** ("reusable against every implementer →
neutral home; fix the surface, not the home — never relocate shared infra to satisfy a single
consumer") points at the own repo *here*, because plateau-app is a coordinated subject of this tool and
so is not neutral relative to it (see the statute reconciliation below). A decider who reads #1788
literally, or who judges the coordinated-subject coupling tolerable, can override to (a).

Skeptic: SURVIVES-WITH-AMENDMENT (default flipped (a)→(b) during prep). The pass-4 skeptic landed
three hits, all folded in: (1) **statute-overlap** — it found the **uncited** #1788 collision; the
original (a)-default's "collides with no anchor" claim was false and is withdrawn (reconciled below).
(2) **citation-scope** — #devtools-placement was authored for human *inspect/switch/explore/configure*
surfaces (its own examples: dev-panel, explorer chrome, configurators), which **reach the console but
not an autonomous merge daemon**; the citation is downgraded to authority over the *console* only.
(3) **merit/evidence** — the +2137-line growth measured the console, not the engine core (corrected in
Un-defer above). The residual attack (b) beat: own-repo's real costs are deferred by staging, so the
flip does not pay a premature migration.

Screen: flagged(prio) → fixed. The pass-5 fresh-context screen cleared the home fork on both questions
(no impl-detail smuggled onto the standard side; a real merit difference — coordinated-subject coupling
vs an independent lifecycle — survives even free-to-maintain) but flagged the **old separate now-vs-
staged fork as prioritization in fork costume** (with cost removed it is pure timing). Fix applied: that
fork is **dissolved**; staging is folded into the (b) default's rollout as the trigger-criteria, not a
ratifiable binary.

## Staged rollout — the default's mechanism (not a separate fork)

The engine core stays co-located with the console in plateau-app **now** (the operator's without-
prejudice phase-1 start), and graduates to its own repo **on the first trigger to fire**. This is the
*dynamics* reading of the survey (Prow ran ~8 years inside `kubernetes/test-infra` — a repo it itself
coordinated — and split only when external orgs adopted it; Zuul likewise) and the standing
most-flexible-default house rule ("ship the cheapest correct mechanism now; the richer mode is opt-in
later"). Graduation triggers:

- (i) a **fourth** coordinated repo joins the registry — the engine then serves >1 product and cannot
  version-lock with any one; **or**
- (ii) an **external adopter / SaaS commitment** lands (the #554 trigger fires); **or**
- (iii) **proactive co-tenancy guard** — graduate the moment the engine's CI / release needs *diverge*
  from plateau-app's, **before** a co-tenancy incident, not after. (Sharpened from a reactive
  "wait for an incident" trigger per the skeptic: for merge/release infra the incident that would fire
  a reactive trigger *is a corrupted release* — the wrong risk posture for the one system whose job is
  to land code safely.)

**Cost note the timing carries (skeptic-corrected):** staging is *not* free relative to own-repo-now.
Gate-self re-anchoring ([#2448](/backlog/2448-re-anchor-the-gate-self-trust-chain-when-the-delivery-engine/):
the trust-chain path literals that guard the `review:human` invariant) is paid **at each hop** the core
moves — so a WE→plateau-app→own-repo staged path re-anchors more than once, where own-repo-now pays it
once. This is bounded and mechanical and does **not** flip the default (the 8-year in-repo precedent
outweighs it), but it is a genuine timing cost, not a fork-neutral one.

## Statute reconciliation (required — this decision sets `codifiedIn`)

The (b) default writes a rule on turf **two** existing anchors already govern by different tests; both
are reconciled here so ratification inherits no unresolved conflict:

- [#reusable-neutral-home](../docs/agent/platform-decisions.md#reusable-neutral-home) (#1788) — "reusable
  against every implementer → the neutral home; the per-implementer piece is the **thin adapter**, never
  the generic engine." **Composition:** the two rules agree once the console/engine split is applied —
  the **engine core** is the generic shared infra → neutral home (the own repo, which is not a
  coordinated subject); the **console** is the per-consumer thin surface → plateau-app. #1788's example
  says "(plateau)" because in its authoring context (the conformance runner) plateau is a *non-subject*;
  here plateau-app *is* a coordinated subject, so a (b) ruling must **amend #1788** to record that the
  neutral home is "the member that is not itself coordinated," which for a delivery coordinator is the
  own repo, not plateau.
- [#devtools-placement](../docs/agent/platform-decisions.md#devtools-placement) (#1565/#1579) —
  **unchanged and honored**: it keeps routing the *console* to plateau-app. It simply does not reach the
  autonomous engine (citation-scope, above).

An own-repo *ruling* (when a trigger fires) additionally needs vocabulary amendments to
[#constellation-placement](../docs/agent/platform-decisions.md#constellation-placement) and
[#pool-siblings-real-built-clones](../docs/agent/platform-decisions.md#pool-siblings-real-built-clones)
(the latter hardcodes `frontierui`/`plateau-app` as the pool siblings), and must fold in
[#1747](/backlog/1747-decide-the-plateau-explorer-product-surface-to-fui-explorer-/)
(the whole explorer engine relocated *into* plateau-app — the nearest in-kind precedent). This decision
sets `codifiedIn` to the [#devtools-placement](../docs/agent/platform-decisions.md#devtools-placement)
anchor (the standing home of this turf) and records the #1788 amendment above.

## What physically moves (grounding the placement)

- **Now (staged interim):** the engine core graduates from `we:scripts/` into `plateau:tools/` beside
  the existing `plateau:tools/drain-daemon/`; `CONSTELLATION_REPO_NAMES`
  (`we:scripts/merge-ai-prs.mjs:1736`, re-verified 2026-08-15) is unchanged; the pool `siblingClone*`
  resolution (`we:scripts/merge-ai-prs.mjs:1804`, re-verified 2026-08-15) keeps its current
  `frontierui`/`plateau-app` shape.
- **On graduation (own repo):** adds a fourth name to `CONSTELLATION_REPO_NAMES`, provisions a fourth
  pool clone, and edits the anchors named in the reconciliation — the concrete diff staging defers.

### Review jury (provisional — pre-registered #2638)

Care level: `high` (statute-touching + cross-repo delivery machinery). This jury binds against the
item's predicted scope (`we:scripts/merge-ai-prs.mjs`, `we:scripts/pr-land.mjs`,
`we:scripts/lane-pool.mjs`, `we:docs/agent/platform-decisions.md`, `plateau:tools/drain-daemon/`) and
is re-checked against the real diff at PR open.

| juror | lens | grounding method | pre-registered expectation |
| --- | --- | --- | --- |
| correctness#1 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| correctness#2 | correctness | static-review | The change does what the spec says with no behaviour regression — every changed branch is exercised, and no test is missing, weakened, or gamed to pass while the behaviour is wrong. |
| security#1 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| security#2 | security | static-review | No untrusted input, secret, auth, or file/network path is left unguarded and the trust boundary is not widened — anything touching those earns an explicit security check. |
| simplicity#1 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| simplicity#2 | simplicity | static-review | The change is the smallest one that solves the problem — it reuses what already exists and adds no dead code or needless abstraction. |
| standards-conformance#1 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |
| standards-conformance#2 | standards-conformance | static-review | The change follows this repo's conventions and platform-native defaults, and does not diverge from a ratified standard or placement rule. |

## Re-verified (2026-08-15) — still current, cost of waiting is rising

Walked the live tree and open-item state against every load-bearing claim above; nothing has gone
stale, and the un-ratified wait is getting more expensive, not less:

- **Engine core, re-measured:** 6,776 lines (up from ~4,600 at prep — see the Digest correction above),
  still 100% in `we:scripts/`, still keyed by the same 3-name `CONSTELLATION_REPO_NAMES`. The statute
  violation the fork exists to resolve has only grown.
- **None of the three staged-rollout graduation triggers has fired:** (i) registry is still exactly
  `web-everything`/`frontierui`/`plateau-app` — no fourth repo; (ii) [#554](/backlog/554-plateau-hosted-saas-product-suite-shell-multi-product-accoun/)
  (the SaaS/external-adopter trigger) is still `status: open`, unstarted; (iii) no reported CI/release
  divergence between the engine and plateau-app. The staged interim (co-located, cheap) is still the
  correct place to be *today* — this does not change the Fork 1 call, it confirms the rollout's timing
  logic is holding.
- **[#2448](/backlog/2448-re-anchor-the-gate-self-trust-chain-when-the-delivery-engine/)
  (gate-self re-anchoring) is now `status: resolved`** — the first-hop migration cost the *Cost note*
  above warns about is already substantially de-risked.
- **The sibling deferred decision, [#2444](/backlog/2444-plateau-loop-phase-1-agent-runner-shape-cli-spawn-contract-s/)
  (agent runner), ratified 2026-07-16** — but via an *independent, item-specific* trigger, not because
  #2456's gate was met or waived generally: #2444's own "Un-deferred + prepared" note records that
  [#2530](/backlog/2530-build-endpoint-supervised-builder-post-api-backlog-build-dra/) (the supervised
  builder) gave it a consumer, and that the daemon's operating evidence "would not shape this contract
  anyway." **This is corrected from an earlier draft of this section, which overclaimed #2444's
  ratification as general confirmation that the epic's decisions don't need #2456's gate — that is false**:
  sibling [#2472](/backlog/2472-plateau-loop-multi-project-registry-manage-we-frontier-ui-an/) (multi-project
  registry) remains, as of this re-verification, explicitly "Deferred behind the phase-1 evidence gate
  (#2456)" in its own text, and [#2469](/backlog/2469-plateau-loop-rewrite-the-parallel-orchestrator-as-plain-node/)'s
  2026-08-15 finding independently confirms that gate is still live for #2472. #2444 is the exception (its
  own independent trigger fired), not the rule. This item's own case for not waiting on #2456 rests on the
  *Un-defer* section's argument above (the engine core's canonical home is settled by statute + the
  prior-art survey, not by the operating window measuring the console) — **not** on #2444's precedent, and
  the *Scope note (honest)* above stands uncontradicted: #2456 still blocks #2444-class runtime-stability
  questions on its own multi-week gate; it simply turned out not to be the only path to un-defer #2444.
- **Rising cost of inaction:** epic [#2445](/backlog/2445-plateau-loop-extract-the-delivery-machinery-into-a-coordinat/)
  currently carries **14 open children** (excluding this item). Of those, **3 directly reference this
  decision** in their own text or `blockedBy` — [#2469](/backlog/2469-plateau-loop-rewrite-the-parallel-orchestrator-as-plain-node/)
  (`blockedBy: ["2446"]`), [#2465](/backlog/2465-plateau-loop-config-over-convention-gating-review-drain-mode/),
  and [#2456](/backlog/2456-review-the-drain-daemon-s-first-weeks-of-operating-evidence/) — while the
  remaining 11 (including #2472, which cites #2456 rather than #2446 directly) are blocked **transitively
  via the epic**: #2445's own "Phase 1 re-scoped" section defers agent spawning, steering, UI, and the
  multi-project registry until both the runner decision (#2444) and the placement decision (#2446)
  resolve, so the queue behind the epic waits on this call even where an individual child's text does not
  name #2446. [#2469](/backlog/2469-plateau-loop-rewrite-the-parallel-orchestrator-as-plain-node/)'s own
  2026-08-15 preparation finding independently re-derived the same wall this item already names in
  *Delegation* below — a fresh, un-primed session hit "the actual content here is exactly what #2446
  was opened to answer" on its own, which is corroboration, not new information (it does not change
  either fork branch). Ratifying this item is what unblocks that queue; leaving it un-ratified is the
  status quo cost, not a neutral hold.

## #2456 closing evidence (2026-09-18) — the operating window is in

[#2456](/backlog/2456-review-the-drain-daemon-s-first-weeks-of-operating-evidence/)'s closing review
(~67 days, 62,008 passes, 1,605 merges) is the multi-week evidence the 2026-07-11 defer was waiting for. It
leaves Fork 1 unchanged and raises the cost of waiting:

- **The co-located interim works in practice.** The daemon/console ran as a plateau-app `tools/` module for 9
  weeks, 405 h of it continuously, with no placement-caused friction. Its own code has **stopped growing** (+995
  lines in ~9 weeks, after the +2,137 day-1 burst).
- **The engine core keeps growing in WE:** 6,776 → **7,931 lines** since the 2026-08-15 re-measure above, still
  keyed by the same 3-name `CONSTELLATION_REPO_NAMES`. The statute violation this decision resolves grows by
  about 1,150 lines a month while the decision waits.
- **No graduation trigger is visible** in the evidence: no fourth repo, and no engine/plateau-app CI divergence.
  The staged default's timing logic still holds.

This is the evidence side of the ratification. The operating window neither argues for a separate repo nor
for waiting longer.

## Delegation

Neither the fork nor the staged rollout carves a new buildable child — the actual extraction/move is
already epic
[#2445](/backlog/2445-plateau-loop-extract-the-delivery-machinery-into-a-coordinat/)'s
in-flight slice work (e.g. the orchestrator-as-Node-fanout #2469, the multi-project registry #2472).
This decision only *authorizes the canonical home + rollout*; the move rides those existing items.

Related priors: #1565 (devtool placement), #1579 (dev-panel relocation), #1747 (explorer engine
relocated into plateau-app), #2241 (constellation transport parity), #2448 (gate-self re-anchoring),
#554 (hosted-suite / SaaS trigger), #1788 (reusable → neutral home), and the
[delivery-coordinator-placement](/research/delivery-coordinator-placement/) research topic.

Resolved 2026-11-22 (PL-2446): overtaken by #5488 (resolved, not closed, so #2469's blockedBy edge on this card stays valid). The constellation split (#5488, #5484) and the existing plateau-ops repo already answer where Plateau Loop lives, so the placement record now lives on #5488.
