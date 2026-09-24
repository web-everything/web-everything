---
bornAs: xjldlfi
kind: decision
parent: "3690"
relatedTo: ["3867", "3949", "3673"]
blockedBy: ["3949"]
status: resolved
scope: ["we:scripts/lib/provider-routing.mjs"]
dateOpened: "2026-09-24"
dateResolved: "2026-09-24"
codifiedIn: "docs/agent/platform-decisions.md#delegation-trial-record-graduation"
preparedDate: "2026-09-24"
preparedAgainstSha: "0211889352056eae78a36c6fd1d4412b7b5e4553"
relatedReport: reports/2026-09-24-delegation-post-miss-root-cause-classification.md
tags: [delegation, supervision, graduation, root-cause, automated-attribution, decision-prep]
---

# A delegated model's miss is auto-attributed and fixed in tooling; demotion only when critical and unfixable

**Ruled 2026-09-24 by the operator (Nicolas Gilbert): all seven forks ratified as prepared, every fork at
its bold default, no amendments** — including the narrow human override named in Forks 1 and 5, and the
lifetime (non-decaying) `toolingMissCap` default in Fork 6. The *Proposed codified text* below is ratified
verbatim: rules 3, 5, and 6 of
[#delegation-trial-record-graduation](/docs/agent/platform-decisions/#delegation-trial-record-graduation) are
amended as drafted; rules 4 and 7 are untouched. Codified in
[we:docs/agent/platform-decisions.md#delegation-trial-record-graduation](/docs/agent/platform-decisions/#delegation-trial-record-graduation).

No design exists yet for how a delegation-trial miss's root cause gets classified, or what that
classification changes. Seven forks below are grounded in the prior-art survey published as
[/research/delegation-post-miss-root-cause-classification/](/research/delegation-post-miss-root-cause-classification/)
(session report: `we:reports/2026-09-24-delegation-post-miss-root-cause-classification.md`), which extends
the #3690 survey and does not repeat it. Each fork carries a recommended default in **bold**.

**Reworked 2026-09-24 (second pass) — operator rejected the first prep.** The first prep (also dated
2026-09-24) had the wrong shape on two points: it made the automatic step-back to `full` **unconditional**
on every confirmed miss, and it made root-cause classification (`rootCauseClass`) a **human-authored,
human-confirmed** field. Both contradict the standing default this repo already runs on — a failure is an
opportunity to improve the product (the tooling, the instructions), never a problem that needs manual
intervention (`we:agent-memory-src/failure-is-a-product-improvement.md`). The operator's corrected
direction, now the bold default throughout this card: (1) classification is **automated by default, no
human in the loop** — a model distinct from the builder triple attributes the miss to `tooling` or
`vendor`; (2) a **tooling-caused miss gets its tooling/instruction fix and keeps the triple's graduated
level — no demotion**; (3) the automatic step-back to `full` fires **only** when a miss is both **critical**
and **cannot be improved by tooling** — replacing rule 6's unconditional immediate demotion and rule 5's
post-miss bar as the default path (a real skeptic sub-agent attack found this also needs one narrow
carve-out in rule 3's hard veto text — see *Proposed codified text*). This prep's job, per the operator's
own framing, is to ground those three defaults, sharpen them, and surface the real residual risks — not to
overturn them.

**Builds on, does not re-decide, [#3673](/backlog/3673-define-what-clears-a-triggered-calibration-veto-so-a-role-ca/)**
(codified at
[#calibration-veto-clearing](/docs/agent/platform-decisions/#calibration-veto-clearing)) — **and departs
from it on purpose.** #3673 governs the calibration veto, a rarer, higher-stakes mechanism (a role loses
the ability to do *independent review at all*), and its Fork 4 keeps a human-only override on that veto's
clearing. This card governs the ordinary, high-volume delegation-trial supervision level — a much lower-
stakes, routine mechanism — and departs from #3673's implicit human-centric framing by defaulting its
classification step to automation. The two are not in tension: #3673 never actually requires that its own
root-cause note be *human*-authored (it is silent on that point), and nothing in #3673's ruling reaches who
or what may classify a *different* mechanism's root cause. #3673's Fork 4 narrow-override principle (never
a trust grant, only a factual reclassification) is reused here too — see Fork 1 and Fork 5 — just applied to
an automated first pass instead of a human one.

**Blocked by [#3949](/backlog/3949-delegation-trial-logging-stops-once-a-triple-graduates-and-n/).**
`we:scripts/review-set-label.mjs:1129-1130` logs a session-delegation trial only while
`!isDelegationTripleGraduated(...)`, so once a triple graduates no further rows are written and no row ever
records a miss — nothing below can fire at `spot-check` today. **This card's ruling has no live effect until
#3949 lands**: there is no code path today by which a graduated triple's miss reaches the record this
ruling reads. Nothing here is built by this card either (see *What this card does not decide*).

## Axes

Four orthogonal axes, each pinned to the real tree:

- **Who/what classifies a confirmed miss** — no classification field exists in the recorded row schema
  today (`we:scripts/conveyor/log-delegation-trial.mjs` has `--root-cause` but no class/attribution flag);
  `we:scripts/lib/provider-routing.mjs:339-342`'s `hasRootCauseNote` reads only presence of a `rootCause`
  string, never who wrote it.
- **What a `tooling` classification changes** — today, none: `we:scripts/lib/provider-routing.mjs:804-826`'s
  `selectSupervisionLevel` computes `full` for *any* confirmed miss with no root-cause note
  (`hasConfirmedMiss && !hasRootCause`), and once a note exists, still requires the higher
  `minCleanStreak + k` bar (`:810`) with no distinction for what the note names as cause.
- **When the step-back fires** — currently unconditional and immediate: `:816-820` sets `SUPERVISION_LEVELS.FULL`
  the moment either the most-recent trial has an unresolved finding, or any confirmed miss lacks a root-cause
  note; `we:docs/agent/platform-decisions.md:4967-4970` (rule 6) frames this as "demotion is computed... and
  takes effect immediately."
- **What "critical" and "cannot be improved" mean** — neither concept exists as a named field or predicate
  in the delegation-trial record today; this card grounds both against measures that already exist
  elsewhere in the codebase (Forks 4-5), rather than inventing new ones.

## Recommended path at a glance

| Fork | Recommended default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Who/what classifies tooling vs vendor? | **Automated by default** — a classification step run by a model distinct from the builder triple; never the builder itself, never self-declared, never a required human | A required human-authored field (the first prep's shape) | High |
| 2 — What happens on a tooling-caused miss? | The tooling/instruction fix lands and the triple **keeps its graduated level — no demotion at all** | Demote first, restore later on a proof streak (the first prep's shape) | High |
| 3 — When does the step-back to `full` fire? | **Only when the miss is CRITICAL and cannot be improved by tooling** (Forks 4-5), or Fork 6's repeated-miss cap has fired | Unconditional on every confirmed miss (the first prep's shape) | High |
| 4 — What counts as "critical"? | Reuse the existing code-grounded proxy: `deriveRisk === 'high'`, a `NEVER_SPOT_CHECK_PATH_PREFIXES` group, or `humanRequired` — never a new bespoke scale | Invent a new criticality scale for this mechanism alone | High |
| 5 — What counts as "cannot be improved by tooling"? | No fix nameable, **or** a fix landed and the same failure class recurred — recurrence is the trigger, detected passively, never proactively gated | Require a targeted post-fix proof trial before trusting any tooling fix | High |
| 6 — Does a run of tooling-attributed misses ever cap out? | Yes — a named `toolingMissCap` config lever, a lifetime (non-decaying) count by default; past the cap, the pattern reclassifies as vendor-caused for step-back purposes, regardless of any single incident's own criticality | No cap — every miss gets an independent classification forever | Med-high |
| 7 — Does a shared cause extend across triples? | No — each triple runs its own classification and accumulates its own miss count; the diagnosis is referenceable, not the clearance | A proven tooling fix for one triple auto-clears every triple sharing the cause | High |

## Fork 1 — Who, or what, classifies a confirmed miss's root cause as tooling vs vendor?

**Why this is a real fork.** Three mutually exclusive designs for populating the classification cannot all
be authoritative at once: the field is either produced automatically by a disinterested party, inferred
from data the interested parties themselves control, or gated on a human. The choice is what the whole rest
of this card hangs on — get it wrong and either the classification is trivially gameable, or the "no manual
intervention by default" direction is violated at the very first step.

- **(a)** Infer the classification from the free-text `rootCause` note (keyword match), or let the dispatch
  automation, the delegated provider's own session, or the orchestrating session self-declare it.
  **Rejected**: self-certification by any interested party is the same channel #3673 Fork 1 already closed
  for the underlying `rootCause` field itself ("never inferred from a later row's `findings`"); every miss
  could be worded to read "tooling," always drawing the lighter path, functionally erasing the vendor path.
- **(b)** **A classification step run by a model distinct from the builder triple — never the builder
  itself, never inferred from free text, never a required human — writes a `rootCauseClass: 'tooling' |
  'vendor'` field. A `'tooling'` classification must cite a concrete landed fix (`rootCauseFixRef`, a PR or
  commit reference); a missing/invalid class fails closed to `'vendor'`** ← **RECOMMENDED**. Independence
  here does not require a human: this repo's own ratified mechanism for independence,
  [#agent-convergence-independent-validation](/docs/agent/platform-decisions/#agent-convergence-independent-validation)
  (#2398), rules that independence "rests entirely on a distinct fresh validator" and is explicitly satisfied
  by "an in-process role-separated subagent, provided it has fresh context" — applied at
  [#fix-review-convergence-independent-root-cause](/docs/agent/platform-decisions/#fix-review-convergence-independent-root-cause)
  invariant 1 ("a builder never clears its own diff," not "a human clears every diff"). The classifying
  model reads the same evidence a human reviewer would (the miss, the diff, the finding) and is barred from
  being the delegated triple's own provider/model — the same non-author invariant #2398 already establishes
  for fix convergence, reused here for attribution. **A narrow human override exists**, mirroring #3673 Fork
  4's own narrow-override principle: a human may correct a classification on identity/evidentiary grounds
  only — the cited `rootCauseFixRef` does not actually exist, does not match the miss, or the classifier
  misread the row — never to re-litigate whether a landed fix is good enough, and never as a routine step.
- **(c)** A required `rootCauseClass` field, **human-authored**, with the CLI unable to enforce who invoked
  it. **Rejected — this was the first prep's shape, and the operator rejected it 2026-09-24.** It makes
  every classification a manual-intervention step by default, contradicting the standing "failures improve
  the product, never manual intervention" default, and gates the overwhelmingly common tooling-fix path
  behind a human who must show up before any restoration can even be considered.

```js
// Illustrative shape only — mirrors hasRootCauseNote (scripts/lib/provider-routing.mjs:339-342, this repo).
// The real field, predicate and CLI flag are future build work under this ruling, not authored here.
function hasValidToolingClassification(record, builderTriple) {
  // Fail-closed: an absent/invalid class, or a classifier equal to the builder triple, is never 'tooling'.
  return typeof record.rootCauseClass === 'string' && record.rootCauseClass === 'tooling'
    && typeof record.rootCauseFixRef === 'string' && record.rootCauseFixRef.trim() !== ''
    && record.rootCauseClassifiedBy && !tripleEquals(record.rootCauseClassifiedBy, builderTriple);
}
// Written by an automated CLI path, never by the builder's own session:
//   node scripts/conveyor/log-delegation-trial.mjs ... --root-cause="..." \
//     --root-cause-class=tooling --root-cause-fix-ref="PR #1234" \
//     --root-cause-classified-by="claude:sonnet-5"   # must differ from the builder triple
```

**Skeptic:** SURVIVES-WITH-AMENDMENT (real skeptic sub-agent). Rule 5 as *currently ratified* only requires
a root-cause note with no classifier concept, so this is genuinely new ground, not precedent-settled. The
attack found the card's own preamble claimed this fork "reuses #3673 Fork 4's narrow-override principle,"
but the fork's text, as first drafted, contained no actual override mechanism — a wrongly-tagged
classification had no stated correction path, weaker than #3673, not an equivalent reuse of it. Fixed by
writing the override clause into the fork's own text above (identity/evidentiary correction only, never a
re-litigation of the fix's quality) instead of leaving it an unbacked preamble claim.
**Screen:** clear (real fresh-context agent) — a genuine externally-observable policy question (who/what may
set the bar-determining field), and the merit (independent-but-automated vs. human-gated) survives stripping
timing and build cost.

## Fork 2 — What happens to a triple whose confirmed miss is classified tooling-caused?

**Why this is a real fork.** Two designs for what a `tooling` classification *does* are mutually exclusive
as a governing default: either the triple still pays (demotes now, proves its way back later) or it does
not pay at all once the fix is named. A design cannot simultaneously treat the miss as "free" and "costly
until re-proven" — one has to be the default this card names.

- **(a)** A tooling-caused miss still demotes the triple to `full`; restoration requires a subsequent proof
  streak (mirrors the first prep's `toolingReentryStreak` machinery). **Rejected — this was the first prep's
  shape.** It penalizes the triple regardless of cause, attributing to the triple a gap that is actually in
  *this repo's own* tooling/instructions, and reproduces the "pay first, prove later" posture the operator's
  direction explicitly rejects for the tooling path.
- **(b)** **The system's own delivery loop builds the tooling/instruction fix (the same convergent-fix
  machinery this repo already uses for any tooling gap), the row records `rootCauseClass: 'tooling'` +
  `rootCauseFixRef`, and the triple KEEPS its graduated level — no demotion, no reentry bar, no proof streak
  required** ← **RECOMMENDED**. The confirmed miss is never deleted or hidden from the record — it still
  counts toward Fork 6's repeated-miss cap, and Fork 5's recurrence test still watches it. This requires the
  rule-3 carve-out drafted above (*Proposed codified text*): as ratified, rule 3's hard veto fires on the
  miss itself the moment it is the most-recent trial, with no cause exception, so "no demotion" is not
  achievable without that one-sentence amendment.
- **(c)** A tooling-caused miss gets a *shorter* demotion window (some fixed, lower bar) rather than none.
  **Rejected** — this is the first prep's Fork 4 in different clothes; it still treats every tooling-caused
  miss as demoted-then-restorable rather than never demoted at all, which is exactly the shape the
  operator's "keep graduation... no demotion" language forecloses.

```js
// Illustrative shape only — future build work, not authored by this card.
function toolingMissOutcome(record) {
  if (!hasValidToolingClassification(record, record.builderTriple)) return null; // not this path
  return { demote: false, note: 'tooling fix landed; triple keeps its graduated level' };
}
```

**Skeptic:** SURVIVES-WITH-AMENDMENT (real skeptic sub-agent). Statute-overlap: the strongest finding on the
whole card. Ratified rule 3 ("a confirmed miss resets the triple at once... never averaged into a score")
governs the *same* miss this fork says costs nothing — the card's own Axes section already documents that
today's `hasConfirmedMiss && !hasRootCause` and `mostRecentHasFinding` branches compute `full` from any
confirmed miss in history, not only a stale one. "No demotion" and "resets at once" cannot both be true of
the same event unless rule 3 is itself amended. Fixed by drafting the rule-3 carve-out above rather than
asserting (as an earlier draft of this card did) that rule 3 stays untouched. Merit attack (does "no
demotion" remove the incentive for the tooling fix to be good) does not land — the fix still has to clear
`#agent-convergence-independent-validation`'s bar, and Fork 5's recurrence test still catches a fix that
doesn't actually work.
**Screen:** clear (real fresh-context agent) — not cost-of-demotion vs. cost-of-not-demoting; the real
question is whether the triple should pay at all for the repo's own tooling gap, which survives stripping
build cost entirely.

## Fork 3 — When does the automatic step-back to `full` fire?

**Why this is a real fork.** Rule 6 as ratified reads "demotion is computed from the record and takes
effect immediately" with no conditional — an unconditional-on-any-miss reading and a
conditional-on-criticality reading are mutually exclusive governing defaults for the same clause, and the
choice is the crux of the whole card.

- **(a)** The step-back fires unconditionally on any confirmed miss, exactly as rule 6 reads today.
  **Rejected — this was the first prep's shape, and it now also directly conflicts with Fork 2(b)'s "no
  demotion" default** for the overwhelmingly common tooling-caused case; the two cannot both be true.
- **(b)** **The step-back fires only when a miss is classified CRITICAL (Fork 4) *and* cannot be improved by
  tooling (Fork 5) — or when Fork 6's repeated-miss cap has been reached, which reclassifies the pattern as
  vendor-caused for step-back purposes regardless of any single incident's own criticality** ← **RECOMMENDED**.
  This replaces rule 6's unconditional immediate demotion and rule 5's post-miss bar as the default path. A
  tooling-caused, first-occurrence, fixed miss never steps back. A vendor-caused miss on high-stakes work
  steps back immediately (criticality is met, and a vendor-caused miss has no fix to cite, so "cannot be
  improved by tooling" is true by construction). A vendor-caused miss on *routine* work does not step back
  on its own — but Fork 6's cap still catches a triple that racks up enough of them.
- **(c)** The step-back fires whenever the miss "cannot be improved by tooling," regardless of criticality —
  drop the criticality gate. **Rejected** — this would step back on every ordinary, low-stakes vendor
  judgment slip (a typo-grade miss on a doc-fix task, say), which is exactly the disproportionate,
  demotion-happy default the operator's direction is pushing away from; criticality is what keeps the
  step-back "a cheap safety net" rather than a blunt instrument.

```js
// Illustrative shape only — future build work, not authored by this card.
function shouldStepBackToFull(record, toolingMissCapTripped) {
  if (toolingMissCapTripped) return true; // Fork 6 — aggregate trigger, bypasses the per-incident AND-gate
  return isCriticalMiss(record) && cannotBeImprovedByTooling(record); // Forks 4-5 — the per-incident AND-gate
}
```

**Skeptic:** SURVIVES-WITH-AMENDMENT (real skeptic sub-agent). Two findings, both fixed. First: the original
draft's criticality-AND-unfixable gate, taken alone, leaves a real gap — a triple doing only *non-critical*
work could rack up tooling-attributed misses indefinitely (each one individually "fixed," no single one
critical) with no step-back ever firing. Fixed by making Fork 6's cap an explicit OR-branch on this fork
(not folded silently into Fork 6's own text only) — the aggregate cap fires regardless of the per-incident
criticality read, closing the low-stakes-churn gap. Second: this fork inherits Fork 2's rule-3 conflict — a
"tooling-caused, first-occurrence, fixed miss never steps back" is only true once the rule-3 carve-out
(*Proposed codified text*) exists; fixed by drafting that carve-out rather than asserting rule 3 untouched.
**Screen:** clear (real fresh-context agent) — proportionality (blanket step-back vs. criticality-gated) is
a genuine policy stance about consequences, independent of build cost.

## Fork 4 — What counts as "critical," concretely?

**Why this is a real fork.** Two designs are mutually exclusive: invent a criticality scale bespoke to this
mechanism, or reuse a measure this repo already computes and has ratified for a closely related purpose
(what work is too consequential to sample away, or too consequential to route without a human). Inventing a
parallel scale when an applicable one already exists is the excluded branch — it would duplicate a live
contract by a different test, the #1886 statute-overlap failure mode.

- **(a)** Invent a new, bespoke "criticality" field and threshold set authored fresh for this card.
  **Rejected**: this repo already computes exactly this signal for the dispatch path, so a second scale
  would define the same underlying question — is this work too consequential to sample away or route
  without oversight — twice, by two different tests; the same diff could then be "critical" under one
  reading and not the other, an incoherent result a single authoritative measure cannot produce.
- **(b)** **Reuse the existing, code-grounded escalation-severity proxy already computed for the work that
  produced the miss: `criticalMiss` is true iff `deriveRisk(...) === 'high'` (reading
  `we:scripts/lib/dispatch-contracts.mjs:148-152`, which reads `isHighStakesTask` at
  `we:scripts/lib/provider-routing.mjs:289-312`) OR the touched files match any
  `NEVER_SPOT_CHECK_PATH_PREFIXES` group — `statute`, `gateSelf`, `irreversible`
  (`we:scripts/lib/dispatch-thresholds.mjs:42-46`) OR `humanRequired` is true for the diff (the declarative-
  leash/statute layer, `we:scripts/lib/review-escalation.mjs`)** ← **RECOMMENDED**. No standalone "security"
  escalation-reason category exists in this codebase today — "security" names a jury reviewer *lens* (a
  role), not an escalation signal — so a security-relevant miss is caught through these three measures (a
  security-sensitive path very likely falls inside `gateSelf`/`statute`/`irreversible`, or drives
  `deriveRisk`'s `'high'`), never a fourth invented category.
- **(c)** Leave "critical" undefined, to be set whenever [#3374](/backlog/3374-calibrate-the-finding-consequence-scale-one-axis-or-two-asse/)
  (the jury finding-consequence/severity scale) ratifies. **Rejected as this card's default, open to
  amendment later** — #3374 is still `status: open`, unresolved as of this rework, and governs a different
  subject (a jury's *finding* severity within a review) than this card's dispatch-time risk classification;
  making this card's default depend on an unrelated, unresolved decision would leave "critical" undefined
  indefinitely. If #3374 later ratifies a general severity scale, folding it in here is a natural future
  amendment, not a
  precondition for this card.

```js
// Illustrative shape only — future build work, not authored by this card.
// Reuses existing, ratified measures; invents nothing new.
import { deriveRisk } from './dispatch-contracts.mjs';
import { isNeverSpotCheckPath } from './dispatch-thresholds.mjs';

function isCriticalMiss(record) {
  const files = record.filesTouched ?? [];
  return deriveRisk(record.taskType, files, record.complexity, record.acceptanceTestable) === 'high'
    || files.some(isNeverSpotCheckPath)
    || record.humanRequired === true;
}
```

**Skeptic:** SURVIVES (real skeptic sub-agent). Classification axis pressed: is this actually a config
dimension rather than a fork (branch (b) is "reuse an existing measure," which could look like there's
nothing to decide)? Does not dissolve — the genuine open call is *whether* to reuse vs. invent, and (a) is a
real, coherent-looking alternative that a careless build could take (a fresh field feels "more precise" to
an implementer who hasn't checked for the existing proxy), so the fork earns its keep by foreclosing that
temptation explicitly. Citation-scope: confirmed `#3374` is unresolved and correctly cited as related work
only, not authority — verified via its frontmatter (`status: open`, no `resolvedDate`). All code citations
verified current and accurate (`deriveRisk`, `NEVER_SPOT_CHECK_PATH_PREFIXES`, `humanRequired`). Minor nit:
`deriveRisk`'s `'high'` branch already folds in a statute-path check, overlapping with the `statute` prefix
group below it — harmless, defensive redundancy, not incorrect.
**Screen:** flagged(prio) → fixed (real fresh-context agent). The original rejection of branch (a) leaned on
drift/maintenance cost ("would drift out of sync," "duplicate... by a different test") — a cost argument
that dissolves if both scales were free to build and perfectly maintained. Reworded above to the real
merit: two scales would let the *same* diff be "critical" under one reading and not the other, a
definitional incoherence no amount of maintenance budget fixes.

## Fork 5 — What counts as "cannot be improved by tooling," concretely?

**Why this is a real fork.** Two mutually exclusive postures for closing off the tooling-fix path: gate it
proactively (no fix counts until proven against a follow-up trial) or watch it passively (trust the fix,
treat recurrence as the signal it didn't work). Layering both would silently reintroduce the "pay first,
prove later" cost Fork 2 exists to remove — so the card has to pick one as the actual governing test, not
both as redundant gates.

- **(a)** No tooling fix counts as sufficient until a subsequent trial specifically targeting the failure
  mode comes back clean (mirrors the first prep's Fork 3, and #3673 Fork 2's similarity-trial principle by
  analogy). **Rejected** — a synthetic, pre-arranged proof trial only shows the fix handles a case its
  author already knows about, which is weaker evidence than the fix holding up against *live, unprompted*
  recurrence; it also reintroduces exactly the "triple pays first, proves later" structure Fork 2 rejects,
  by requiring a gate before the fix is ever trusted.
- **(b)** **"Cannot be improved by tooling" is true iff EITHER (i) the classifier cannot name a concrete
  landed fix (`rootCauseFixRef` absent/empty — nothing to cite, so treat as vendor by Fork 1's fail-closed
  rule), OR (ii) a fix WAS landed and a LATER confirmed miss for the same triple is classified by the
  automated step as the same failure class, recorded as a `recurrenceOfRootCause` reference to the earlier
  row** ← **RECOMMENDED**. Recurrence is the trigger, detected after the fact by the same distinct-model
  classifier from Fork 1 (by analogy to #3673 Fork 2's "similar-case" test, now applied to *detecting a
  repeat* rather than *proving a fix*), never proactively gated before the fix is trusted the first time.
  The same narrow human override named in Fork 1 applies here: a human may correct a wrongly-tagged
  `recurrenceOfRootCause` on identity/evidentiary grounds, never to argue the recurrence "doesn't really
  count."
- **(c)** Never treat a tooling-caused miss as unfixable, no matter how many times the "same" failure
  recurs. **Rejected** — this would leave the tooling-caused path permanently ungated even under
  demonstrated repeated failure, contradicting Fork 6's own cap and leaving no path back to `full` for a
  triple whose tooling "fix" provably never sticks.

```js
// Illustrative shape only — future build work, not authored by this card.
// Passive recurrence, never a proactive proof-trial gate.
function cannotBeImprovedByTooling(record) {
  if (!hasValidToolingClassification(record, record.builderTriple)) return true; // no fix named -> vendor path
  return typeof record.recurrenceOfRootCause === 'string' && record.recurrenceOfRootCause.trim() !== '';
}
```

**Skeptic:** SURVIVES-WITH-AMENDMENT (real skeptic sub-agent). The attack found "the same failure class" is
underspecified — self-tagging a recurrence, like Fork 2's original self-declared classification, is exactly
as gameable if left to the row's own say-so. Fixed by tying `recurrenceOfRootCause` to the *same* distinct-
model classifier Fork 1 already established (never the builder, never self-tagged), rather than leaving it
an unowned field. Citation-scope: #3673 Fork 2's similarity-trial mechanic is borrowed as an analogy for
*recognizing a repeat*, not cited as rule 5's literal inherited mechanic (rule 5's ratified text borrows
#3673's root-cause-and-higher-bar principle generally, not its specific trial-similarity clause) — stated
explicitly above to avoid over-citing, the same correction the first prep's Fork 3 skeptic pass already made
once. Also found: like Fork 1, this fork's preamble-claimed override was missing from its own text — fixed
by adding the pointer to Fork 1's override clause above.
**Screen:** clear, weakly-worded original tightened (real fresh-context agent). The rejection of branch (a)
originally leaned on cost-sounding language, which reads as a build-effort objection; the real,
cost-independent merit is evidentiary — a synthetic pre-arranged trial only proves the fix handles a case
its author already knows about, weaker evidence than the fix holding against live, unprompted recurrence —
reworded into branch (a)'s rejection above. The underlying question (what counts as proof a fix worked)
survives stripping timing and build effort entirely.

## Fork 6 — Does a run of tooling-attributed misses for one triple ever cap out?

**Why this is a real fork.** Two mutually exclusive designs for how much weight repeated tooling
attributions carry: unlimited (every miss gets an independent classification forever, no memory of the
pattern) or capped (a repeated pattern itself becomes evidence the classification — or the "fix" — isn't
holding). Rule 3's "never averaged into a score" caution is about not *diluting* a single miss; this fork
asks the mirror question for a *run* of misses each individually waved through as tooling.

- **(a)** No cap — every miss gets its own independent tooling/vendor classification with no memory of how
  many prior tooling attributions this triple has accumulated. **Rejected** — makes the tooling-fixed path
  an unlimited free pass: a triple that keeps tripping a same-shaped bug, each time waved through as
  "tooling, fixed," never reaches a bar that questions whether the fix is real or the classification is
  being gamed or simply wrong.
- **(b)** **A named `toolingMissCap` config lever — `{ count: N, windowDays: null }` (mirroring
  `DEFAULT_BACKDOWN_THRESHOLDS`'s shape at `we:scripts/lib/provider-routing.mjs:147-158`) — defaulting to a
  placeholder `count` and `windowDays: null` (a LIFETIME count, no decay), tunable only by a future ordinary
  batched finding, the same rule-3 mechanism that tunes `minCleanStreak`/`k`, never locked to a number by
  this card. Once a triple accumulates `count` distinct tooling-attributed confirmed misses (lifetime, by
  default), the pattern is reclassified as a vendor problem for Fork 3's step-back test — regardless of any
  single incident's own criticality** ← **RECOMMENDED**. This is Fork 3's explicit aggregate OR-branch,
  closing the gap where a non-critical taskType could otherwise accumulate tooling-attributed misses
  indefinitely with no step-back ever firing. **The default is deliberately non-decaying**: a real skeptic
  sub-agent attack on an earlier draft (which defaulted `windowDays` to a finite trailing window) found that
  a *sliding* window lets a triple whose tooling misses are spaced further apart than the window dodge the
  cap forever, no matter how many it accumulates over its lifetime — reopening exactly the "unlimited free
  pass" branch (a) rejects, just gated by pacing instead of count. A future batched finding may introduce a
  decay window only once it also demonstrates that window doesn't reopen this gap.
- **(c)** A cap exists but is advisory only — it files a follow-up item and never itself triggers step-back.
  **Rejected** — an advisory-only cap leaves exactly the indefinite low-stakes-churn gap open; once a
  computed condition is met it should act at once (rule 3's own discipline for a single miss, reapplied
  here to a pattern of them), not wait on someone reading a filed note.

```js
// Illustrative shape only — future build work, not authored by this card.
export const DEFAULT_TOOLING_MISS_CAP = Object.freeze({
  count: 3,          // placeholder — tunable only by a future ordinary batched finding, never fixed here
  windowDays: null,  // null = lifetime count, no decay (the deliberate, ungameable default; see below)
});
function toolingMissCapTripped(sortedRecords, cap = DEFAULT_TOOLING_MISS_CAP) {
  const cutoff = cap.windowDays == null ? -Infinity : Date.now() - cap.windowDays * 86_400_000;
  const countedToolingMisses = sortedRecords.filter((r) =>
    hasValidToolingClassification(r, r.builderTriple) && Date.parse(r.scoredAt) >= cutoff);
  return countedToolingMisses.length >= cap.count;
}
```

**Skeptic:** SURVIVES-WITH-AMENDMENT (real skeptic sub-agent). Two findings, both fixed. First — the
strongest finding on this fork: the original draft defaulted `windowDays` to a finite trailing window,
which a triple can dodge indefinitely simply by spacing its tooling misses further apart than the window,
reopening branch (a)'s "unlimited free pass" gated by pacing instead of count. Fixed by defaulting to a
lifetime, non-decaying count (`windowDays: null`) above. Second — an earlier draft left the cap's
consequence implicit ("reclassifies as vendor" without saying what that does downstream); fixed by naming
the consequence explicitly as Fork 3's aggregate OR-branch (see Fork 3's code example and its own skeptic
note). No statute-
overlap found — no existing anchor names a repeated-misclassification cap for this record.
**Screen:** clear (real fresh-context agent) — a genuine correctness/gaming question (does a repeated
pattern ever get distrusted), not an implementation detail; survives stripping timing/build cost.

## Fork 7 — Does a shared tooling root cause extend across triples automatically?

**Why this is a real fork.** The already-ratified preamble of this same anchor states "The unit of trust is
the triple `{provider, model, taskType}`, and trust never carries across triples"
(`we:docs/agent/platform-decisions.md:4936-4937`) — a forced invariant that directly forecloses letting one
triple's classification or fix clear another triple's bar, even when the underlying cause is identical.

- **(a)** A tooling fix and/or classification proven for one triple automatically clears, or extends to,
  every other triple whose confirmed miss shares the same root cause. **Rejected**: directly contradicts
  "trust never carries across triples" — this would be exactly that cross-triple carry, now for automated
  attribution and Fork 6's cap too.
- **(b)** **Each affected triple runs its own automated classification pass (Fork 1) and accumulates its own
  Fork 6 miss count independently. The same `rootCause`/`rootCauseFixRef` diagnosis may be referenced across
  every triple's row that shares the cause — the diagnosis itself is not re-investigated per triple — but
  that reference never substitutes for the triple's own classification or counts toward another triple's
  cap** ← **RECOMMENDED**. Keeps the record honest (no duplicated diagnosis authoring across triples hit by
  one shared bug) while leaving the trust-never-carries invariant, and Fork 6's per-triple cap, untouched.

**Skeptic:** SURVIVES (real skeptic sub-agent). Classification axis: branch (a) is already excluded by the
anchor's own ratified preamble, so like the first prep's Fork 1/5 this is a forced-invariant confirmation —
accepted, matches the fork's own justification. Merit attack (a shared bug forcing redundant per-triple
classification cost) does not land: referencing the same diagnosis across triples shares only the
diagnosis-authoring cost, not the classification or cap-accrual cost, each of which is intrinsic to the
triple that had the miss. No statute-overlap or citation-scope issue found.
**Screen:** clear (real fresh-context agent) — extends an already-ratified invariant to a new mechanism by
analogy; still a genuine policy call (does *this* mechanism inherit that invariant), not an implementation
detail, and exempt from a code example (naming/scope precedent, no independent code shape beyond what Forks
1 and 6 already show).

## Proposed codified text (drafted, ready to ratify verbatim; not yet ratified)

If all seven forks are ratified as recommended, rules 3, 5, and 6 of
[#delegation-trial-record-graduation](/docs/agent/platform-decisions/#delegation-trial-record-graduation)
read (amendments in **bold**, rest unchanged). **Rule 3 needs a narrow carve-out, not named in the task
brief but required for Fork 2/3 to be mechanically true** — a real skeptic sub-agent attack found that rule
3's hard veto ("a confirmed miss resets the triple at once") fires on the *miss itself* as soon as it is the
most-recent verified trial, with no cause exception; Fork 2's "no demotion" default is otherwise
unachievable, since the miss that triggers classification is ordinarily also the most-recent trial rule 3's
veto reads. The fix is a one-sentence carve-out, not a rewrite — the rest of rule 3 (the streak shape, the
positive control, "never averaged into a score") is untouched:

> 3. **The evidence bar is a shape: a trailing clean streak, plus a positive control, plus a clean most
>    recent verified trial, with a confirmed miss as a hard veto — per triple.** The streak length N is a
>    `backdownThresholds` config default (`DEFAULT_BACKDOWN_THRESHOLDS` in
>    `we:scripts/lib/provider-routing.mjs`), proposed and changed by an ordinary batched finding against real
>    data, never by a decision ceremony. A confirmed miss resets the triple at once; it is never averaged
>    into a score — **except when rule 5's tooling-caused-and-fixed path applies to that miss, in which case
>    the reset is superseded and the triple keeps its graduated level.** A concurrent-baseline comparison
>    (the same task run through Claude and through the delegated provider, judged on the difference) is the
>    preferred evidence shape over raising N.
> 5. **Re-graduation after a miss — automated attribution first, then a fix or a bar, never a human gate by
>    default.** After a miss, an automated classification step — run by a model distinct from the delegated
>    triple, never the triple itself, never inferred from free text — records a `rootCauseClass` (`tooling`
>    or `vendor`) alongside the existing root-cause note. **A missing or invalid class fails closed to
>    `vendor`. A `tooling` class must cite a concrete landed fix (`rootCauseFixRef`, a PR or commit
>    reference), never bare prose.** A narrow human override exists, mirroring
>    [#calibration-veto-clearing](#calibration-veto-clearing)'s own override: a human may correct a
>    classification or a recurrence tag only on identity/evidentiary grounds (the cited fix does not
>    actually exist or does not match the miss, the classifier misread the row) — never to re-litigate
>    whether a landed fix is good enough, and never as a routine step. When the class is `tooling` and the
>    fix has landed, **the triple keeps
>    its graduated level — no demotion, no post-miss bar, no reentry streak.** The automatic step-back to
>    `full` fires only when the miss is both **critical** (the existing dispatch-risk / never-spot-check /
>    human-required proxy already computed for the work — never a new bespoke scale) **and cannot be
>    improved by tooling** (no fix nameable, or a fix landed and the same failure class recurred — recurrence
>    detected by the same distinct classifier, never a proactive proof-trial requirement) — **or a named
>    tooling-miss cap (a lifetime count, not a decaying one, tunable only by a future ordinary batched
>    finding, the same mechanism that tunes `minCleanStreak`/`k`) has been reached for the triple, which
>    reclassifies the pattern as vendor-caused regardless of any single incident's own criticality.** A
>    tooling fix proven for one triple
>    never clears or extends to another triple's classification, fix credit, or cap count; the same
>    root-cause finding may be referenced across triples that share the cause, but each accumulates its own
>    evidence. This is the same principle as
>    [#calibration-veto-clearing](#calibration-veto-clearing), applied to a delivery trial rather than a
>    reviewer's disposition, with independence satisfied by a distinct automated validator rather than a
>    required human (per
>    [#agent-convergence-independent-validation](#agent-convergence-independent-validation)).
> 6. **Who moves a level — the data demotes when the bar above is met, the operator promotes.** Demotion is
>    computed from the record **exactly as rule 5 above gates it** — never unconditional on a bare confirmed
>    miss — and takes effect immediately once the criticality-and-unfixable test (or the repeated-miss cap)
>    is met. Promotion to a lighter level takes an explicit ratified act naming the triples promoted, done in
>    batches against accumulated data, never per dispatch and never per trial. **This includes restoring a
>    triple that was actually stepped back under rule 5's critical-and-unfixable path**: meeting whatever bar
>    applies is never itself sufficient — the ratified act also confirms the classification and cap state
>    that put it there. With no such act, a stepped-back triple stays at `full`. [rest unchanged]

`codifiedIn` on resolve is anchor `#delegation-trial-record-graduation` in
`we:docs/agent/platform-decisions.md`.

## What this card does not decide

**It amends rule 3, narrowly** — a real skeptic sub-agent attack found Fork 2/3's "no demotion" default is
mechanically impossible without this carve-out, since the miss under classification is ordinarily also the
most-recent trial rule 3's hard veto reads. Rule 3's streak shape, positive control, and "never averaged
into a score" principle are otherwise untouched (see *Proposed codified text*). It does not reopen rule 4's
`informative` field or rule 7's verification floor (that is `#3867`, ratified 2026-09-21: no supervision
level below `spot-check`, and `spot-check` runs async/non-blocking — unaffected by this card). It does not
fix a numeric value for `minCleanStreak`, `k`, or `toolingMissCap.count` (Fork 6) — those stay ordinary
batched findings per rule 3, exactly as `#3673` left its own N undefined. It does not itself build the
`rootCauseClass`, `rootCauseFixRef`, `rootCauseClassifiedBy`, `recurrenceOfRootCause`, or `toolingMissCap`
fields, the
automated classifier, or the `selectSupervisionLevel` branch logic — that is separately-scoped future build
work once ratified, matching `#3673`'s own "not built here" posture; and it has no live effect until `#3949`
restores trial logging for graduated triples. It does not touch #3673's own calibration-veto-clearing
ruling — that mechanism keeps its human-only override on clearing exactly as ratified; only this card's own,
narrower, routine-supervision mechanism defaults to automated classification (see the departure note above).
Restoration after an actual critical-and-unfixable step-back stays an ordinary rule-6 promotion act,
unchanged in mechanism by this card — no new restoration machinery is invented here.

### Review jury (provisional — pre-registered #2638)

Care level: `high` (this card edits statute). This jury binds against the item's predicted scope
(`we:docs/agent/platform-decisions.md`) and is re-checked against the real diff at PR open.

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
| claim-accuracy#1 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |
| claim-accuracy#2 | claim-accuracy | static-review | Every factual claim the change makes about the repo holds against the repo: a cited path:line names what is actually there, a quoted grep literal really matches, a stated count is the real count, a referenced id or link resolves, and anything the description says was changed appears in the diff. |

## Done when

1. **Executable** — `we:scripts/lib/__tests__/provider-routing.test.mjs` gets cases showing: a triple with a
   `rootCauseClass: 'tooling'`, a `rootCauseFixRef`, and a `rootCauseClassifiedBy` distinct from the builder
   triple keeps `spot-check` with no demotion; a triple whose miss is critical (by the Fork 4 proxy) and
   whose class is `vendor` (or missing/invalid) steps back to `full`; a triple whose tooling fix recurred
   (`recurrenceOfRootCause` set) also steps back even though it was tooling-classified; and a triple that
   crosses `toolingMissCap` steps back regardless of any single incident's criticality — all reading
   `we:scripts/lib/provider-routing.mjs`'s shared `DEFAULT_BACKDOWN_THRESHOLDS`/cap config, never a local
   constant.
2. **Assertable** — rules 3, 5, and 6 of
   [#delegation-trial-record-graduation](/docs/agent/platform-decisions/#delegation-trial-record-graduation)
   are amended to state the split (see *Proposed codified text* above — rule 3 gets only the narrow
   tooling-carve-out a real skeptic pass found necessary; rules 5 and 6 carry the bulk of the change);
   rules 4 and 7 are untouched.
3. **Grounded** — the ruling states, for each of the seven forks above, the option taken, confirms
   `#3673`'s calibration-veto-clearing ruling was extended (its clearing mechanism untouched), and states
   the departure from its human-centric framing and why.
