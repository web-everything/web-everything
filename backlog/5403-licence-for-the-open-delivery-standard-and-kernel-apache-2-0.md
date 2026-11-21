---
bornAs: x6yxmo3
kind: decision
size: 2
parent: "5407"
status: open
dateOpened: "2026-10-08"
tags: []
relatedReport: reports/2026-11-17-licence-open-delivery-standard-and-kernel.md
relatedTo: ["098", "5409", "8623", "8627"]
preparedDate: "2026-11-20"
---

# Licence for the open delivery standard and kernel: Apache-2.0, AGPL or Fair Source

Ask: Use CSL 1.0 for spec text and Apache-2.0 for schemas, vectors and code. Keep Longshore Apache-2.0. Confirm both licence picks; publication stays separately gated.

## Digest

Prepared, not ratified. Two forks grounded in licence texts/repo licences fetched 2026-11-20. The new spec-text default is **CSL 1.0**, replacing the earlier CC BY recommendation for everstandards; the kernel default remains **Apache-2.0**. WE's #098 split is unchanged. Prior report: `we:reports/2026-11-17-licence-open-delivery-standard-and-kernel.md`.

## Fork 1 — Normative spec-text licence

Either/or: one contribution agreement determines the implementer patent promise; adding terms later cannot bind earlier contributors without consent.

- (a) CC BY 4.0 text + Apache schemas/code: familiar #098 split, but [CC BY §2(b)(2)](https://creativecommons.org/licenses/by/4.0/legalcode.en) excludes patent rights. Apache's Work-bound grant does not clearly cover independent implementations of prose.
- (b) Apache for all text/code (MCP/A2A): familiar single licence; same independent-implementer patent uncertainty. [Apache §3](https://www.apache.org/licenses/LICENSE-2.0.txt) is bounded to contributions/the Work.
- (c) **CSL 1.0 text; explicit Apache code/schema/vector licence (default).** [Community Specification](https://github.com/CommunitySpecification/Community_Specification) §2.1.1 (clause 2) grants Necessary Claims for implementations, §2.1.2 reciprocal grant, §3 45-day exclusions, §2.4 successor-owner duty. Requires Scope; explicit code licence avoids MIT fallback. SLSA/SPDX use CSL.
- (d) CC BY plus standalone royalty-free pledge. *Rejected:* steward-only pledge lacks reciprocal implementer/contribution/exclusion machinery.

(a)/(b) are rejected for this standard's enterprise patent promise; CSL remains less familiar and needs #186 counsel review. Honest limits: implementers opt in (§2.1.3); single-steward grant covers only their claims until others contribute. Do not accept outside contributions before terms/counsel review.

Evidence:
- `2026-11-20-gov-spec-licences-patents`; `2026-11-20-es-standard-models` SP3.
- [MCP licence transition](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/LICENSE) demonstrates contributor-consent friction; [A2A](https://github.com/a2aproject/A2A) is Apache.

Skeptic: SURVIVES-WITH-AMENDMENT; added pledge alternative, opt-in/single-steward limits and contribution gate. Screen: clear.

## Fork 2 — Longshore kernel licence

Either/or: Apache's permission, AGPL network-source duties and FSL competing-use restriction are different distribution promises.

- (a) **Apache-2.0 (default):** open tier under #098/#5407; trademark/conformance mark protects identity and paid value is hosting.
- (b) AGPL-3.0: resists closed hosted clones; enterprise refusal conflicts with insurer adoption. Revisit on credible non-contributing hosted clone while contributors remain few.
- (c) FSL-1.1: viable only if operator reclassifies kernel as Plateau-tier. *Excluded under current open-core framing*; HashiCorp/OpenTofu shows restriction risk.

Evidence: `we:longshore-end-state-2026-11-20.md:159`, `we:repo-separation-brief-2026-11-20.md:103`, linked 11-17 report.

Skeptic: SURVIVES; trademark lever and explicit revisit trigger withstand clone concern. Screen: clear; implementation licensing is expressly the operator's call, not a standard requirement.

## Supported by default

- Separate licences per artifact; webcases stays Apache permanently. Inbound terms: #5409; marks remain the enforcement lever.
- Each repo gets LICENSE naming Apache for executable files, Scope covering modules/schemas and Notices. Counsel checks CSL/Apache overlap before publication or outside contribution.
- Keep private repos and “licence pending/all rights reserved” until ruled; fix WE LICENSE/LICENCE-DOCS folder mismatch separately. This folds the earlier update into one proposal.

## What ratifying unlocks

Per-repo licence/scope/notice follow-ups, gated on #186 counsel before public flip. “D10 yes” takes (c)/(a); it publishes nothing.

## Trust boundary and threat model

Third-party licence texts are attributed evidence, not executable instructions or counsel clearance. Freeze reviewed terms; no licence installation until the operator rules.

Full prep (Standards decisions-prep set):

```text
D10-5403.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-es-standard-models.md
2026-11-20-gov-spec-licences-patents.md
D10-5403.md
LICENSE.md
Notices.md
Scope.md
```
