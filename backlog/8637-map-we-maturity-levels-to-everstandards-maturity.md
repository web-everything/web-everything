---
bornAs: xnulgp5
kind: story
size: 2
parent: "8631"
status: open
dateOpened: "2026-11-21"
tags: []
---

# Map WE maturity levels to everstandards maturity

Define evidence-backed exports from WE status to everstandards maturity, using the proposed correspondence as a starting point rather than automatic conformance proof.

## Design

Source: `everstandards-format-2026-11-20`, line 62 (handoff designs). Proposed correspondence: **concept ≈ pre-Draft, draft ≈ Draft, experimental ≈ Candidate, active ≈ Stable**. This is the vocabulary starting point, not an automatic equivalence.

Reconcile it with #8631/D9 and #8623/D6 before exporting claims. D9's prep found experimental has no vector requirement and active can lack implementation evidence. Define evidence-backed ceilings and explicit downgrade/no-stage cases; missing evidence must export no stage. Stable still requires two independent implementations passing a pinned suite.

## Acceptance

- [A1] Documentation-only mapping review: every WE status has a target/ceiling, required evidence and missing-evidence outcome, with examples for experimental without vectors, active without an implementation and two independently passing implementations.
- [A2] State where the proposed line-62 correspondence differs from evidence-derived export; update the design and WE mapping documentation in the later implementation task, without changing WE source statuses automatically.
- [A3] Run scoped card lint and any affected mapping proof vectors when this follow-up is implemented; no runtime test is needed for filing it.

## Non-goals

Renaming WE statuses, granting Stable from a label, changing maturity policy or touching the handoff design in this filing task.

## Trust boundary and threat model

Status labels and implementation declarations are claims. Only attributed pinned conformance results can support maturity; absence never defaults to a stage.

Source and proposed artifact filenames (handoff references are by name only):

```text
everstandards-format-2026-11-20.md
```
