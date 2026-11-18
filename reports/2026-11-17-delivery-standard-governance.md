# Prior art: governance of the delivery standard (#5409)

Date: 2026-11-17. Prepared for the operator. Governance is an operator-only call; this report prepares options and a recommendation, it does not rule. Facts below are from memory of public history; verify before citing externally.

## Ground in this repo

- Sibling calls prepared in the same lane: #5402 (home: new standard-only repo, default (a)) and #5403 (licence: standard = Apache-2.0 plus CC BY 4.0 per #098, kernel default Apache-2.0). This card must stay consistent: the repo from #5402 is what gets governed, and the licence from #5403 is what keeps a later foundation move possible (permissive plus patent grant is what foundations accept).
- #098 (resolved) already ruled: trademark and conformance mark are the enforcement lever; a CLA is a contribution blocker on WE, Frontier UI and Plateau. A foundation move needs the marks and the contribution terms to be transferable, so both rulings are inputs, not open questions here.
- The epic #5407 puts the open kernel at tier 2 and paid Plateau Loop at tier 3. Governance of the standard must not depend on the paid tier.

## How comparable standards were governed

Pattern: almost every standard that is now foundation-hosted started under one company or person, and moved once several independent implementers existed.

- MCP: Anthropic published it Nov 2024; contributed to the Linux Foundation's Agentic AI Foundation (AAIF, Dec 2025) about 13 months later, alongside Block's goose and OpenAI's AGENTS file convention. A2A (Google, Apr 2025) went to the Linux Foundation as its own project (Jun 2025), not inside AAIF as the card implies.
- Kubernetes: Google, 1.0 plus CNCF donation in Jul 2015. OCI: Docker donated runtime and image spec in 2015. OpenAPI: SmartBear donated Swagger, forming the OpenAPI Initiative (2015). GraphQL: Facebook, then GraphQL Foundation (2018). SLSA: Google, then OpenSSF. Each moved after multi-party adoption, with trademarks transferred.
- OpenTelemetry: born in the CNCF from the merger of OpenTracing and OpenCensus (2019); no single-owner phase.
- Counter-evidence: HashiCorp kept Terraform under its own control and relicensed; the community forked to OpenTofu under the Linux Foundation. The risk of staying single-owner is a fork if the owner later restricts, which the Apache-2.0 plus trademark choice in #5403 answers only partly.

Lesson: single-owner start is the norm; the move is triggered by adoption, not scheduled. Foundations add neutrality, a technical steering committee, and trademark custody, at the cost of fees, slower decisions and loss of unilateral control. A foundation that is handed a standard with no second implementer has little to govern.

## What a foundation move needs ready in advance

- Name and trademark held separately from commercial brands (Plateau), so the standard's mark can be transferred without moving the product's.
- Neutral core: no vendor names in schemas, role registry or conformance cases; vendor specifics live in bindings (Claude Code, Codex, GitHub), which may sit in separate repos.
- Contribution terms that allow transfer (the #098 CLA, or Apache-2.0 inbound=outbound with sign-off).
- Written governance so a successor can inherit it: a short governance file (maintainer, decision rule, how a second maintainer is added, the move trigger).

## Options for "now"

| Option | Speed | Neutrality signal | Cost | Fit |
|---|---|---|---|---|
| Own org, neutral core, written trigger for a later move | fastest | medium until trigger | near zero | matches brief, #5402, #5403 |
| New neutral org now (no foundation) | fast | medium-high | extra admin, still single owner | little gain over own org |
| Apply to a foundation now | slow | highest | fees, process, control loss | premature: no second implementer yet |

## Recommendation (prepared, not ruled)

Own GitHub org now (the one that holds the #5402 repo), vendor-neutral core, a written governance file, and an explicit foundation-move trigger: a second independent implementer or an inbound foundation offer, whichever comes first. Everything on the "needs ready" list is done at the start, because it is cheap then and expensive after adoption.
