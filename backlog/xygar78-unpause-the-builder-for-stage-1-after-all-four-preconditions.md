---
kind: decision
parent: "2445"
status: open
dateOpened: "2026-11-20"
tags: [decision-filing, plateau-app]
relatedTo: ["2445"]
---

# Unpause the builder for stage 1 after all four preconditions?

Operator ask (2026-11-20 20:59 ET): “note all as full decision item and run with preparation”.

Decision id: D16 (decisions page, 2026-11-20 20:58 ET)
Placement: plateau-app
move-to: plateau-app

## Digest

Not yet (high confidence in the source recommendation): keep the builder paused. Stage 1 is one small Codex build at a time; R981 reserves unpause to the operator after four evidenced preconditions.

Needs prep: proposed call only; this filing is neither ratification nor a completed preparation pass.

## Context

The page names R981 and all four conditions. #7247/#7251 are merge/installation prerequisites from that source; preparation must resolve the exact PR/artifact identities, rather than treating same-number local backlog cards as merge or deployment evidence.

Design refs are relative to the operator handoff; WE evidence uses its repo locus.

## What you're deciding

Authorize stage 1: one small Codex build at a time, only after all four proofs and a fresh operator go.

## Why this isn't a classic fork (and is still a decision)

An agent waits on preconditions; there are no rival architectures. R981 retains operator-only authority, not automatic activation when prerequisites appear complete.

## Context & prior-art delta

| Existing control | Evidence required for stage 1 |
| --- | --- |
| #7247 prevention | Merge proof, not just a branch/card |
| #7251 refusal stop | Installed-state proof, not just merge |
| Priority-list tool | Identified tool and merge proof |
| New priority list | Installed identity and activation proof |

## Dependencies & lineage

R981; #7247; #7251; priority-list tool and installed list (identities need research).

## Recommendation

**Not yet (default).** Re-present only after #7247 merges, refusal stop #7251 installs, the priority-list tool merges, and the new list is installed. Even then the operator must authorize unpause.

Skeptic: Initial filing-stage objection, not an independent pass: The changes may already have landed elsewhere. Reconcile current merge and installed-state evidence during prep; never equate merging with installation or silence with permission.
Screen: pending the later independent standard/implementation and merit/prioritization screen.


## Consequences / what ratifying unlocks

A single operator go/no-go on the bounded stage-1 candidate once evidence is complete.

Operator answers: “D16 not yet” confirms the hold. A later “D16 yes” authorizes stage 1 only after all four preconditions are evidenced and the operator explicitly rules go. No answer is recorded here.

## Prep still needed

- Prior art: verify primary references and known implementations; reuse existing research first.
- Evidence: Resolve the exact #7247/#7251 PR/artifact identities and identify the priority-list tool and installed list; collect merge SHAs and installed refusal-stop/list evidence; validate one-build admission.
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
