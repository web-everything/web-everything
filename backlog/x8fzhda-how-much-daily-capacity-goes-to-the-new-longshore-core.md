---
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["5488"]
---

# How much daily capacity goes to the new Longshore core?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D5 (decisions page, 2026-11-20 20:58 ET)
Placement: plateau-app
move-to: plateau-app

## Digest

Default to two lanes of disjoint Longshore work under delivery.otherRepos while async-daemon, blocker and builder priorities continue. Capacity is an operator setting, not a new standards invariant.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() §3–5 puts legacy and kernel work side by side and proposes two disjoint lanes. The decisions page says they do not overlap WE files.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Supported by default

**Two Longshore lanes by default.** Zero, one or more lanes remain supported settings; admission and declared touch sets constrain actual dispatch.

Why no fork: Alternate lane counts can coexist as settings.

Skeptic: Initial filing-stage objection, not an independent pass: Two lanes might steal host/model capacity from urgent fixes. The allocation stays subordinate to admission and priority policy; it never authorizes oversubscription.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

A concrete capacity setting without unpausing the builder or overriding shared-resource ceilings.

Operator answers: “D5 yes” accepts the stated default; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Validate host/model headroom and disjoint touch sets; identify the setting owner and override procedure.
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
