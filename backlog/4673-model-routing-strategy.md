---
bornAs: x6ayr4k
kind: decision
status: resolved
dateResolved: "2026-09-30"
dateOpened: "2026-09-30"
preparedDate: "2026-09-30"
preparedAgainstSha: "687731ec899232739f800c482543c1224a53b581"
relatedReport: reports/2026-09-30-model-routing-strategy.md
relatedTo: ["3906", "3922", "3575", "4075", "4305", "4376", "4377", "4374", "4551", "4010"]
tags: [model-routing, decision-prep]
---

# Validate cheaper model routes by total frontier cost and escaped defects

## Digest

**Go for a bounded qualification pilot; not yet for wider production routing or lighter checking.** Confidence is moderate that there is useful work to offload, low that any untested open-weight route is cheaper after checking. The measured orchestration bucket dominates observed token traffic, while task-size attribution and open-weight outcomes are missing. The report supplies the routing map, taxonomy, evidence and proposed trial settings.

## What you're deciding

Validate this candidate experiment and its net benefit. Scripts first, qualified cheap execution, capped exploration and independent checking are already settled; this card does not re-ratify them. The unresolved merit question is whether a cheap worker plus its independent checker produces an accepted result with less frontier use and no unacceptable defect escape. A low API price or external benchmark does not answer it.

| Option | Benefit | Cost / uncertainty |
|---|---|---|
| (a) Keep current routes and collect passive usage only | No new candidate integration | Cannot establish open-weight task/tool quality or checker overhead |
| **(b) Bounded paired qualification; retain existing acceptance authority** | Tests task quality and total frontier savings before promotion | Pilot spends extra baseline/checker tokens; may find no winning candidate |
| (c) Broaden cheap routing immediately from benchmark/price claims | Potential immediate capacity relief | Unmeasured escapes, tool failures and frontier rework; no evidence for trust |

**Recommendation: (b).** Initial cases are exact transforms, reader-facing corrections and supplied-data card drafts, then the existing test-only route. One Flash-class and one hosted open-weight candidate are comparison targets; a local version follows only after measured host headroom. Model, backend, thresholds and budget remain configurable, not standards mandates. No model is installed or dispatched by this card's preparation.

## Operator ruling (2026-09-30 ~8:10 PM ET)

**Option (b), narrowed** — as presented to the operator (option "B"), verbatim answer "B":

1. **Stage 0 + stages 1–2 with Gemini Flash only** (already-paid allowance, no new integration): join every worker/checker/review/retry call to its card, step and attempt; move deterministic work to scripts; run the paired qualification on text work (exact transforms, reader-facing corrections, supplied-data card drafts) and the existing Flash test-only route after probing its 210-LOC envelope row and the unreadable-checker row.
2. **One small, capped hosted open-weight trial** alongside, with a recorded API-spend ceiling; nothing it produces lands on its own.
3. **"Open weight" means a cheap open-weight model on a cloud API** (operator clarification, same evening). **Local inference is kept for later** only as a way to use spare overnight compute on the operator's planned primary host: batch work, not running local agents ("if we can find some use for overnight compute we may as well use it").
4. **Priority:** the largest measured cost is orchestration (15.13B of 17.67B observed tokens), so reducing orchestration — the builder running on its own — is pushed hardest, ahead of model swaps.

The dossier thresholds, independent checking, existing trust eligibility and explicit human promotion stand exactly as recommended above. Operator quality rule carried with it (same day): use Gemini only where the value is confident — "good to use tokens but not if quality is poor".

## Why this isn't a classic fork (and is still a decision)

This is a one-sided validation gate on the proposed cheaper-route candidate's safety and net benefit. Scripts, hosted APIs, local inference and frontier subscriptions can coexist; choosing one permanently would be a false fork. Even with free implementation and maintenance, unresolved tool correctness, checker misses and defect escape remain. The gate is about warrant, not merely build order.

Classification pass: operational delivery policy, not a new WE protocol or intent; expose provider/backend, risk, budget and checking as separate dimensions; reuse the existing provider seam; retain the most permissive configuration consistent with current critical-work and review authority; no intent seam or new standard term is introduced.

## Context & prior-art delta

| Existing occurrence | What it establishes | Candidate delta |
|---|---|---|
| `we:scripts/lib/provider-routing.mjs:395` and `:450` | Bounded probation and risk-tier routing already exist | Measure total accepted-task frontier cost; no second router |
| `we:scripts/lib/dispatch-contracts.mjs:451` | Audited fitness, actual model recovery and separate supervision | Preserve those reasons for every candidate/fallback |
| `we:scripts/lib/model-probation.mjs:257` | 20 verified trials, positive control, zero critical misses, comparative rating; human promotion | Add a cost/escape dossier, not automatic graduation |
| `we:scripts/conveyor/run-rating.mjs:1385` | Coverage distinguishes orchestration from attributed work | Join step/attempt costs before claiming savings |
| #4551 / PR #3021 | Flash test-only route with Codex checker | Verify assertion strength, envelope and unreadable-checker handling |
| #4374 and #4377 | Review-seat probation and allowance/fallback work | Reuse their authority and availability gates |

Known evidence: 15.13B of 17.67B observed cache-inclusive tokens are orchestration/subagents; 687/691 token-bearing scorecard rows lack an item ID. Two Flash-high test-fix launches lack final outcomes; one recorded 210 LOC against today's 150-LOC envelope, another had no readable checker verdict. Neither qualifies as a clean success. Full method and limitations are in `we:reports/2026-09-30-model-routing-strategy.md`.

## Recommendation

**Go** to qualification after an explicit operator pilot authorization, a recorded API-spend ceiling, known scope/data policy, an independent checker and joined call accounting. Proposed dossier: 20 matched tasks per candidate/task class, at least one informative trial, zero critical escapes, median net frontier use at least 25% below baseline, lower total cohort frontier use and accepted-task p95 at most 1.25× baseline. Pre-register matched inputs/checks and all assigned tasks; count failures, holds, timeouts, abandoned work and fallbacks in total cost, and report completion rate. Track equal seven-day post-accept windows and uncertainty, with immature observations pending; a small clean sample does not prove safety. These are pilot settings; existing trust eligibility and explicit human promotion still govern. Paired tasks and seeded defects do not automatically earn the delivery bar: verify eligible independent verifiers, explicit `informative: true`, zero critical misses and the comparative Claude rating separately.

**Not yet** for broader routing or lighter review until the dossier clears the existing exact-identity promotion gate and the operator names the promoted subjects. If quality or net savings fail, retain the current route and re-benchmark in a month. Scope, tool, checker or quota failure escalates/holds; it never lowers the acceptance bar. Gemini 4 enters as a new frontier candidate only when available and locally tested; the operator's announcement/benchmark report is not trust evidence.

Skeptic: SURVIVES-WITH-AMENDMENT — independent attack narrowed the gate to this experiment, added all-assigned-task and total-cost accounting against survivor bias, equal follow-up windows, and explicit separation from statutory trial eligibility. No authority or graduation shortcut survives.

Screen: clear — separate fresh-context review found operational policy, not a WE standard; tool correctness and defect escape remain genuine warrant unknowns even with free implementation and maintenance.

## Dependencies & lineage

Settled authority: `we:docs/agent/platform-decisions.md#delegation-trial-record-graduation`, `#model-probation-graduation-criteria`, `#planner-build-plan-and-execute`, `#config-extends-platform-default` and `#monetization`. Miss handling keeps the statute's tooling-attribution and restoration rules. The monetization anchor governs product margin; it does not prohibit a capped development API trial. No new codified rule is proposed. Configuration does not authorize weaker permissions or checks; mechanical routing does not replace interactive orchestration judgment.

#3922's typed-step planner and #3996–#4011's relevant build slices are reused, not re-decided. #3575 covers decomposition. #4305/#4376 (`4376`) own configurable delivery policy. The reported `lane/model-routing` ref was not present locally or in remote-tracking refs; inspect it before implementing any policy changes. #2732, #3021 and #2811 in this request are PR references, not their unrelated same-number backlog cards.

## Follow-ups

- Pilot work requires its own scoped build/experiment authorization. Predicted touch-set: `we:scripts/lib/provider-routing.mjs`, `we:scripts/lib/dispatch-contracts.mjs`, `we:scripts/lib/model-probation.mjs`, `we:scripts/conveyor/run-rating.mjs`, and the existing allowance/provider adapter surface. Reconcile against the in-flight policy diff before assigning child scopes; no runtime edit is authorized here.
- Reuse #4298–#4301 and #4304 for weekly reports, independent ratings, sampling, cause analysis and preparation state. Join worker/checker/review/retry calls; preserve missing usage and resolve cumulative-rerating overlap.
- Probe the observed test-fix envelope discrepancy, checker failure and agy-Claude review errors before expanding those routes. Track launcher defects separately from model defects.
- Verify Mac RAM/headroom, model licence, host retention, parser support, current prices/allowances and local inference speed. All external-model claims beyond repository evidence remain **to verify**.
- Testing lesson: a green test repair can weaken coverage; require before/after assertion review and a known failing case. Keep this lesson here, not in shared agent documentation.

## Verification record

The required lane-verification command was attempted; the sandbox denied its Git verification-marker write. The npm standards wrapper was also blocked from writing the host-shared admission lock. Running the underlying standards scanner exposed locus-prefix issues, now corrected, and the new untracked report; committing is expressly outside this job. Re-run the full gate in a writable review environment before landing. Both document locus-prefix checks pass. The selected Vitest command exited 0 with no related test files, and the backlog-health command exited 0 (existing corpus flags remain). The final underlying standards scan had one error: the untracked report; its hash-link warning was then corrected by using the card title in prose. No test or gate was weakened.

## Preparation acceptance

One linked research report, options and a recommendation, independent skeptic and classification passes incorporated, then `node we:scripts/backlog.mjs prepare-stamp 4673`. Run `npm run check:standards` and `node we:scripts/verify-lane.mjs`. Remain open for human judgment; do not commit, push or open a PR in this job.

### Review jury (provisional — pre-registered #2638)

Care level: `high`. This jury binds against the item's predicted scope and is re-checked against the real diff at PR open.

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
