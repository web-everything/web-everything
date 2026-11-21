---
bornAs: xqgn58j
kind: decision
size: 2
parent: "5407"
status: open
dateOpened: "2026-10-08"
relatedReport: reports/2026-11-17-delivery-standard-governance.md
tags: []
relatedTo: ["5403", "8623", "8627"]
---

# Governance of the delivery standard: own org now, vendor-neutral core, later foundation move

Source: AI Delivery Landscape research brief, 2026-10-08, sections 'Open decisions' item 6 and 'Closest existing efforts' (Agentic AI Foundation). Starting under the operator's own GitHub org keeps speed; a vendor-neutral core keeps a later move to the Linux Foundation's Agentic AI Foundation (home of MCP and the agent-instructions file standard; A2A is a separate Linux Foundation project, per the report) possible. Brief's recommendation: own GitHub org, open licence, no vendor names in the core; bindings carry vendor specifics (Claude Code, Codex, GitHub). Operator's call; not ruled here.

## Prepared fork (operator-only call; options and a recommendation, not a ruling)

Ground: [#5402](/backlog/5402-delivery-protocol-home-separate-repo-now-or-incubate-inside/) (default: a new standard-only repo) and [#5403](/backlog/5403-licence-for-the-open-delivery-standard-and-kernel-apache-2-0/) (default, not yet ruled: Apache-2.0 plus CC BY 4.0) set what is governed and under which terms (both still open, so this card inherits their defaults); [#098](/backlog/098-licensing-strategy/) (resolved) already rules the trademark and conformance-mark lever and the CLA. Prior art: [report](/reports/2026-11-17-delivery-standard-governance/). Comparable standards (MCP, Kubernetes, OCI, OpenAPI, GraphQL, SLSA) mostly started under one owner and moved to a foundation after several independent implementers appeared.

Standing test result: one real fork (who holds control now). The "vendor-neutral core" and the foundation-readiness items are not forks: they are required for any answer, so they sit in the supported list.

| Fork | Options | Default |
|---|---|---|
| 1. Steward of the standard now | (a) own org now, written trigger for a later foundation move; (b) apply to a foundation now | **(a)** |

Settled / supported by default (not forks):
- Vendor-neutral core: no vendor names in schemas, role registry, policy dimensions or conformance cases. Vendor specifics (Claude Code, Codex, GitHub) live in bindings, which may be separate repos. Needed under both options.
- Foundation-readiness, done at the start (cheap now, costly after adoption): the standard's name and mark held apart from Plateau's commercial marks, with a conformance mark for the standard registered to the standard's own org (#098 point 4 names WE marks only; `we:docs/agent/platform-decisions.md#constellation-placement` as amended by #5402 homes non-web contract content outside WE, so a WE mark must not cover it); contribution terms that allow transfer: for the standard repo, inbound=outbound Apache-2.0 sign-off (DCO) rather than the owner-relicensing CLA that #098 requires for WE, Frontier UI and Plateau (a follow-up extends or exempts the #098 CLA for the new repo), plus a no-relicense commitment in the standard repo's governance file; a short the standard repo's governance file (maintainer, decision rule, how a second maintainer joins, the move trigger).
- Licence and repo home: ruled by #5403 and #5402, not reopened.

## Fork 1 — Steward of the standard now

Fork-existence: real either/or on custody, a merit difference and not only timing (neutral multi-party custody of marks and final say vs single-owner control; foundation-style rules and a written trigger can coexist, so the fork is only who holds them now). The standard has one steward at a time: either the operator holds decisions and marks (a), or a foundation's steering committee does (b). They cannot both hold the marks and the final say, and adopting (b) means transferring them.

- (a) **Own GitHub org now, neutral core, written trigger for a later move. Default.** Foundations took MCP, Kubernetes, OCI and OpenAPI after multi-party adoption, not before. With no second implementer there is nothing for a foundation to govern, and applying now costs time, fees and control for no neutrality anyone is yet asking for. The foundation path stays open because #5403 defaults to a permissive licence with a patent grant, the standard repo takes DCO-style inbound terms so contributions stay transferable, and the readiness list above is done up front. Trigger to move: a second independent implementer, or an inbound foundation offer, whichever comes first.
- (b) Apply to a foundation now (for example the Linux Foundation's Agentic AI Foundation). Strongest neutrality signal, and adopters who fear single-vendor control may prefer it. Cost: process and fees, loss of unilateral control while the design is still moving, and a standard with no implementers to staff a steering committee. Revisit only if the operator wants neutrality as the launch message.

Rejected: a new neutral org with no foundation behind it adds admin for the same single-owner reality. Risk accepted under (a): single-owner standards can be restricted later and forked (HashiCorp, then OpenTofu); the Apache-2.0 licence, the no-relicense commitment, the transferable marks and the written trigger are the mitigation, not a guarantee.

Code example: n/a, an ownership and governance call with no code surface.

Skeptic: SURVIVES-WITH-AMENDMENT. Default (a) held; no statute collision (#constellation-placement covers code placement only; #5402's amendment cited). Folded in: CLA is a relicensing vector (HashiCorp pattern), so the standard repo takes DCO-style inbound terms plus a no-relicense commitment, and the CLA is not claimed as already covering the new repo; whose mark covers the standard is now stated; #5403 marked as a pending default, not a ruling.
Screen: flagged(prio) → rebutted and clarified. Screener read the fork as timing only. Kept as a fork because custody (who holds the marks and final say) differs on merit even if both were free and instant; the fork-existence line now says so, and timing is carried by the written trigger. Impl-detail question: clear.

## Done when

1. **Executable** — n/a: a decision, no code. Tier 3 instead: the card is prepared (`/prepare`: options, rejection reasons, bold default, `preparedDate`), then the operator rules it and the ruling is recorded on the card; if (a), a follow-up card writes the standard repo's governance file and the foundation-move trigger into the standard repo.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
2. **Truncated reads** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
3. **Shared state files** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
4. **Fail closed** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
5. **Identity scoping** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
6. **State over time** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.
7. **Who wrote it** — n/a: a decision card; it changes no code. Any build it spawns carries its own edge cases.

## Update 2026-11-20 (D12, decisions page)

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.
Decision id: D12 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

### Digest / context

**Operator as steward now (default), with DCO contributions and a written foundation-transfer trigger. No shared meta repo until a second standard actually needs one.** Source: [handoff format design](designs/everstandards-format-2026-11-20.md) “Template detail” / “Operator decisions”, and [repo-separation brief](designs/repo-separation-brief-2026-11-20.md) §1.6. Reuse the existing governance research above.

### Fork 1 — Stewardship update

Fork-existence: final custody of decisions and marks cannot simultaneously belong to the operator and an independent foundation; advisory participation can coexist with either.

- (a) **Operator as steward, neutral core, DCO and written foundation trigger (default).** Continue the prepared option above; keep transfer possible.
- (b) Foundation stewardship now. Stronger independent custody, with governance/process obligations before multiple implementers exist.

Skeptic: A written future trigger cannot guarantee relinquishing control. Reuse the existing no-relicense/transferability safeguards and name the authority and transfer procedure, rather than promise neutrality from the org name.
Screen: pending delta prep; custody remains a merit difference even with cost stripped out.

### Supported by default — optional meta repo

A template/vector schema and per-standard repos are compatible. **No meta repo until a second standard actually needs it (default)**; creating one then is supported. Creating it now adds a shared release/maintenance surface without a demonstrated consumer; this is sequencing rather than a competing standards architecture. D17’s common tool is a separate ownership decision and does not imply a meta repo.

Skeptic: Waiting could duplicate templates and cause drift. Track the shared source/version explicitly now and trigger extraction when the second actual standard needs it.
What ratifying unlocks: one accountable steward and contribution/transfer terms, without creating an unneeded repo. Operator answers: “D12 yes” accepts stewardship plus the meta-repo trigger.
Prep still needed: verify current governance/contribution terms and transfer trigger, inspect second-standard demand and independently attack both defaults. Prepared metadata remains unchanged; these new deltas still need prep.
