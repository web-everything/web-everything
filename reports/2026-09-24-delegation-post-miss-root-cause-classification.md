# Tooling-caused vs vendor-caused delegation misses — prior art for #4029's prep

**Date**: 2026-09-24
**Point**: industry root-cause practice (Google flaky-test quarantine, SRE blameless postmortems, ISO 9001 /
SCAR corrective-action review) all reinstate on a *proven fix against the triggering case*, never on trial
volume alone, and all keep classification out of the hands of the party whose work is being classified —
directly grounding #4029's forks on the post-miss re-graduation bar.
**Plan file**: none (operator-directed prep, not a `plans/` inbox item)
**Research page**: `/research/delegation-post-miss-root-cause-classification/`

---

## Question

#4029 asks whether a delegation-trial miss traced to *tooling/instructions* (not the vendor's own judgment)
should re-graduate at the ordinary cold-start bar once the fix is proven, instead of always paying the
higher post-miss bar `we:docs/agent/platform-decisions.md#delegation-trial-record-graduation` rule 5 sets
today. That rule (built by #3889) currently applies the higher bar (`minCleanStreak + k`) to *every*
confirmed miss, with no distinction for what caused it. Three sub-questions this survey grounds:

1. Does *any* real-world corrective-action discipline reinstate on "the fix is proven" rather than on a raw
   clean-trial count?
2. Who is allowed to classify a defect's root cause, and is self-classification (by the party the finding is
   against) an accepted practice anywhere?
3. Does fixing a shared/systemic cause ever transfer credit across otherwise-independent units (tests,
   suppliers, agents), or does each unit re-earn its own record?

## Key findings

**1. Google's flaky-test quarantine reinstates on proof-against-the-trigger, not on volume alone.**
Google's testing org quarantines a flaky test out of the blocking lane, but exit requires an identified
root-cause fix, not just a quiet run — a test is returned to the blocking lane once the root cause is fixed
*and* it has held a run of consecutive passes; quarantine is explicitly a temporary mitigation with an SLA,
never a substitute for the fix (Google Testing Blog, "Flaky Tests at Google and How We Mitigate Them", 2016;
corroborated by current industry guides, e.g. minware's flaky-test-quarantine best-practice writeup, 2026).
This is the direct analog for #4029 Fork 3/4: reinstatement pairs a *named fix* with *fresh evidence*, and
the fix alone (with no subsequent evidence) is never sufficient, matching rule 5's existing "root-cause note
first, then a bar to clear" shape — the open question this card adds is only *which* bar.

**2. SRE blameless postmortems: classification targets systems, and is reviewed, not self-declared.**
Google's SRE book (`sre.google/sre-book/postmortem-culture/`) and the surrounding practice literature treat
"human error" as a red flag that stops the investigation too soon, not a valid terminal classification —
the discipline pushes root-cause analysis (e.g. "5 Whys") past the first plausible-looking answer to the
systemic condition that allowed it. Corrective actions are tracked separately by whether they change a
system/process or merely "retrain a person" — mirroring #4029's split (tooling/instruction fix vs "the
vendor itself"), and the postmortem is reviewed by people other than the party whose action is being
examined, not self-certified.

**3. ISO 9001-lineage Corrective and Preventive Action (CAPA) / Supplier Corrective Action Request (SCAR):
root cause is investigated, then reviewed by the requesting org, and "operator/vendor error" as a terminal
answer is explicitly pushed back on.** A SCAR requires the supplier to run a structured root-cause method
(5 Whys, 8D, fishbone) and submit it back to the *requesting* organization for review — practitioner guidance
is explicit that reviewers should push back on "operator error" as a terminal root cause and demand the
underlying process gap (Wikipedia, "Corrective and preventive action"; ComplianceQuest/MasterControl/Arena
SCAR glossaries, 2026). The classifying party is never only the party under review — directly grounding
#4029 Fork 2's requirement that `rootCauseClass` be a human-authored field, never inferred or self-declared
by the dispatch automation or the delegated vendor's own session.

**4. No surveyed discipline lets one unit's fix transfer credit to another unit's record without that unit
re-accumulating its own evidence.** Flaky-test quarantine, SCAR, and postmortem corrective-actions are all
scoped to the failing unit (the specific test, the specific supplier's line, the specific finding); a shared
root cause (e.g. a library used by ten suppliers) still requires each supplier's own corrective-action
record to close, even when the same root-cause finding is cited across all of them. This grounds #4029
Fork 5's default: a `rootCause` note may be **cited** across every affected triple's row (the diagnosis is
reusable text), but each triple accumulates its **own** post-fix trial evidence — matching rule 1's
already-ratified "trust never carries across triples."

## What this does not settle

None of the three disciplines surveyed map a *numeric* bar onto "proven" (none say "N clean trials" as the
exit criterion — they say "the fix, then fresh evidence of typical scope"), so this survey does not by
itself fix what #4029 Fork 4 calls the "shorter" door; it only supports that the ordinary cold-start bar,
not a fixed lower number, is the correct default, with any lower number deferred to a future ordinary
batched finding exactly as rule 3 already requires for `minCleanStreak`/`k` themselves. The call itself, the
forks, and the ratification are on `we:backlog/4029-a-tooling-caused-delegation-miss-re-graduates-on-the-normal.md`,
not here.

## Rework — operator-directed reshape (2026-09-24, second pass)

The operator rejected the first prep (2026-09-24) as the wrong shape on two points: (1) it made the
automatic step-back to `full` **unconditional** on every confirmed miss regardless of cause, and (2) it
made root-cause classification (`rootCauseClass`) a **human-authored, human-confirmed** field. Both
contradict the standing default this repo already operates under — a failure is an opportunity to improve
the product (tooling/instructions), never a problem that needs manual intervention (`#3383` lineage,
`we:agent-memory-src/failure-is-a-product-improvement.md`). The operator's corrected shape: classification
is **automated by default** (a model distinct from the builder triple, never the builder itself), a
tooling-caused miss gets its tooling/instruction fix and **keeps** its graduated level (no demotion), and
the automatic step-back to `full` fires **only** when the miss is both **critical** and **cannot be
improved by tooling**. Two follow-on findings ground that reshape without re-running the whole survey:

**Finding 5 — "independent" in every surveyed discipline means *not the party under review*, not
specifically *human*; this repo already treats a non-human distinct validator as sufficient
independence.** Re-reading Findings 2–3 against the corrected shape: SRE blameless-postmortem practice and
ISO-lineage SCAR both require the classifying party to be someone *other than* the party whose work is
under review — neither discipline says that "someone" must be a human, only that it must not be
self-interested in the outcome. This repo already has a ratified mechanism that treats a **non-human**
distinct party as sufficient independence:
[`#agent-convergence-independent-validation`](/docs/agent/platform-decisions/#agent-convergence-independent-validation)
(#2398) rules that independence "rests **entirely** on a distinct fresh validator" and is explicitly
satisfied by "an in-process role-separated subagent, provided it has fresh context" (applied at
[`#fix-review-convergence-independent-root-cause`](/docs/agent/platform-decisions/#fix-review-convergence-independent-root-cause)
invariant 1 — "a builder never clears its own diff", not "a human clears every diff"). #4029's reworked
Fork 1 reuses exactly that pattern: an automated classification step run by a model distinct from the
delegated triple satisfies the same not-self-certified principle the surveyed disciplines establish,
without a human in the loop by default.

**Finding 6 — "critical" already has a concrete, code-grounded proxy in this repo; no new scale is
invented.** `deriveRisk` computes `'high'` when a change touches a statute-tier path or is a high-stakes
bugfix/conflict-resolution touching tests in a critical prefix (`we:scripts/lib/dispatch-contracts.mjs:148-152`,
reading `we:scripts/lib/provider-routing.mjs:289-312`'s `isHighStakesTask`); `NEVER_SPOT_CHECK_PATH_PREFIXES`
names three concrete never-sample-away groups — `statute`, `gateSelf`, `irreversible`
(`we:scripts/lib/dispatch-thresholds.mjs:42-46`); and `humanRequired` flags the declarative-leash/statute
layer (`we:scripts/lib/review-escalation.mjs`). No standalone "security" escalation-reason category exists
in code today — "security" names a jury reviewer *lens* (a role), not an escalation signal — so the
reworked Fork 4 grounds "critical" on the three measures above, not an invented fourth.
[`#3374`](/backlog/3374-calibrate-the-finding-consequence-scale-one-axis-or-two-asse/) (calibrating the
jury's finding-consequence/severity scale) is still `status: open` with no ratification as of this rework;
it is cited as related, ongoing work, never as authority for this card's "critical" default.

**Skeptic-pass corrections (not new prior art, recorded for the record).** A real skeptic sub-agent attack
on the reworked card's seven forks found three things worth noting here: (1) ratified rule 3's hard veto
("a confirmed miss resets the triple at once") fires on the miss itself the moment it is the most-recent
trial, with no cause exception — Fork 2/3's "no demotion for a tooling-caused miss" default is therefore
mechanically impossible without a narrow rule-3 carve-out, which the reworked card now drafts alongside
rules 5/6; (2) Forks 1 and 5 claimed to reuse #3673 Fork 4's narrow human-override principle but initially
left it unwritten — fixed by writing the override clause into each fork's own text; (3) Fork 6's
repeated-tooling-miss cap defaulted to a decaying trailing window, which a triple could dodge indefinitely
by spacing its misses further apart than the window — fixed by defaulting to a lifetime, non-decaying count
instead. All three are folded into the card itself; see its Skeptic: lines for the full argument.

## Files created/modified

| File | Action |
| --- | --- |
| `we:reports/2026-09-24-delegation-post-miss-root-cause-classification.md` | created (this report), then amended in the rework pass (this section) |
| `we:src/_data/researchTopics/delegation-post-miss-root-cause-classification.json` | created |
| `we:src/_includes/research-descriptions/delegation-post-miss-root-cause-classification.njk` | created, then amended in the rework pass |
| `we:backlog/4029-a-tooling-caused-delegation-miss-re-graduates-on-the-normal.md` | rewritten to the prepared-fork shape, then reworked to the operator's corrected shape (automated attribution, tooling-keeps-graduation, conditional step-back) |
| `we:backlog/3673-define-what-clears-a-triggered-calibration-veto-so-a-role.md` | `relatedTo` gains `4029` |
| `we:backlog/4029-a-tooling-caused-delegation-miss-re-graduates-on-the-normal.md` | also gains `blockedBy: ["3949"]` — trial logging must resume before computed demotion can be observed |
| `we:agent-memory-src/misses-improve-tooling-not-demote.md` | created — feedback memory on the corrected default |
