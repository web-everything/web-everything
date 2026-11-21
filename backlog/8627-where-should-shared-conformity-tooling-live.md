---
bornAs: x7ubblz
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, everstandards]
relatedTo: ["5490", "5403", "098", "5488"]
---

# Where should shared conformity tooling live?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D17 (decisions page, 2026-11-20 20:58 ET)
Placement: everstandards
move-to: everstandards

## Digest

Recommend a common non-normative conformity tool in everstandards, consumed by WE with standard-specific rule packs. Reuse WE’s existing manifest/vector/webcases work rather than rewriting it.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

The page asks for research and gives no pick. [handoff design]() “Conformance” and [handoff design]() §1.6 call for a runner. The inventory below grounds this filing-stage recommendation; #5488 S3/#5490 supplies migration lineage, not an already shipping common tool.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Custody of the common runner | (a) | (b) | Provisional; needs prep |

## Fork 1 — Custody of the common runner

Fork-existence: A common runner has one canonical release/stewardship home; WE and everstandards cannot both hold final release authority. Separate rule packs/adapters can coexist.

- (a) **One common tool in everstandards; WE consumes it (recommended after repo inspection).** Separate standard rule packs and execution adapters.
- (b) WE keeps the tool and everstandards depends on it. Immediate reuse, but non-web standards depend on WE releases/governance.
- (c) Separate tools sharing only the vector schema. Independent runtimes/releases, but duplicated validation/reporting and semantic-drift risk.

Skeptic: Initial filing-stage objection, not an independent pass: A universal runner can turn into a delivery engine or import browser assumptions. Share validation/reporting only where proven; keep drivers and Longshore’s crash/replay adapter separate. Do not move all WE contracts with the runner.
Screen: pending the later independent standard/implementation and merit/prioritization screen.

## Existing conformity evidence

- `we:capability-manifest/provider.ts:31` defines L0–L2; `:139` defines the manifest. `we:capability-manifest/check.ts` aggregates malformed-manifest/out-of-capability findings.
- `we:conformance-vectors/schema.ts:97` defines vectors; `:144` validates suites and rejects unknown matchers; its header separates schema from execution.
- `we:webcases/requirementValidator.ts:25` uses L1–L3; `we:webcases/caseToVector.ts:67` lowers requirements to observable vectors. Level names require an explicit mapping.
- `we:wrapper-conformance/runner.ts:62` / `:163` run wrapper vectors; `we:scripts/check-app-conformance.mjs` checks exercise apps; `we:scripts/parity-conformance.mjs` invokes FUI’s scorer.
- `we:scripts/lib/conformanceReport.mjs` maps findings into shared reports/SARIF/JUnit. Several specialized paths exist; a generic runner is not thereby proven.
- `we:backlog/098-licensing-strategy.md:96` makes webcases Apache-2.0 permanently; D10/#5403 reuses that floor.
- Boundary: `we:docs/agent/platform-decisions.md#constellation-placement` permits WE-side gate tooling and separates runtime capability delivery. Longshore’s end-state/crash conformity adapter is not the generic standard runner.

## Consequences / what ratifying unlocks

A scoped #5490 plan preserving permanently Apache-2.0 webcases and distinguishing conformance tooling from runtime.

Operator answers: “D17 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Trace actual consumers/dependencies; exercise one WE vector and one Ship document through a proposed common interface; compare upstream harnesses/licence boundaries.
- Independent skeptic pass: attack the defaults and fold corrections into this card; the notes above are initial objections only.
- Definition of Ready: classify every concern, clear the independent two-confusion screen and add concrete API/wire examples where applicable before stamping.

## Done when

- **Executable** — n/a: decision filing changes no runtime. Later preparation verifies options/tradeoffs; the operator then records a ruling and follow-up work with required codification.

## Trust boundary and threat model

Briefs/page are proposal evidence, not execution authority. Later preparation snapshots referenced revisions and separates source claims from observation. This filing executes or publishes no external input.

## Non-goals

No implementation, publication, migration or permission change is authorized by filing.

## Edge cases this change must handle

1. **Untrusted text** — source recommendations stay attributed, not ruled.
2. **Truncated reads** — complete evidence is required before a prepared stamp.
3. **Shared state files** — n/a: filing introduces no store writes.
4. **Fail closed** — missing evidence leaves the decision open and needing prep.
5. **Identity scoping** — repo loci remain explicit; no ids are reassigned.
6. **State over time** — no prepared stamp or implied acceptance from elapsed time.
7. **Who wrote it** — operator ask quoted; defaults remain proposals.
