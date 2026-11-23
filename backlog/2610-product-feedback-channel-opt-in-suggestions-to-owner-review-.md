---
bornAs: xcciuwx
kind: epic
parent: "2527"
status: parked
parkedReason: maturityGated
maturityTrigger: "adoptionSignal: Phase 2 hosted tenants exist (#554)."
dateParked: "2026-11-22"
dateOpened: "2026-07-22"
tags: [plateau-loop, product, feedback, privacy]
---

# Product feedback channel: opt-in suggestions → owner review screen

When the conveyor/console is offered as a product, the learnings pipeline goes multi-tenant: opt-in suggestion telemetry from users' sessions flows to the owner, who reviews it on a triage screen. Deliberately later work — filed now to shape the seams (especially the drop-box schema in #2614, which must be tenant-ready from day one). Parent: the #2527 console program; lineage: governance epic #539 (approval roles, opt-in policy).

## Same pipeline shape

capture → dedup → red-team → closed-verdict review → accept/land — the multi-tenant generalization of the single-tenant drop-box sweep (#2614).

## The review screen reuses the ratified console grammar

Per the console design record (plateau:docs/backlog-console-design.md): the **closed verdict vocabulary** (§3h R4), **queue-with-peek**, the **triage stepper** (§3g T7), and **dedup before expensive review**.

## HARD privacy requirements (ratified 2026-07-22, Nicolas)

1. **Minimal-by-construction schema** — generalized lessons only; no code, diffs, secrets, paths, or repo-identifying strings. If the schema has no field for it, it can't leak.
2. **Deterministic scrub gate at the SEND seam** — a secret/path/token scan that **denies on hit**, following the write-time gate hook precedent (the PreToolUse deny-the-write pattern).
3. **Opt-in = verbatim payload preview** — per send or as a digest, the user sees exactly what leaves the machine.

## Slicing

Sliced 2026-07-28 into three independently-deliverable stories along the pipeline, with the capture schema
as the foundation (it must be tenant-ready from day one, so it defines the shape the review and routing
slices read):

1. **Opt-in capture** *(foundation)* — client-side suggestion capture over a minimal-by-construction,
   tenant-ready schema, the deterministic scrub gate at the SEND seam (deny-on-hit, the `learnings-drop`
   `validateEntry` precedent), and the verbatim payload preview. Defines the schema the rest read.
2. **Owner-review screen** — the multi-tenant triage screen reusing the ratified console grammar (closed
   verdict vocab, queue-with-peek, triage stepper, dedup-before-review). `blockedBy` opt-in capture.
3. **Routing accepted suggestions** — route an accepted suggestion into the learnings intake (red-team →
   lane → PR), the multi-tenant generalization of the single-tenant close-session sweep. `blockedBy`
   owner-review (it acts on reviewed/accepted items).

Parked 2026-11-22 (plateau ruling, master plan). Unpark when: Phase 2 hosted tenants exist (#554).
