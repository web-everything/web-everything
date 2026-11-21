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
preparedDate: "2026-11-20"
---

# Governance of the delivery standard: own org now, vendor-neutral core, later foundation move

Ask: Keep the operator as steward with written foundation-transfer criteria. Use DCO sign-off, or the CSL agreement if that licence is selected, rather than an owner-relicensing CLA.

## Digest

Prepared, not ratified. Two forks: custody of decisions/marks and inbound contribution terms. The updated foundation evidence and contribution scope replace the earlier update without duplicating it. Licence #5403, template #8623 and neutral-runner custody #8627 remain separate.

## Fork 1 — Steward now

Either/or concerns final custody, not scheduling: the operator or a foundation TC holds marks/final say, while advisory participation composes with either.

- (a) **Operator steward, neutral core and written move trigger (default).** GOVERNANCE names maintainer, decision rule, second-maintainer path, no-relicense promise and trigger: repo public, one unaffiliated party interested/implementing, and credible second unaffiliated production user within 12 months. Inbound foundation offer also triggers review.
- (b) Apply to AAIF Sandbox now: stronger neutral custody, but transfers unilateral control while format changes; needs public/scrubbed repo and starts a 12-month Growth clock.
- New nominally neutral org without foundation is excluded: same single-owner custody. Accept single-owner restriction risk; no-relicense, transferable marks and contribution terms mitigate, not guarantee.

Evidence:
- [AAIF Sandbox](https://aaif.io/blog/aaif-sandbox-phase), 2026-09-01, fetched 2026-11-20: working implementation plus external interest/credible thesis, active maintainer; six-month checkpoint, 12-month Growth window. Growth asks two unaffiliated production users and multi-org commits.
- `we:reports/2026-11-17-delivery-standard-governance.md` (MCP/Kubernetes/OCI/OpenAPI); `we:committee-2026-11-20/goals.md:15` recommends private incubation; seed examples need scrubbing.

Skeptic: SURVIVES-WITH-AMENDMENT; corrected private-state attribution and framed custody on merit. Screen: mild flagged(prio) rebutted: unilateral vs TC control remains.

## Fork 2 — Inbound terms (conditional)

Either/or: owner relicensing power cannot both be retained and surrendered. #098's CLA names WE/FUI/Plateau, not new everstandards repos.

- (a) **DCO 1.1 inbound=outbound (default), replaced by CSL contributor agreement if #5403(c).** Keeps same-licence foundation transfer possible and reduces unilateral relicensing power.
- (b) Extend owner CLA: preserves relicensing flexibility but weakens neutral-core trust; reject for standards. MCP's ongoing per-author relicensing consent is the counterexample to easy later changes.

If #5403(c) chooses CSL, its agreement already decides (a); this is live only under other licence choices.

Evidence: [DCO](https://developercertificate.org/), [CSL agreement](https://github.com/CommunitySpecification/Community_Specification/blob/main/00-contributor-license-agreement.md), [MCP licence](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/LICENSE), fetched 2026-11-20; #098:99-101.

Skeptic: SURVIVES-WITH-AMENDMENT; corrected scope and made CSL dependency explicit. Screen: clear.

## Supported by default

- No vendor names in core schemas/registries/vectors; vendor specifics in bindings. Keep standard marks separate from Plateau.
- Human-gated spec changes never share an implementation PR. One steward; governance still documented per repo.
- No meta repo until another standard actually needs shared parts; #8633 or #8627 can trigger extraction of template/tool. Track source versions meanwhile.
- Legal/home decisions remain #5403/#5402; upstream OWS engagement coexists with either steward.

## What ratifying unlocks

GOVERNANCE/CONTRIBUTING follow-up with transfer trigger, no-relicense promise and DCO/CSL terms. “D12 yes” accepts both defaults as applicable; no publication.

## Trust boundary and threat model

Foundation pages are dated third-party evidence. Full transfer policy was unreadable in prep: re-check at trigger time. Accept no outside contributions until CONTRIBUTING exists.

Full prep (Standards decisions-prep set):

```text
D12-5409.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
D12-5409.md
```
