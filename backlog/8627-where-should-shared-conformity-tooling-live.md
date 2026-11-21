---
bornAs: x7ubblz
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5490", "5403", "098", "5488"]
preparedDate: "2026-11-20"
---

# Where should shared conformity tooling live?

Ask: Move the neutral reference tester to open everstandards tooling under Apache-2.0. Explicitly amend the earlier private-Plateau ruling; hosted services can remain Plateau's product.

## Digest

Prepared, not ratified. One real custody fork: the existing neutral executable judge is in private plateau-app. Other self-checks, drivers, shared schemas and Longshore code-shape conformity are separate concerns. Default **open everstandards runner** amends the prior #1566 placement bound.

## Fork 1 — Custody of the neutral judge

Either/or: one release home owns judging semantics/matchers; two independent judges could diverge over identical vectors.

- (a) **Open everstandards runner, Apache-2.0/DCO (default).** Shared meta repo when justified, otherwise everstandards/conformance. WE/Longshore/Plateau consume it. Lead reason: #1566 asks for a non-implementer judge, but Plateau is Ship's L1 producer and Longshore its L3 placer; everstandards implements neither. Outsiders can run the reference self-test.
- (b) Private plateau-app status quo: existing tested runner, but *rejected* because Plateau is a Ship contestant and outsiders cannot run the reference judge.
- (c) Separate per-standard judges. *Rejected:* matcher/report drift; rule packs/drivers already permit variation without duplicate judges.
- (d) WE hosts executable runner. *Excluded:* zero-implementation placement.
- (e) Longshore hosts runner. *Rejected:* Ship contestant judging itself, same neutrality flaw.

Evidence:
- `plateau-app:packages/core/src/conformance-engine/conformanceVectors.ts` (306 lines), header and :32 Finding import from tools/explorer/oracles/observation; existing deck/intl/webcompliance/webpolicy suites.
- `we:docs/agent/platform-decisions.md#constellation-placement` (prep cites :194), #1566:18-40; #5488 S3 and #098 open-suite guarantee support the move but do not already authorize it.
- `we:everstandards-format-2026-11-20.md:60` names Plateau's producer class; `2026-11-20-gov-stewards-legal-namespaces` §B; [Google licence categories](https://opensource.google/documentation/reference/thirdparty/licenses), fetched 2026-11-20. Apache suits adopter CI; AGPL/FSL would restrict embedding.

Statute delta proposed: “neutral conformance run for an everstandard is an open everstandards tool; Plateau may host/present it.” First move Finding into shared report schema, then run existing suites against moved runner before deleting old copy.

Skeptic: SURVIVES-WITH-AMENDMENT; neutrality leads, #098 is supporting only, Longshore alternative explicit and locator corrected. Screen: clear.

## Supported by default

- Shared vector/manifest/report schemas live with runner as data; WE re-exports its type-only package to preserve clients. Explicit manifest L0–L2/webcases L1–L3 mapping follows #8631.
- Declarative self-checks stay per standard (WE we:capability-manifest/check.ts); implementation bindings/DOM drivers/crash-replay harness stay with adopters.
- Longshore @longshore/conformity code-shape ratchet is a separate engine tool; stays Longshore (`longshore-conformity-tool-prep`).
- Plateau can sell hosted history/badges/UI on the open judge; webcases remains Apache permanently. Steward #5409; repo review files LICENSE/SPDX/SECURITY/CODE_OF_CONDUCT/GOVERNANCE/MAINTAINERS/trademark note.

## What ratifying unlocks

Scoped #5490 runner move, equivalence proof and consumer repoint, with statute amendment. “D17 yes” must explicitly accept amending #1566; licence/stewardship follow shared decisions. This card itself moves no code.

## Trust boundary and threat model

Implementation traces and submitted vectors are untrusted. Pin matcher/schema releases and suite results; do not accept a new judge as equivalent before existing suites pass.

Full prep (Standards decisions-prep set):

```text
D17-x7ubblz.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-gov-stewards-legal-namespaces.md
D17-x7ubblz.md
longshore-conformity-tool-prep.md
```
