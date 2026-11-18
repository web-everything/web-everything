---
bornAs: x6yxmo3
kind: decision
size: 2
parent: "5407"
status: open
dateOpened: "2026-10-08"
preparedDate: "2026-11-17"
preparedAgainstSha: "7491c6ecda714ea2590065f2a2e3c166b306d9bc"
tags: []
relatedReport: reports/2026-11-17-licence-open-delivery-standard-and-kernel.md
---

# Licence for the open delivery standard and kernel: Apache-2.0, AGPL or Fair Source

Source: AI Delivery Landscape research brief, 2026-10-08, section 'Where the open line sits' (licence options and 'pick the licence once'). Options: Apache-2.0 for the most adoption (brief's recommendation for the open parts); AGPL to deter closed clones while staying open source (Grafana, Redis 8, Elastic); Fair Source (FSL) if two years of non-compete matter more than being called open source. Market evidence: HashiCorp's BSL switch cut community PRs from 21% to 9% and produced OpenTofu; Redis relicensed and reversed after ~14 months. The standard and kernel may take different licences. Operator's call; not ruled here.

## Prepared fork (operator-only call; options and a recommendation, not a ruling)

Ground: [#098](/backlog/098-licensing-strategy/) (resolved) already set a gradient: standard = CC BY prose plus Apache-2.0 code and schemas; reference implementation (Frontier UI) = Apache-2.0; platform (Plateau) = FSL-1.1 with a 2-year Apache conversion; `webcases` conformance suite = Apache-2.0 permanently; trademark policy is the enforcement lever (#098 point 4); a CLA is a contribution blocker. `LICENSE` and `LICENSE-DOCS` ship the standard split. The epic #5407 places the open kernel as tier 2, below the paid Plateau Loop (tier 3). Prior art: [report](/reports/2026-11-17-licence-open-delivery-standard-and-kernel/).

Standing test result: the **standard** licence is settled by precedent (#098), so it is **not a fork**: ratify it. Only the **kernel** has a live either/or, because the card never says which #098 tier the kernel belongs to.

| Fork | Options | Default |
|---|---|---|
| 1. Kernel licence | (a) Apache-2.0 (open reference-implementation tier); (b) AGPL-3.0; (c) FSL-1.1 (platform tier) | **(a)** |

Settled / supported by default (not forks):
- Standard (spec, schemas, conformance cases): Apache-2.0 code and schemas plus CC BY 4.0 prose, per #098. Ratify; no change. Housekeeping: `LICENSE` lists `docs/`, `research/`, `backlog/` as prose while `LICENSE-DOCS` also lists `reports/` and site pages; align the two in the build that follows.
- Trademark and conformance-mark policy: #098 point 4, already ruled.
- Contributor terms: #098 already made a CLA a contribution blocker; do not reopen DCO vs CLA here, only confirm it covers the kernel repo (#2446 option (b), own repo).

## Fork 1 — Kernel licence

Fork-existence: real either/or. One code distribution cannot be both Apache-2.0 (anyone may close it) and AGPL (network use forces source release) or FSL (competing use barred for two years). Which tier the kernel sits in decides the answer, and #098 puts the reference implementation and the paid platform on different licences.

- (a) **Apache-2.0. Default.** The epic calls the kernel open and tier 2, the funnel below the paid Plateau Loop; #098 gives the open reference implementation Apache-2.0 so the standard looks credible, not captive. Clone defence comes from trademark and the conformance mark (#098 point 4), and the paid value stays in Plateau Loop, not the kernel.
- (b) AGPL-3.0: deters closed hosted clones while staying open source (Grafana kept it without a fork). Cost: many companies refuse AGPL, and it departs from #098's Apache choice for the open tier, so it needs a reconciliation note against #098.
- (c) FSL-1.1: only right if the kernel is really Plateau-tier. Not open source, and it contradicts the epic's "open kernel" framing and the HashiCorp lesson (relicensing or restricting after adoption cost contributors and spawned OpenTofu).

Un-gate trigger to revisit (b): a credible hosted clone of the kernel from a party not contributing back, seen while outside contributions are still few.

Code example: n/a, a legal call with no code surface.

Skeptic: SURVIVES-WITH-AMENDMENT after a first-draft REFUTED. The attack found that #098 already rules the tiers and the draft had wrongly made the standard a fork and claimed the trademark and CLA calls were open. Folded in: the standard licence moved to "settled by precedent", the trademark and CLA lines now cite #098, the kernel-tier ambiguity became the stated fork-existence line, and the report's factual errors were fixed (AGPLv3 has an explicit patent grant; FSL also grants patent rights; Redis added AGPL alongside its source-available licences rather than reversing). If the operator says the kernel is Plateau-tier, flip the default to (c) FSL-1.1 per #098.
Screen: clear (fresh-context screen: a licence is a consumer-visible legal term, and a merit difference remains even if building were free).

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; the chosen licence(s) per tier are recorded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
