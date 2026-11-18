---
bornAs: xsjqjr9
kind: decision
size: 3
parent: "5407"
status: open
dateOpened: "2026-10-08"
preparedDate: "2026-11-17"
preparedAgainstSha: "157f3184592f9b20aa4356a18cfd34df7f86a099"
tags: []
relatedReport: reports/2026-11-17-open-line-delivery-kernel-vs-plateau-loop.md
---

# Where the open line sits between the open delivery kernel and paid Plateau Loop

Source: AI Delivery Landscape research brief, 2026-10-08, sections 'Open decisions' item 3 and 'Where the open line sits'. Too much open leaves nothing to sell; too little and the standard has no credible implementation. An earlier ruling already lets tools you run on your own build be closed Plateau products, which would allow a fully closed engine. Brief's recommendation: open standard, open conformance verifier, thin open kernel (each step on request, one repo, one runtime and one forge binding); paid = autopilot (continuous dispatch, review panels, integrator across many repos), cross-model review seats and routing, org policy/SSO/audit, cross-project cost and learning, compliance evidence packs (#3049 'provable conformity'). Follows the existing rule that the paid line is structural (hosted, credentials, per-call cost, cross-project) and that the standard and its verifier are never paid. Operator's call; licence is a separate card.

## Prepared fork (operator-only call; options and a recommendation, not a ruling)

Ground: [we:docs/agent/platform-decisions.md#monetization](/docs/agent/platform-decisions/) (paid line is structural: per-call cost or hosted/credential-holding, never a category; open standard plus open reference implementation free; local fixed-cost product gated by commercial-use licence, server-needing capability paid), [#098](/backlog/098-licensing-strategy/) (gradient: standard and reference implementation open, platform FSL-1.1, `webcases` Apache-2.0 for life, trademark and conformance mark as the enforcement lever), the epic [#5407](/backlog/5407-delivery-standard-protocol-home-open-kernel-and-plateau-loop/) (its Done-when needs a reference kernel that passes the conformance cases). Siblings: [#5402](/backlog/5402-delivery-protocol-home-separate-repo-now-or-incubate-inside/) (standard repo, default separate) and [#5403](/backlog/5403-licence-for-the-open-delivery-standard-and-kernel-apache-2-0/) (kernel Apache-2.0, flips to FSL-1.1 only if the operator calls the kernel Plateau-tier). This card is where that tier call is made in substance. Prior art: [report](/reports/2026-11-17-open-line-delivery-kernel-vs-plateau-loop/).

Known occurrences: Grafana (open core; SSO, RBAC, audit and hosting paid), GitLab (single-instance CE complete; org-wide and hosted paid), Temporal (open server; hosted Cloud paid), Terraform/HashiCorp (open CLI; policy, SSO, cross-team governance paid), Jenkins/CloudBees (open engine; many-controller operations centre paid). One team, one repo, one run is open; cross-team, credentials, hosting and audit are paid.

Standing test result: the **never-paid set**, the **structural paid set** and **single-repo autopilot placement** are settled by precedent or by Fork 1, so they are not forks. One concern is a real either/or call.

| Fork | Options | Default |
|---|---|---|
| 1. How much of the engine is open | (a) thin open kernel; (b) standard and verifier only, engine closed; (c) fully open incl. autopilot | **(a)** |

Settled / supported by default (not forks):
- Never paid: the standard, the conformance suite and the verifier (#098 `webcases` Apache-2.0 for life; the brief agrees). The conformance mark is a trademark matter (#098 point 4).
- Structurally paid, per the monetization anchor, whatever fork 2 rules: integrator across many repos (cross-project), hosted cross-model review seats and routing (credentials, per-call cost), org policy/SSO/audit (hosted, org-wide), cross-project cost and learning, compliance evidence packs (#3049; the signed-attestation service is paid, the verifier that checks it is not).
- Single-repo autopilot (continuous dispatch, review panels): Plateau Loop, a Gate 1 paid local product with an open scheduler seam in the kernel; see the dissolved section below (a use-context call, not a structural one).
- The earlier ruling that tools you run on your own build may be closed Plateau products stays; fork 1 only decides that the *reference kernel* is not one of them.

## Fork 1 — How much of the engine is open

Fork-existence: real either/or. The kernel is one code distribution with one boundary. A closed engine cannot also be the open reference implementation; a kernel that includes the whole autopilot cannot also be the thing the paid product sells. The excluded branch under (a) is (b): the epic's Done-when needs a reference kernel passing the conformance cases, and the minting rule needs roles fillable by different vendors, which needs an inspectable implementation.

- (a) **Thin open kernel. Default.** State machines, validators, operations engine, one runtime, one forge binding; runs each step on request on one repo; plus the open verifier. Matches the brief, `#monetization` rule 2 and #098 point 3 (the reference implementation stays open; the line is drawn at Plateau). Citation scope: #098's "reference implementation" is Frontier UI and `webcases` is the web suite; they are extended by analogy to a delivery kernel and verifier, not held for them, and the comparables are infrastructure products, from memory, unverified (GitLab CE tiers some single-team features, so "one team is open" is a pattern, not a rule). Home caveat: the kernel's home is still #2446; ruling it open-tier does not place it in WE, and `#constellation-placement` (WE holds zero implementation) is untouched. With #5403: Apache-2.0, trademark and conformance mark as clone defence.
- (b) Standard and verifier only; the engine is closed Plateau code (the earlier ruling allows it). Maximum to sell, but the standard then has no credible implementation, adopters cannot try it, and it repeats the "company repo, not a standard" read #098 rejected. It would also flip #5403's kernel default to FSL-1.1 or closed.
- (c) Everything open, paid is hosting only. Strongest adoption, nothing to sell beyond hosted operation. Rejected: contradicts #098's bet that Plateau is the moat, and relicensing later is the HashiCorp and Elastic pattern that cost contributors.

Un-gate trigger to move the line: only toward more open, and only with a written reason (a competing closed autopilot gaining share under the standard). Moving it toward closed after adoption is the failure the report records.

Code example: n/a, a boundary and packaging call; the code surface follows from the ruling in the build.

Skeptic: SURVIVES-WITH-AMENDMENT. Mostly settled by precedent (rule 2, #098 point 3, epic Done-when); only where "thin" ends is live, and it depends on the autopilot placement below. Folded in: precedent framing, citation-scope caveats (Frontier UI and `webcases` extended by analogy; unverified infrastructure comparables; GitLab tiers some single-team features), the #2446 and `#constellation-placement` home caveat, and a dropped misquote.
Screen: clear (fresh-context screen: the open-engine boundary is consumer-visible, and a merit difference remains in inspectability and lock-in even if building were free).

## Single-repo autopilot (dissolved from a fork)

Screen flagged the first Fork 2 as `flagged(prio)`: with both branches free, what remains is revenue and funnel, since the scheduler seam is identical in both. Rewritten: not a fork. Following Fork 1(a), the epic's own tiers (kernel runs each step on request; Plateau Loop is tier 3, #2445) already place continuous dispatch and review panels in Plateau Loop. Recorded as a supported default, with the packaging stated for the operator to confirm or revise, since pricing is theirs:

- Plateau Loop is a paid local product under Gate 1 (`#monetization` rule 5 / #1655: free for non-commercial use, paid for commercial; FSL-tier code per #098 point 1). The kernel ships the step-on-request interface and a documented scheduler hook so anyone can write their own loop on it.
- This is a use-context licence, not a structural split, and the card says so plainly: single-repo autopilot has no hosted, credential-holding or cross-project step, so rule 1 alone would leave it open. A paid-local-loop ruling therefore carries a one-line note in `#monetization` that Plateau Loop is a Gate 1 product.
- Revisit trigger (a revenue call, so the operator's): the structural items alone carry revenue, or an open rival loop on the seam takes the funnel. Then moving autopilot into the kernel is an explicit `#monetization` amendment, not drift.

Skeptic: (first draft REFUTED as a fork default; see above) the attack that forced the flip (contradiction with Fork 1(a), #1655 over-read, rule 3, infrastructure-only comparables) is folded into this entry.
Screen: flagged(prio) -> dissolved to a supported default, as above.

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; codifiedIn names the monetization rule it amends or confirms.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
