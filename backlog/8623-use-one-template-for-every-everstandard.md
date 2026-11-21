---
bornAs: x25bedj
kind: decision
parent: "5407"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5407", "5409"]
preparedDate: "2026-11-20"
---

# Use one template for every everstandard?

Ask: Share machine-readable requirements, traceability, vectors and maturity rules. Let schemas govern data, prose govern behaviour, and require two independent passing implementations for Stable.

## Digest

Prepared, not ratified. M1 standard-models and N1 adopted-norms research produces three forks: shared interchange core (forced), source precedence and Stable evidence. Authoring pipelines remain free; #8631 exports WE's existing source into shared shapes.

## Recommended path at a glance

| Fork | Bold default | Alternative | Confidence |
|---|---|---|---|
| 1 | **Shared interchange core** | independent formats | High |
| 2 | **Model for data, prose for behaviour** | prose always wins | Med-high |
| 3 | **Two independent suite passes for Stable** | judgment or prior art | High |

## Fork 1 — Shared interchange core

Forced invariant: #5488 S3's common runner cannot audit unrelated input shapes.

- (a) **Shared machine-checked interchange (default):** BCP 14 ids; per-module traceability for every MUST/MUST NOT/SHOULD/SHOULD NOT to vector or typed exclusion; common vectors, class × cumulative level + features profiles, RFC 8126 registries, per-requirement/module maturity. Unmapped normative statements fail CI; MUST vectors fail, SHOULD vectors warn; disputed vectors do not count.
- (b) Independent formats. *Excluded:* breaks cross-standard runner/audit. Domain content and authoring freedom compose on (a).
- (c) Mandate ReSpec/Bikeshed. *Excluded as mandate:* source authoring is invisible across the boundary; supported as optional source/renderers.

Evidence: `2026-11-20-es-standard-models` (M1), `2026-11-20-es-adopted-norms` (N1); [MCP SEP-2484](https://modelcontextprotocol.io/seps/2484.md) maps every MUST to a check; Kubernetes we:conformance.yaml. Fetched 2026-11-20.

Skeptic: SURVIVES-WITH-AMENDMENT; model-first authoring/spec lint moved to house defaults, optionality surfaced below. Screen: flagged(impl) → corrected.

## Ratify — optional behaviour

**MAY is allowed; any variation changing conformance or interop must be a declared profile feature.** Excluded: banning optionality outright conflicts with bound CloudEvents/SLSA practice. Unknown extensions never satisfy or change core requirements; features never weaken MUSTs.

## Fork 2 — Which source wins

A module needs one authoritative precedence rule; data and behavioural constraints require separate homes.

Fork existence: the options are mutually exclusive precedence rules; (b) is the excluded branch.

- (a) Prose always wins (OpenAPI): familiar, but stale schemas mislead machine consumers.
- (c) **Model governs data shapes; BCP 14 prose governs behaviour; vectors never govern (default).** Generated forms are rebuilt in CI. Cross-kind disagreement marks the requirement disputed, counting toward no level until fixed.
- (b) Model governs all behaviour. *Excluded:* JSON Schema cannot express all behaviour; no supporting precedent.

Evidence: M1 C3; [OpenAPI](https://spec.openapis.org/oas/latest.html), [A2A](https://github.com/a2aproject/A2A/blob/main/docs/specification.md), [OTel conventions](https://opentelemetry.io/docs/specs/semconv/how-to-write-conventions/), MCP SEP-2484. A2A's authority concerns data objects; MCP's disagreeing-test rule concerns vectors, not prose/schema precedence.

Skeptic: SURVIVES-WITH-AMENDMENT; corrected those two claims and added cross-kind disputes. Screen: clear.

## Fork 3 — What earns Stable

One shared label must have one checkable meaning; prior art alone cannot prove suite conformance.

Fork existence: the Stable bars are mutually exclusive, since one label cannot carry two meanings.

- (a) **Two independent implementations pass the pinned release (default).** Candidate needs vectors plus one pass. Independence means distinct codebases/no shared normative-path code plus distinct declared org/author, ratified in the registry; same-org pairs count only if explicitly allowed by the module. Apply per requirement; module maturity cannot exceed its least-mature MUST.
- (b) Evidence proportional to impact. *Excluded:* needs subjective judgment.
- (c) Convergent prior art counts as Stable. *Excluded for Stable:* has not passed this suite; may ground Candidate entry with a reference mapping. Modules may raise, never lower, the bar.

Evidence: M1 C5, SE-ES-018/023; [TC39 Stage 4](https://tc39.es/process-document/), [RFC 6410](https://www.rfc-editor.org/rfc/rfc6410.html). OASIS uses three attestations; W3C uses judgment, both counter-precedents.

Skeptic: SURVIVES-WITH-AMENDMENT; defined independence and per-requirement granularity; corrected precedent claims. Screen: clear.

## Supported by default

- Model-first authoring with generated Schema 2020-12 and stale-file/spec lint is a house default, not a mandate. Free modules, bindings, prose and pipelines.
- Living head plus immutable releases; pinned suites; registered extension track and `x-` Private Use; freely fetchable specs. Licence #5403, governance #5409, namespace #8626, runner #8627.
- Norm pins: SLSA 1.2, CDEvents BIND v0.5.1, OTel v1.45.0 mapped views; defer gen_ai. Correct the format note through follow-ups.
- Binding lifecycle (`standards.normSunset`, 2026-11-21): active → watch → deprecated → removed. Watch release/governance/security/adoption/successors. Deprecation names successor or absence; overlap ≥12 months or 2 minor releases, whichever longer. Ship adapters/migrations and test both bindings. Without successor, freeze/hash/mirror a maintained profile only if licensed; otherwise fill the native-core gap. Track consumers on deprecated bindings.

## Must-hold rules from the threat-model red team

- Ratifier approves disputes/exclusions and model changes; unresolved/excluded requirements block Stable.
- Ratified independence registry plus code-origin record; every MUST mapped, none disputed, and a cross-implementation run for Stable.
- Features never weaken MUSTs; 0.x norms cannot back Stable; pin commits/content hashes.

Details: `_redteam-format-group`.

## What ratifying unlocks

Ship migration requirements/registries/profiles/vectors and traceability/spec lint work under #8627. “D6 yes” takes (a)/(c)/(a) and optionality. Ship stays frozen until #8623/#8632/#8633 and operator go.

## Trust boundary and threat model

Agent prose is untrusted until human review/lint; external implementations/vectors need attributed pinned results. Disputes never silently become conformance evidence.

Additional primary evidence: [source 1](https://modelcontextprotocol.io/community/sep-guidelines).

Full prep (Standards decisions-prep set):

```text
D6-x25bedj.md
```

Source and proposed artifact filenames (handoff references are by name only):

```text
2026-11-20-es-adopted-norms.md
2026-11-20-es-standard-models.md
D6-x25bedj.md
_redteam-format-group.md
```
