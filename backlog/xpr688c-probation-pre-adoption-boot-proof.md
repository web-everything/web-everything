---
kind: task
status: open
dateOpened: "2026-11-17"
tags: [daemon, probation]
related: ["8409"]
scope: ["we:scripts/lib/daemon-rebuild/probation.mjs", "we:scripts/lib/daemon-self-sync.mjs", "we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs", "we:scripts/conveyor/soak/breaks/"]
---

# Require explicit authorization for probation proof from a pre-adoption process

Filed for PR #6882's 2026-11-17 later-round card suggestion
(codex-correctness). `evaluateProbation` in
`we:scripts/lib/daemon-rebuild/probation.mjs:173` accepts finite `bootAt` and
matching SHA, then uses `Math.max(adopted, bootAt)` as the tick cutoff. It does
not itself distinguish a process started before adoption from a wrapper that
explicitly authorized a no-restart adoption after import-closure checks.
This advisory risk is tracked here; no production change is made in this round.

## Acceptance

- A1: Planned `pre-adoption process cannot promote without explicit no-restart authorization`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must supply a
  matching boot SHA and current PID with boot before adoption and a timely tick;
  assert pending, unchanged proven-good and retained probation without consent.
- A2: Planned `no-restart proof is bound to adoption UUID and imported-change decision`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must assert
  promotion only with same-adoption authorization from the wrapper's complete
  import-closure check; mismatched UUID, missing authorization, imported changes
  and unknown closure must preserve probation and refuse promotion.
- A3: Planned `pre-adoption boot proof cannot bypass adoption or boot deadlines`
  in `we:scripts/lib/daemon-rebuild/__tests__/probation.test.mjs` must assert
  both deadlines still reject late evidence even with explicit authorization;
  a fresh post-adoption process must still pass with valid tick proof.
- A4: Planned `old process requires adoption-specific no-restart consent` in
  `we:scripts/conveyor/soak/breaks/probation-no-restart-adoption.soak.test.mjs`
  must drive the real wrapper through authorized and refused branches and
  assert only authorized same-adoption evidence promotes, with caller-owned
  restart for imported changes. Extend the existing registered soak scenario.

## Proof plan

First demonstrate A1 against the current evaluator. Then require the evaluator
and wrapper integration cases to discriminate missing or stale authorization.
These are named planned cases, not executed evidence.

## Non-goals

No blanket ban on the existing safe no-restart path, new independent exit timer,
or weakening of PID/head/timestamp validation.
