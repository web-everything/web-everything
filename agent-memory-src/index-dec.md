---
name: index-dec
description: "Making and ratifying design decisions and forks: fork-existence test, never decide unprepared, prepared=DoR, go vs ratified (2nd go), wait for explicit ratification, decision-mode engages the real fork, confidence on recommendations, concrete code refs before deciding, contrast examples, residual cards, reversibility, judge on pure merit, statute-overlap check at prep, decisions are work-items not plan-mode. Recall when running a decision, evaluating a fork, or preparing/ratifying a design call."
metadata: 
  node_type: memory
  type: reference
  originSessionId: eb2b0a8e-8136-44bb-a1e9-d9e03bb0c5d3
---

Decisions & Forks cluster — open a leaf with `node scripts/memory-resolve.mjs <N>` (or `--cat`):

- 10. Skeptic Finding Is A Hypothesis — a refutation is a CLAIM to test vs data before reshaping a ruling; #1505
- 15. Judge On Pure Merit, Never Demand — "useful to a dev anywhere?"=go; never gate on demand; #1631
- 18. Decouple Build From Release Timing — build now, release later; recurring cost=solo-dev risk; #1590
- 25. Platform Decisions = Statute Layer — platform-decisions.md = cite-able cluster rules; codifiedIn on resolve; #911
- 36. Ratified Decisions Are Reversible — push back FIRST (cite #NNN); reverse freely when warranted; lineage
- 38. Composability Probe + Strip-Effort — prove "cannot coexist" by FAILING to build B as facade over A's kernel; #756
- 39. Never Take An Unprepared Decision — never rule w/o preparedDate; screen→/prepare or pick a prepared item; #1457
- 40. Decision "go" Is Not The Whole Arc — a pick/go = claim+present trigger only; ratify on a 2nd go; #1160
- 41. Wait For Explicit Ratification — a mid-discussion principle is INPUT not the call; hold PENDING until "ratify"
- 42. State Confidence On Recommendations — confidence on every rec + EACH fork sub-call + 1-line residual; #811
- 54. Decisions Are Work Items, Not Plan Mode — design forks→a type:decision item; never plan mode/ExitPlanMode
- 67. Decision-Mode: Engage the Real Fork — don't pre-settle sub-calls; surface the tension + take a stance
- 68. Red-Team Discussion-Born Flips — a mid-discussion flip clears the SAME merit gate; mechanism-vs-UX check; #1407
- 69. Support All Coherent; Fork-Existence — real fork only if a branch is flawed; else support all; #088/#798
- 70. Fork Is Not A Prioritization Tool — fork decides BEST on merit; cost/effort isn't a branch; file build apart
- 71. Decision: Concrete Code Refs — cite file:line from the real tree before a decision; authored snippets never substitute
- 72. Examples Go In The Story — examples requested on a decision→update the item, not chat-only; #1621
- 110. Prepared = DoR, Not Ratified — preparedDate=forks at DoR; exempts NOTHING; re-run fork-existence at CLAIM; #803
- 130. Rule Residual Now If Default Is Worse — deferred residual=silently taking build default; rule now if wrong; #1427
- 131. Collect Decision Residual As A Card — live residual→PARKED card (reason+trigger+lineage); #1406
- 132. Separate Canonicity From Content-Freeze — split held-til-release: ratify structure now, hold content; #569
- 133. Decision Card States The Human Action — needs crisp "What you decide" + un-park trigger; #1590
- 136. Contrast Example Demos The Fork — a decision's rejected example must trip the ACTUAL fork test; name the attr; #1795
- 138. Statute-Overlap Check In Prep — codifying decision: grep platform-decisions at PREP; ratified=immutable, late finding→new item; #1886
- [Fork-vs-Config Classification Gate](fork-vs-config-classification-gate.md) — classify KIND before framing a fork; config-dimension & contract-derived = dispositive non-forks; skeptic attacks the kind first; #1892
- [Red-Team Each Decision Update](red-team-each-decision-update.md) — attack every discussion-born flip/reframe at write-time; banked reframes let a terminal skeptic reverse the whole session; #1892
- [Plug Decision = Contract, Not Impl](plug-decision-ratifies-contract-not-impl.md) — ratify the WE contract (a web-platform proposal); impl mechanism is FUI-local, swappable; never elevate a mechanism question to a WE ratification; #1892
- [Decision Default Mirrors The Story](decision-default-mirrors-story-no-divergence.md) — voice the item's bold default; prepare+decider can't legitimately diverge — divergence ⇒ a choice left un-prepared; scan whole body at prep; #1935
- 143. Stage Gate For Retroactive Statute Amendment — amendment whose new gate retroactively invalidates existing entries: codify policy now, enforce with migration waves, never flip on at ratification
- [Decision item = single current source of truth](decision-item-single-source-not-discussion-log.md) — rewrite on any change; no supersession layers or dueling verdicts
- [Merit forks, not prioritization](merit-forks-not-prioritization.md) — a fork is resolved by a principle; "now vs defer"/YAGNI is a timing deferral, not a fork; #1961
- [Naming-fork precedent discipline](naming-fork-precedent-discipline.md) — JSX/JS-prop ≠ HTML-attr precedent; audit listing a keyword ≠ a ratified shape; #1993
- [Prepared item stale vs sibling ruling](prepared-item-stale-vs-sibling-ruling.md) — a prepared decision may pre-settle a question a later sibling ruling overtook; reconcile first; #1976→#1983
- [Prepared "settled" axis — check siblings](prepared-axis-settled-check-siblings.md) — an "inherited/settled" axis can be stale; a sibling applying the same standard may reshape it; #1977/#1976
- [Codify-instruction is not the ratify go](codify-instruction-is-not-the-ratify-go.md) — "codify/rewrite the decision" = do the authoring, stay un-resolved; wait for explicit ratify go; #1989
- [Prep amendments least-verified at ratify](prep-amendments-least-verified-at-ratify.md) — ratify skeptic grounds prep amendments' premises + cross-element composition vs live tree; #2089
- [/prepare all parallel fan-out](prepare-all-parallel-fanout.md) — one Agent per decision; disjoint files → collision-free; orchestrator centralizes gate/stamp/release; 5/5 2026-07-01
- [Contract-split for tier-ownership decisions](contract-split-for-tier-ownership.md) — engine-tier the impl, policy-tier a *.contract.json for the definition; the default path for "who owns this gate", micro-decision suited to on-card surfacing (#2625/#2577)
- [Red-team before the user picks](red-team-before-the-user-picks.md) — skeptic runs BEFORE the recommendation, not after their yes; self-authored inline red-team is the weak kind; count the real cases a routing rule moves; #2572
- [Misses improve tooling, not demote](misses-improve-tooling-not-demote.md) — a delegated model's miss defaults to automated attribution + a tooling fix, never a human gate or automatic demotion; demotion is the narrow exception, not the default; #4029
