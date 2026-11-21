---
bornAs: xrwfs5j
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407"]
preparedDate: "2026-11-20"
---

# Build on existing event, attestation and findings norms?

Ask: Reuse event, signed-evidence and findings formats; define only Ship's missing concepts. Confirm the pinned bindings and three-state verdict.

## Digest

Prepared, not ratified. N1 norms, S1 metrics and B1 benchmark research yields one forced fork plus five ratify lines. Layered norms coexist, but CDEvents cannot become stable core unchanged; verdict partly reuses prior art and “lever” remains undefined.

## Fork 1 — CDEvents core or binding

Forced invariant: a stable module cannot adopt a defective 0.x normative dependency.

- (a) **BIND tier 1 at v0.5.1 (default):** preserve native records/ids, publish unmapped/lossy cases, do not enforce the stale specversion literal; re-pin per release.
- (b) ADOPT as core. *Excluded:* 0.x/undefined release process and text demanding specversion 0.1.1 while examples use 0.5.1 would reject valid records.
- (c) Invent lifecycle events. *Excluded:* duplicates existing DORA/time-to-merge coverage.

Evidence:
- `2026-11-20-es-adopted-norms` §4/9, [CDEvents v0.5.1 spec](https://github.com/cdevents/spec/blob/v0.5.1/spec.md), [releases](https://api.github.com/repos/cdevents/spec/releases), fetched 2026-11-20.
- `2026-11-20-ship-benchmark`: Run.finished has success/failure/cancel/error, no unknown.

Skeptic: SURVIVES; pinning does not repair normative defects, while binding preserves records. Screen: clear.

## Ratify — forced invariants

- **R1 Native evidence stays native**, original id beside Ship mapping; no generic replacement.
- **R2 Pin versions:** CloudEvents 1.0.2, in-toto Statement v1/framework 1.2.0, SLSA 1.2, SARIF 2.1.0 + Errata 01 (watch 2.2), OTel v1.45.0; patch the stale format note.
- **R3 OTel development and release-candidate names remain mapped views**, including cicd/vcs; DORA also maps. gen_ai v0.1.0 is development/tier 3. Release-candidate exclusion deliberately extends SE-OBS-001.
- **R4 No lever wire type until its meaning is defined.** Claim/handoff/verdict remain Ship's delta.
- **R5 Verdict is pass|fail|unknown**, with required reason (missing/stale/inconclusive), policy and evidence[], in an in-toto predicate; namespace follows #8626. Publish lossy SARIF pass/fail/open, Eiffel SUCCESS/FAILURE/INCONCLUSIVE and CDEvents/OTel mappings. Never map unknown to VSA PASSED. A binary verdict is broken; adapting existing names and defining Ship terms compose, so this is not a second fork.

Evidence: N1 SE-BND-001/SE-VRD-001, [SARIF schema](https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json), [VSA](https://slsa.dev/spec/v1.2/verification_summary).

## Supported by default

- CloudEvents envelope; in-toto/SLSA/Sigstore signed evidence; SARIF findings; [DORA](https://dora.dev/guides/dora-metrics/) and [OTel metrics](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-metrics/) as views. Eiffel tier 2.
- Work claims are leases (item URI, claimant, expiry), separate from attestation claims. Handoff records sender/recipient/subject/acceptance/transfer time, with CDEvents links or Eiffel CAUSE. Enterprise IO adapters belong in Longshore/Plateau.
- CDEvents custom registry may additionally register matching Ship events under its native naming rules. Recheck SARIF IPR before publication.
- #8630 release scope and #8633 authoring order are separate: bindings work under either; readout Candidate first need not change protocol authoring order.

## What ratifying unlocks

Norm-note corrections, per-module binding tables, verdict-predicate draft and lever-definition follow-up. No publication or seed changes. “D7 yes” accepts these picks.

## Trust boundary and threat model

External evidence is untrusted: verify subject digest, signer and policy. Empty SARIF results do not prove a scan ran. Freeze norm versions per release; crypto soundness itself is out of scope.

Additional primary evidence: [source 1](https://in-toto.io/Statement/v1).

Full prep (Standards decisions-prep set):

```text
D7-xrwfs5j.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-es-adopted-norms.md
2026-11-20-ship-benchmark.md
D7-xrwfs5j.md
```
