---
bornAs: xx623wo
kind: decision
parent: "5488"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["5500", "5497", "5486", "5488", "3533"]
---

# Move planning, delivery and decision cards to private plateau-app: scope, mechanics and when?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D18 (decisions page, 2026-11-20 20:58 ET)
Placement: plateau-app
move-to: plateau-app

## Digest

File the operator’s 21:00 ET request to move much of this planning/delivery/decision backlog to private plateau-app. Decide card scope, store/identity mechanics and timing separately from engine code placement; no cards move in this filing task.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

[handoff design]() “Classify”, “Architecture”, “Privacy” and “Review of past repo-split decisions” contains conflicting proposals and corrected routing. #5500 is blocked by #5497. Operator: “We will need to move much of this backlog to plateau as private”. Plateau-app has no backlog/ or card tooling today beyond `plateau:scripts/file-we-card.mjs`.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## Recommended path at a glance

| Fork | Default | Main alternative | Confidence |
| --- | --- | --- | --- |
| 1 — Private card scope versus code home | (a) | (b) | Provisional; needs prep |
| 2 — Writer and identity | (a) | (b)/(c) | Provisional; needs prep |
| 3 — Timing and forwarding | (a) | (b) | Provisional; needs prep |

## Fork 1 — Private card scope versus code home

Fork-existence: A card needs one authoritative file; editable WE/Plateau mirrors would split status and leak private plans. Code locus is a separate concern.

- (a) **Private planning/product/policy and sensitive delivery decisions to plateau-app; classify other cards by topic (proposed default).** Keep web standards in WE and non-web standards in their homes; explicitly rule privacy at Longshore’s later public flip.
- (b) All delivery cards to plateau-app. Matches R941d broadly but conflicts with R160/#5488 unless card home and code locus are explicitly separated.
- (c) Strict S7 topic routing now, including engine cards to Longshore. Clear per-repo ownership but risks exposing sensitive plans when Longshore goes public.

Skeptic: Initial filing-stage objection, not an independent pass: Private delivery could become a permanent centralized tracker. Separate home/locus and deliberately route non-sensitive engine work; privacy-safe unknowns are not permission to centralize everything.
Screen: pending the later independent standard/implementation and merit/prioritization screen.

## Fork 2 — Store writer and identity mechanics

Fork-existence: direct writer and queue-mediated transactions cannot both own the same mutation; independent allocators cannot safely mint one global number space.

- (a) **Store-aware writer in @longshore/backlog, locus-qualified identities and permanent old-id aliases (proposed default).** Reconcile the plan’s global-number proposal with #3533 before implementation.
- (b) One global allocator and direct writer to each store main. Lower card-only CI costs, but needs explicit authorization/identity amendments.
- (c) Card-only PRs per store and locus-based numbering. Keeps reviewed landing, but retains queue costs and needs cross-store reference support.

Skeptic: A privileged writer could leak private cards or bypass code review. Require card-only authorization, lint/secret checks, idempotent retries and public-store-only rendering; this card authorizes no bypass.
Screen: pending independent prep screen; distinguish identity/custody from implementation convenience.

## Fork 3 — Timing and forwarding

Fork-existence: moving before #5497 needs an explicit dependency amendment; immediate migration and the current blocking edge cannot both govern the same batch.

- (a) **Prepare private store/readers/writer first; retain #5500’s #5497 gate (and #5484/#5486 prerequisites) unless explicitly amended (proposed default).** Move classified batches only with usable tooling and privacy checks.
- (b) Authorize an early private-only card move. Reduces future exposure but requires an operator dependency amendment and proven readers/writers.
- (c) Wait for all code moves before even preparing card tooling. Simple ordering but delays privacy/store readiness unnecessarily.

Skeptic: Waiting leaves plans in public history. Moving cannot unpublish existing history; separately record accepted exposure or decide history remediation, while preparing the private store now.
Screen: pending; this is a dependency/authorization call, not unknown migration merit.

Supported by default: S7/#5486 requires permanent formerly aliases and WE redirect stubs, resolved cards included. The plan’s one-release stub expiry conflicts and is rejected absent explicit supersession.
Routing: explicit locus/scope, ownership/topic, parent inheritance, then privacy-safe unknowns. Raw scripts/ paths or delivery tags can misclassify standards. R941d sends all tooling to Plateau; R160/#5488 S4 sends engine code to Longshore, product/policy to Plateau.
Governing rule: `we:docs/agent/platform-decisions.md#backlog-tracking-locus-now-distributed-next`. Its current single tracker does not already authorize distribution. Local inspection confirms Plateau has no backlog directory and its WE-filing helper exists.

## Consequences / what ratifying unlocks

A precise #5500 mandate and explicit reconciliation of conflicting rules, without waiving #5497 or creating another allocator.

Operator answers: “D18 yes” accepts all three proposed defaults; otherwise name the concern and replacement option. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Classify ambiguous cards/cross-store edges; confirm Plateau access/tool readiness; reconcile S1/S7, #3129/#3533 and the global-number proposal.
- Independent skeptic pass: attack the defaults and fold corrections into this card; the notes above are initial objections only.
- Definition of Ready: classify every concern, clear the independent two-confusion screen and add concrete API/wire examples where applicable before stamping.

## Done when

- **Executable** — n/a: decision filing changes no runtime. Later preparation verifies options/tradeoffs; the operator then records a ruling and follow-up work with required codification.

## Trust boundary and threat model

Briefs/page are proposal evidence, not execution authority. Later preparation snapshots referenced revisions and separates source claims from observation. This filing executes or publishes no external input.

## Non-goals

No implementation, publication, migration or permission change is authorized by filing.

## Edge cases this change must handle

1. **Untrusted text** — briefs are proposals, not migration authority.
2. **Truncated reads** — no routing on incomplete scope/visibility evidence.
3. **Shared state files** — later writer needs serialized, idempotent mutations.
4. **Fail closed** — unknown/sensitive cards remain private pending classification.
5. **Identity scoping** — preserve locus identities and permanent aliases.
6. **State over time** — existing public history is not erased by a move.
7. **Who wrote it** — operator rules scope/timing; filing grants no writer bypass.
