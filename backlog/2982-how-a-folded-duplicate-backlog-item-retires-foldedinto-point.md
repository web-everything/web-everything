---
bornAs: xm3vnk8
kind: decision
status: resolved
dateOpened: "2026-08-06"
dateResolved: "2026-10-13"
graduatedTo: none
codifiedIn: "docs/agent/backlog-workflow.md#closed-not-built"
preparedDate: "2026-08-17"
relatedTo: ["2983"]
relatedReport: reports/2026-08-17-2982-folded-duplicate-retirement.md
tags: [backlog, schema, burndown, lifecycle, decision-prep]
---

# How a folded-duplicate backlog item retires — foldedInto pointer vs cross-ref only

When `/consolidate` (#2983) proves two open items are one job, the backlog has **no honest way to retire the
absorbed one** — `resolve` means *delivered* and books points, a park needs a real structural gate, and
`supersededBy` points at research topics. Prep surveyed five trackers: **all five retire a duplicate with a
non-delivered close plus a pointer to the survivor; none leaves it open with only a cross-reference.** Two
forks follow — whether a proven-contained duplicate leaves the open set, and whether the marker is a new
`status` value or a field on an item that stays `open`.

## Ruling — 2026-10-13, ratified and widened

**Operator (Nicolas Gilbert), 2026-10-13 ~10:00 ET, verbatim: "yes to all"**, given in reply to this option:

> (b) Widen [card 2982] into one general 'closed, not built' state with a reason (duplicate / fixed elsewhere /
> obsolete / won't do) and a pointer where one exists. It never counts as delivered and can be reopened. This
> works like GitHub's 'closed as not planned'.

- **Fork 1 → (a)**, retire non-delivered. **Fork 2 → (a)**, a new status value plus a pointer field.
- **Widened beyond duplicates.** The status is the general `closed`, not `folded`. Fields: `closedReason`
  (`duplicate` | `fixed-elsewhere` | `obsolete` | `wont-do`), `closedInto` (the survivor, required for a
  duplicate), `closedBy` (the fixing commit or PR, for fixed-elsewhere, where one exists), `dateClosed`.
- **Never delivered:** no burndown points, no throughput, ignored by batch calibration. **Reversible:**
  `reopen-items` is the inverse of `close-items` and ships with it, as the *Supported by default* section
  required.
- **Codified in** [we:docs/agent/backlog-workflow.md#closed-not-built](docs/agent/backlog-workflow.md#closed-not-built).
  The statute file delegates backlog lifecycle to that doc (*Statute-overlap check* below), so no new
  statute anchor is minted.
- The same reply approved bulk-clearing the backlog by triage category (56 duplicates, 58 already-fixed,
  2 obsolete, 473 low-value; 370 kept). That apply is a separate operator step after this lands, through the
  dry-run-first `close-items` operation.

## Why there is nothing to reach for today

- **`resolve` is the only close, and it means *delivered*.** A resolved item's `batchCost` feeds the
  burndown and the batch calibration `--points` figure (*[we:docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md)
  → Calibrating the budget*). The burndown's one delivered key is
  `it.status === 'resolved' && it.dateResolved` (`we:src/_data/burndown.js:32`). Resolving a never-built
  duplicate books points nobody earned and skews every future batch budget — so this branch is **broken on
  merit**, not merely unattractive.
- **A park can't carry it.** `parkedReason: superseded` was deliberately retired in the 2026-06-22 sweep
  (`we:src/_data/backlogMeta.js:23-34` → `parkedReasonMeta`; commit `f202a7f3`, driven by #1392/#1620): a park
  must reduce to a real structural gate (`blockedBy`, `humanGate`, `platform-gated`, `maturityGated`), and
  "another item already covers this" is none of those. `check:standards` hard-errors on a parked item with no
  such reason (`we:scripts/check-standards-rules.mjs:207-214`).
- **`supersededBy` exists, but not for backlog items.** It is a research-topic / standards-home pointer
  (`we:scripts/check-standards.mjs:130`, `:263-286`, `:385-417`) — its pointer space is topic ids and
  reference-home ids, not backlog ids.
- **The standing dedup rule is *not* the counterweight this item first claimed.** *Review before adding
  (dedup)* (`we:docs/agent/backlog-workflow.md:971`) says that if an item already covers the idea you should
  **extend it**, and reserves *cross-reference instead of merging* for **parallel tracks that look similar but
  are distinct**. It governs the *adjacent* case, not the *contained* one. Corrected in prep — the original
  framing overstated the tension, which materially weakened Fork 1 (b).

## Prior art — the survey that grounds both forks

Report `we:reports/2026-08-17-2982-folded-duplicate-retirement.md`; research topic
[`/research/folded-duplicate-backlog-retirement/`](/research/folded-duplicate-backlog-retirement/).

| Tracker | Terminal state for a duplicate | Pointer to the survivor | Delivered? |
| --- | --- | --- | --- |
| Bugzilla | `RESOLVED` + resolution `DUPLICATE` | `dupe_of` — a first-class bug-id **field** | No |
| Jira | Closed + Resolution `Duplicate` | a separate `duplicates` **link type** | No — routinely filtered out of reports/epic progress |
| GitHub Issues | closed with `state_reason: duplicate` (a *third* close reason, added Dec 2024) | timeline event + a note at the top of the issue | No — distinct from `completed` |
| GitLab | closed via `/duplicate #id` | a duplicate-of relation | No |
| Linear | the reserved `Duplicate` status, whose **type is Canceled**, not Done | a relation; attachments migrate to the survivor | No |

Three findings carry into the forks:

1. **The non-delivered close is universal — 5/5.** "Stay in the working state with a cross-ref" is **0/5**,
   in five systems that otherwise disagree about nearly everything in their lifecycle models. Every one
   changes the item's **base state** as well as marking why.
2. **The reason is a positive marker paired with a *separate* pointer — 4/5.** Nobody encodes the survivor
   inside the enum; nobody infers "closed as duplicate" from a relation's mere presence. (GitLab is the sole
   exception, and is also the one with the long-running complaint below.) Two of the four carry the marker
   **substitutively** (Bugzilla's resolution, Linear's reserved status) and two **additively** on top of an
   already-changed base state (Jira's Resolution on Closed, GitHub's `state_reason` on closed) — so the
   survey settles the *base-state change*, not the marker's storage shape.
3. **The one recorded defect is irreversibility.** GitLab's `/duplicate` has no inverse —
   `gitlab-org/gitlab#233050` has been open for years asking for `/remove_duplicate`; once marked, an
   accidental fold is permanent. That is the "over-eager fold silently removes work" risk, observed in a
   shipped system.

**Scope of this survey's authority (citation-scope, #1932).** None of the five trackers has anything
resembling this repo's readiness ranker or its batch point-budget, so the survey is **supporting context —
industry convergence that a proven duplicate should not stay in the working set — not authority** over the
specific cost/benefit here. The load-bearing merit arguments below are the repo-internal ones (burndown
honesty and ranker cleanliness); the survey corroborates them and does not carry them.

## At a glance

| Fork | The call | Options | Recommended default |
| --- | --- | --- | --- |
| **1** | Does a proven-contained duplicate leave the open set? | (a) retire it non-delivered · (b) it stays open, cross-referenced | **(a)** |
| **2** | What carries the fold on disk? | (a) new `status: folded` + `foldedInto` + `dateFolded` · (b) a `foldedInto:` field on an item that stays `open` · (c) reuse `status: resolved` *(Rejected)* | **(a)** |

## Supported by default — settled, not forks

- **A fold executes only on operator approval.** Settled by precedent, no ruling needed:
  *[we:docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md) → Executing a consolidation — only
  after approval, mechanically* (`:935`) already governs every `/consolidate` mutation, and the skill carries
  the same invariant (`we:skills-src/consolidate-backlog-items/SKILL.md:58`). Whichever way Fork 1 rules, the
  fold inherits that gate — it is not a second axis of judgment. **This gate is what answers the hold model's
  anti-escape-hatch principle** (see *Statute-overlap check*): a fold is not a place to hide work an agent
  didn't want to do, because no agent can execute one unilaterally.
- **A wrong fold is reversible from day one, and `unfold` ships with `fold`.** A backlog item is plain
  committed frontmatter in git, so reversing a mistaken fold is already possible by hand (restore `status`,
  delete the pointer) — the safety net is not future work. On top of that, the fold and unfold CLI paths are
  **one atomic child**, not two rows that could be carved and landed separately (see *Predicted touch-set*);
  an irreversible fold is the one failure mode prior art actually recorded, and it is not on the table under
  either branch.
- **Nothing is deleted, renumbered, or un-rendered.** `NNN` is immutable for life
  (`we:docs/agent/backlog-workflow.md:947`, `:973`) and `we:src/backlog-pages.njk` paginates every item
  status-independently, so a folded card keeps its file, its number, and its detail page under **both**
  branches. There is no audit-trail axis to decide.
- **`crossRef` stays available on the survivor** under both branches — it is already a validated field
  (`we:scripts/check-standards-rules.mjs:229-230`) and adding one is never excluded by a fold.

## Fork 1 — does a proven-contained duplicate leave the open set?

**Fork-existence justification (#819).** A genuine either/or: for one absorbed card the two branches are
mutually exclusive end-states — the item is claimable by the ranker, or it is not. There is no composition
where both hold, and the composability probe fails (a "fold" that leaves the card selectable is just branch
(b) with extra frontmatter). This is case (b) of the standing test — two coherent branches that cannot
coexist. **Two re-routes were tried and both fail:** *extend `parkedReason` instead of minting a new exit* is
still a card leaving the claimable set, so it lands inside (a) as an implementation variant — and the specific
value it would need (`superseded`) was retired on merit in the 2026-06-22 sweep, so this variant reopens a
settled call rather than dodging the fork. *Support both, per-cluster* fails because a single absorbed card
gets exactly one fate; there is no per-consumer knob here and so no `#config-extends-platform-default`
dimension.

- **(a) Retire it non-delivered — a pointer to the survivor plus a close that never books points.**
  *(recommended default)* The absorbed item leaves the open set, disappears from readiness selection, renders
  a muted "folded into #NNN" pill, and is excluded from the burndown entirely — scope *removed*, not scope
  *completed*. `check:standards` validates that the target resolves, that the folded item leaves no children
  or inbound `blockedBy` dangling, and that no fold cycle exists.
  *On merit — the two load-bearing arguments, both repo-internal:* **(i) burndown honesty** — the points of an
  absorbed card are scope *removed*, and excluding them is the only fate that neither books undelivered work
  nor parks it in `remaining` forever (see the code example). **(ii) ranker cleanliness** — the open set is
  what `check:readiness --select` hands to agents as claimable work, so a card nobody will ever work must not
  sit in it. Corroborating, not load-bearing: 5/5 prior art. Secondary: a reader following the old `#NNN` URL
  lands on a pointer to the survivor rather than a stale open card.
  *Cost:* a new exit door to maintain, and an over-eager fold removes real work — bounded by the approval
  gate and the day-one reversibility above, both listed as settled rather than left to a future slice.
- **(b) Cross-ref only — the card stays in the working set.** `/consolidate` records the overlap as a
  `crossRef` on each side and, where one really does gate the other, a `blockedBy` edge.
  *On merit:* `resolved` keeps exactly one meaning, so the burndown needs no second notion of "left the
  backlog"; and a near-duplicate that turns out to differ in a detail stays independently claimable — this
  branch never has to be right about sameness, which is the one judgment (a) can get wrong.
  *Steelman, and why it still fails.* As originally written, (b)'s mechanism was "whoever claims the survivor
  resolves the sibling in the same pass as delivered work" — which **commits the exact burndown falsification
  this item was opened over**, so that version is self-defeating. The strongest (b) drops it: exclude a
  `crossRef`-marked duplicate from the burndown's `sized` set directly, never touching `status`. That repairs
  argument (i) — but it cannot touch (ii). The card is still `status: open`, so `we:scripts/readiness/engine.mjs:177`
  still selects it, `deriveTier` still ranks it, and the ranker keeps offering an agent work that is already
  covered. Repairing *that* means excluding it from selection, which is (a) under another name. ***Rejected***
  as the default.

**The containment bar is part of the default, not a residue.** An over-eager fold silently removes work, so
(a) is recommended **with** a stated bar rather than conditionally: a fold is admissible only when delivering
the survivor **wholly satisfies the absorbed item's acceptance criteria** (scope contained, not merely
adjacent), proven by the existing overlap-investigation pass
(*[we:docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md) → The overlap-investigation pass*,
`:913`) and approved by the operator. A cluster that cannot clear that bar is **not a fold** — it is an
umbrella or a pack, which the three-outcome rubric already handles (`:925-929`). So there is no fallback call
left open: "the rubric wasn't strict enough" resolves to "this cluster isn't a fold", not to a different
ruling.

**Code example — why (b)'s mechanism is the broken part.** The burndown has exactly one delivered key
(`we:src/_data/burndown.js:26-34`), and a sized item enters *scope* purely from `dateOpened`:

```js
const sized = all
  .filter((it) => typeof it.size === 'number' && FIB.has(it.size))
  .map((it) => ({
    num: it.num, size: it.size,
    opened: it.dateOpened ? toUTC(it.dateOpened) : null,
    done: it.status === 'resolved' && it.dateResolved ? toUTC(it.dateResolved) : null,
  }))
  .filter((it) => it.opened != null);
```

So there are only three possible fates for an absorbed sized card, and (b) picks the worst one:
`resolve` it → `done` is stamped and its points are booked as delivered (b's own mechanism); leave it open
forever → its points sit in `remaining` scope permanently; **or exclude it from `sized`** — which is what (a)
does, and is the repo's own `#faithful-derivation-exclude-not-fabricate` rule (*exclude, never fabricate, at a
lossy boundary*) applied to the burndown.

**Skeptic:** SURVIVES-WITH-AMENDMENT — attacked by an independent juror process (`judgeSpawn`, session
`5ca89ad4`, mandate = refute; four axes: classification · merit · statute-overlap · citation-scope). No axis
flipped the default; four amendments were folded in. (0) *Classification*: two re-routes tried
(extend `parkedReason`; support-both) — both fail, and the fork-existence line was rewritten to say why rather
than assert it. (1) *Merit*: the original rebuttal of (b) attacked a strawman — (b) rewritten to its steelman
(burndown exclusion via `crossRef`, no `status` change), which repairs the burndown argument but not the
ranker one; and the reversibility case was corrected — manual reversal is available day one because an item is
plain committed frontmatter, and `fold`/`unfold` are now bound as one atomic child rather than a promise.
(2) *Statute-overlap*: the hold model's **principle** ("parking is never a prioritisation escape") does reach a
fold even though its mechanism does not — now reconciled in the statute table instead of dismissed.
(3) *Citation-scope*: the five-tracker survey was downgraded from authority to supporting context (no surveyed
tracker has this repo's ranker or point budget), and the merit case now leads with the repo-internal burndown
and ranker arguments.

**Screen:** clear — run by a third independent juror process that never saw this session's authoring
(`judgeSpawn`, session `751ed39b`, the two fixed questions only). (1) *Standard-vs-impl*: not applicable and
not committed — this governs the repo's own tracker, which has no cross-repo consumer boundary; the fork rules
on the tracker's own semantics, not on a downstream implementer's territory. (2) *Merit-vs-prioritization*:
merit survives the zero-cost test — under (b), even free and eternally maintained, a covered card stays
selectable by the ranker, and the cost bullets are kept out of the merit case.

## Fork 2 — what carries the fold on disk: a new `status` value, or a field on an open item?

**Fork-existence justification (#819).** `status` holds exactly one value, and the readiness engine keys the
*entire* selection surface off `status === 'open'` (`we:scripts/readiness/engine.mjs:177`). So a card is either
outside that filter (a status value) or inside it and excluded case-by-case (a field) — the two shapes cannot
both be the marker for the same card, and no facade composes them. This fork only exists if Fork 1 rules (a);
under (b) it dissolves.

- **(a) A new `status: folded`, plus a required `foldedInto: "<NNN>"` pointer and a `dateFolded` stamp.**
  *(recommended default)* Note the shape is **base-state change + additive markers**, which is what all four
  marker-carrying trackers do (finding 2) — `status` leaves the working value, and `foldedInto`/`dateFolded`
  are *added* alongside, not substituted for anything.
  *On merit — the load-bearing argument is truthfulness of the data model, and it is cost-independent:* the
  field named `status` is the card's single declared statement of what state it is in. Under (a) that
  statement is **true**: a folded card says `folded`, and every reader — the loader, the gate, a future
  surface, a human opening the file, an external script parsing frontmatter — gets the right answer from the
  one field that claims to hold it. Under (b) the card says `status: open` while not being open in any sense
  that matters, and its real state lives in exclusions scattered across consumers. That is a
  single-source-of-truth defect that survives the zero-cost thought experiment intact: even if every exclusion
  were free to write and eternally maintained, the declared state would still be false, and any *new* reader
  would still start from a wrong premise until someone told it otherwise. **Precedent-consistency, same axis:**
  all five surveyed trackers move the state-carrying field itself (Bugzilla's status→`RESOLVED`, Jira's
  →Closed, GitHub's →closed, GitLab's →closed, Linear's →the Duplicate/Canceled status); **0/5** leave the
  state field on its working value and push the truth into a side channel.
  *Practical consequences (cost, not merit — recorded so the build is scoped, not to justify the default):*
  it is nearly free in the loader — `deriveTier` returns `undefined` for any non-`open` item
  (`we:src/_data/backlog.js:184`) and `we:scripts/readiness/engine.mjs:177` filters the selection to `open`,
  so tier, batchable, sliceable, splittable and the open leverage graph exclude a folded card with **no new
  exclusion code**. Against that, four value-level additions are needed — the status enum
  (`we:scripts/check-standards-rules.mjs:24`), a `statusBadge` branch
  (`we:src/_includes/backlog-badges.njk:41`), the burndown `sized` filter (`we:src/_data/burndown.js:26`), and
  the redirect precedence that currently prefers a non-`resolved` item
  (`we:src/_data/backlogRedirects.js:26-30`) — spread across four independently-owned surfaces, a wider blast
  radius than (b)'s. `dateFolded` mirrors the existing `resolved`-requires-`dateResolved` coherence check
  (`we:scripts/check-standards-rules.mjs:294`).
- **(b) A `foldedInto:` field on an item that stays `status: open`.** The relation is separate from the state.
  *On merit:* the `status` vocabulary stays closed at its current five values, so nothing that already branches
  on `status` can be silently wrong about a value it has never seen — a real composability argument, and the
  mirror image of (a)'s. An unfold is a single field deletion.
  *Against, on merit:* the declared state is false (above), and the "a folded card is never offered as work"
  invariant is re-asserted at ~6 call sites rather than held once by the field that names the state — so
  correctness depends on every present *and future* consumer remembering a rule that isn't expressed in the
  data. It also carries the repo's demonstrated failure mode for exactly this shape: there is **no
  frontmatter-key whitelist** (unknown keys are spread onto the item at `we:src/_data/backlog.js:351`), and
  `relatedTo` (232 items), `relatedItems` and `blocks` already sit on disk as inter-item pointers with **zero
  validation and zero rendering**, whereas an unknown `status` value is rejected outright by
  `we:scripts/check-standards-rules.mjs:189-190`.
  *Against, on cost only (not weighed as merit):* narrower blast radius per change and incremental rollout are
  genuine advantages of (b); they do not offset a false declared state.
  *Not a differentiator (struck in prep):* the CTA invariant (`we:scripts/check-standards.mjs:648-660`) was
  initially cited against (b). It is not a real difference — both branches need exactly one new pill branch,
  (a) in `statusBadge` and (b) in `reasonPill`.
- **(c) Reuse `status: resolved` with a `foldedInto` pointer.** ***Rejected*** — it books the points. This is
  the broken branch the whole item was opened over.

**Code example — the two shapes on the absorbed card.**

Option (a), the recommended shape:

```yaml
# we:backlog/2841-<absorbed-card>.md
kind: story
size: 3
status: folded          # new enum value alongside open|active|preparing|parked|resolved
foldedInto: "2839"      # the survivor; check:standards resolves it and forbids self/cycle
dateFolded: "2026-08-17"
```

Option (b), for contrast — the same fact, but the card is still inside every `status === 'open'` filter, so
each exclusion has to be written and kept in sync:

```yaml
# we:backlog/2841-<absorbed-card>.md
kind: story
size: 3
status: open            # still selectable; every surface must special-case foldedInto
foldedInto: "2839"
```

```js
// and then, at each of ~8 sites, e.g. we:scripts/readiness/engine.mjs:177
const open = items.filter((it) => it.status === 'open' && !it.foldedInto);
```

**Sub-fork — does the pill route through the Status Indicator intent?** Not a separate ruling: the "folded
into #NNN" pill is a **lifecycle state**, and `we:src/_data/protocols/lifecycle.json`'s
`realizesIntent: status-indicator` already assigns status presentation to the Status Indicator intent
(`we:docs/agent/platform-decisions.md:2220-2221`, from the #1319 Status-Indicator / Tag / Notification-Marker
split). So it is a `<we-badge>` `status-indicator` with a neutral tone, not a `<we-tag>` — grounded in the
owning intent rather than invented here. **Scope note:** that anchor is cited here for *presentation only* —
see the `#categorical-taxonomy` row in the statute table for why it does not also govern the enum.

**Skeptic:** SURVIVES-WITH-AMENDMENT — attacked by a second independent juror process (`judgeSpawn`, session
`533cc76c`, mandate = refute), same four axes. No axis flipped the default; four amendments were folded in.
(0) *Classification*: the fork-existence line holds, but the `we:docs/agent/reference-retirement.md`
reconciliation was half-quoted — its **additive-marker** mechanism was dropped because it cuts toward (b).
Rewritten to keep both properties honestly: (a) is *base-state change + additive markers*, so it contradicts
neither. (1) *Merit*: the CTA-invariant bullet against (b) was a false differentiator (both branches need
exactly one pill branch) — **struck**, and (b)'s genuine advantages (narrower blast radius, incremental
rollout) added, leaving the loader-cost argument to carry (a) alone. (2) *Statute-overlap* — **the axis that
bit**: `#categorical-taxonomy` says "the Web Lifecycle protocol owns which status values exist + their
transitions", and this item cited that same anchor for the pill while never testing it against the enum-mint.
Traced: `we:src/_data/protocols/lifecycle.json` is a conformance reference for a *consumer's domain entity*
whose members are explicitly open, so it fixes no closed list and does not reach `BACKLOG_STATUSES`. **No
collision — reconciled in the statute table, and the citation narrowed to presentation.**
(3) *Citation-scope*: `#ci-lifecycle-total-label-function` was cited for (a) but its own shape (an additive
label over a persisting base state) is closer to (b) — **dropped as support**, and its principle noted as
discriminating neither.

**Screen:** flagged(prio) → fixed. The same third juror process (`judgeSpawn`, session `751ed39b`) cleared
question 1 (no cross-repo boundary applies; enum-vs-field is the repo's call about its own data model) but
**flagged question 2**: the fork's case for (a) was self-labelled "the one load-bearing argument: it is nearly
free in the loader … zero new exclusion code" — a build-cost claim presented as merit, which evaporates under
the zero-cost test along with (b)'s "~6 call sites" complaint. **Rewritten before the stamp** to the
cost-independent argument the screen identified: `status` is the card's single declared statement of its own
state, (a) makes that statement true and (b) makes it false while the real state lives in scattered
exclusions — a single-source-of-truth defect that persists at zero cost — corroborated by 5/5 trackers moving
the state-carrying field itself and 0/5 leaving it on its working value. The loader-cost material was demoted
to a *Practical consequences* paragraph explicitly marked "cost, not merit", and (b)'s cost advantages were
recorded there rather than weighed.

## Statute-overlap check (#1886)

The rule this decision would codify: *an item leaves the backlog by exactly one of two doors — delivered
(`resolved`) or withdrawn-into-a-survivor (`folded` + pointer); a non-delivered exit never books points.* An
anchor-by-anchor pass over [we:docs/agent/platform-decisions.md](docs/agent/platform-decisions.md) found
**no anchor governing backlog item retirement** — backlog lifecycle is explicitly delegated to
[we:docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md) by the *"Backlog & decision workflow"*
bullet in the delegation block near the end of the statute file. (Cited by bullet name, not line number: that
block sits below every ratified anchor, so appending a new anchor shifts it — a line ref there goes stale
within days.) Four anchors are adjacent and **compose** rather than collide, and the ruling should cite them:

| Anchor | How it composes |
| --- | --- |
| the **backlog hold model** pointer (the delegation-block bullet naming #1620/#1392, → [we:docs/agent/backlog-workflow.md](docs/agent/backlog-workflow.md) `#hold-model`) | Two tests, not one. Its *mechanism* (a park must reduce to a structural gate) does not reach a fold — that is this item's own "a park can't carry it" argument. But its **principle** does: *"parking is never a prioritisation escape"* is an anti-abuse rule over **any** state that pulls an item out of the claimable set without delivering it, and `folded` has exactly that risk profile. **Reconciled, not dismissed:** the fold answers the principle by construction — it requires a *proven containment* finding plus operator approval (both under *Supported by default*), so it can only be reached by showing the work is already covered, never by an agent deciding it isn't worth doing. Any `codifiedIn` text must say this, or it inherits an unreconciled conflict. |
| `#faithful-derivation-exclude-not-fabricate` | Directly on point for the burndown treatment: exclude the folded item, never fabricate a delivered date. **Authority** — its scope is lossy derivations generally, and the burndown projection is one. |
| `#state-lives-where-its-nature-dictates` | A fold is durable shared repo truth → committed frontmatter (where both Fork 2 options put it). It also explains why the `preparing` retreat (#2219/#2264 replaced `claim --as=preparing` with a local uncommitted hold) is **not** a precedent against a `folded` status: that hold is transient session state, a fold is permanent. |
| `#categorical-taxonomy` (`:2208-2225`) | **Surfaced by prep's skeptic as a possible collision; checked and cleared, with the citation narrowed.** The clause "the Web Lifecycle protocol owns which status values exist + their transitions" governs the **WE standard's** status vocabulary for a *consumer's domain entity* — `we:src/_data/protocols/lifecycle.json` is a conformance reference whose members are explicitly **open** ("a state may be terminal, a transition may be automatic"). It fixes no closed list and says nothing about this repo's own tracker frontmatter, so it does **not** govern `BACKLOG_STATUSES`. What it *does* govern is the **presentation** mapping — which is exactly the narrow use the Fork 2 sub-fork makes of it (status pill → Status Indicator intent, never the categorical token family). Cited for presentation only; not authority over the enum. |
| `#ci-lifecycle-total-label-function` | **Dropped in prep as support for Fork 2 (a).** Its ratified shape is an additive label over a PR that *keeps* its base state — structurally closer to (b) than to (a) — so citing it for (a) reversed its own analogy. Its abstract principle (*state is a positively-applied marker, never inferred from an absence*) is satisfied by **both** Fork 2 options, so it discriminates nothing here. |

**Sibling convention to reconcile, not overrule:** `we:docs/agent/reference-retirement.md` (#584) is a ratified
retirement convention whose stated ambition is uniformity ("the homes differ in *container*, not in the
retirement *concept*"), and it explicitly rejects an enum — "two markers, not one `status` enum — an enum is
mutually exclusive and so can't represent the 'dead and superseded' case" (`:15-17`). Two properties, read
honestly rather than half-quoted (prep's skeptic caught the half-quote):

1. **Its co-occurrence rationale is scope-bound and does not reach here.** The enum objection exists because a
   reference can be *both* dead *and* superseded. A backlog item cannot be both *delivered* and *folded* —
   those are genuinely exclusive — so the reason for the rule is absent in this home.
2. **Its additive-marker mechanism *does* carry over, and Fork 2 (a) honours it.** `retired: true` is added
   alongside an entry's existing classification. The analogue is `foldedInto` + `dateFolded`, which are
   likewise **added**, not substituted. The `status` change is a separate fact — the base-state move every
   surveyed tracker also makes (finding 2) — not a repurposing of the marker slot. So (a) is
   *base-state change + additive markers*, which contradicts neither property.

Any codification should state both points, so the two conventions read as composed rather than contradictory.

## Predicted touch-set (#2619) — and the children it seeds

Coarse, repo-qualified, prefix-shaped prediction of the work this decision authorizes. It feeds the jury
charter below, and each buildable child carved after ratification takes only **its own slice** (never the whole
set — identical scopes would serialize the children):

| Child (after ratification) | `scope:` slice |
| --- | --- |
| Schema + gate: the `folded` status value, the `foldedInto`/`dateFolded` validators, target-resolves / no-dangling-children / no-cycle checks | `we:scripts/check-standards-rules.mjs`, `we:scripts/check-standards.mjs` |
| Loader + render: burndown exclusion, redirect precedence, the muted status pill | `we:src/_data/burndown.js`, `we:src/_data/backlogRedirects.js`, `we:src/_data/backlogMeta.js`, `we:src/_includes/backlog-badges.njk` |
| CLI: a `fold <NNN> --into=<NNN>` command **and its inverse `unfold <NNN>` — one atomic child, never carved apart** (an irreversible fold is the one failure mode prior art recorded) | `we:scripts/backlog.mjs` |
| Doc + skill: lift the "report only, no mutation" hold on the fold outcome | `we:docs/agent/backlog-workflow.md`, `we:skills-src/consolidate-backlog-items/SKILL.md` |

### Review jury (provisional — pre-registered #2638)

Care level: `high` — the authorized work touches the gate itself (`we:scripts/check-standards.mjs`) and the
workflow doc that [we:docs/agent/platform-decisions.md](docs/agent/platform-decisions.md) delegates backlog
lifecycle to. The touch-set above was fed as the charter's `changedFiles`; it includes a rendered surface
(`we:src/_includes/backlog-badges.njk`), which is why the a11y / visual / perf seats are present. This jury
binds against the item's predicted scope and is re-checked against the real diff at PR open.

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
| a11y#1 | a11y | axe-scan | The rendered UI passes an accessibility scan and stays keyboard-reachable with correct roles and labels — no new accessibility regression. |
| a11y#2 | a11y | axe-scan | The rendered UI passes an accessibility scan and stays keyboard-reachable with correct roles and labels — no new accessibility regression. |
| visual-vs-target#1 | visual-vs-target | screenshot-diff | The rendered UI matches its target/baseline design in both light and dark themes — no unintended visual drift. |
| visual-vs-target#2 | visual-vs-target | screenshot-diff | The rendered UI matches its target/baseline design in both light and dark themes — no unintended visual drift. |
| perf#1 | perf | lighthouse | The page stays within its load budget — the change adds no new render-blocking cost or hot-path regression. |
| perf#2 | perf | lighthouse | The page stays within its load budget — the change adds no new render-blocking cost or hot-path regression. |

## Provenance

Carved from the `/consolidate` build (#2983), whose **Fold** outcome is reported-only until this resolves
(`we:docs/agent/backlog-workflow.md:929`, `we:skills-src/consolidate-backlog-items/SKILL.md:35-37`). Until it
resolves, `/consolidate` **reports** fold candidates and mutates nothing.

**Prep methodology.** Both adversarial passes were run as **real independent juror processes** via
`judgeSpawn` (`we:scripts/lib/judge-spawn.mjs`) — headless, tool-free `claude -p` spawns, each minting its own
session id — not `Agent`-tool subagents, which inherit the parent's `CLAUDE_CODE_SESSION_ID` and so are the
same actor by this repo's own independence test (#3145 / #3146). Three distinct actors: `5ca89ad4`
(skeptic, Fork 1), `533cc76c` (skeptic, Fork 2), `751ed39b` (two-confusion screen, both forks, never shown
the authoring session). Every finding is recorded above and folded into the body; the screen's one flag
(Fork 2, prioritization-in-fork-costume) was fixed **before** `preparedDate` was stamped, not deferred.
