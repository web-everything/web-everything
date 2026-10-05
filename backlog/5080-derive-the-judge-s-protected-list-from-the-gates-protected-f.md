---
bornAs: xvm9vbu
kind: story
size: 3
parent: "3383"
status: open
scope: ["we:scripts/lib/gate-config.mjs", "we:scripts/lib/judge-verdict-record.mjs"]
dateOpened: "2026-10-04"
tags: []
---

# Derive the judge's protected list from the gates' protected-file roster

The judge's protected list must be DERIVED from the existing protected-file roster the gates already use (we:scripts/lib/gate-config.mjs and its leash/protected classes), not hand-enumerated. PR #3771 went through several review rounds and each round found more hand-list gaps: the list omitted we:scripts/lib/judge-verdict-record.mjs, omitted the workflow files we:.github/workflows/review-gate.yml, we:.github/workflows/apply-review-request.yml, we:.github/workflows/deploy.yml and we:.github/workflows/ci.yml, and its record-binding checks let a reused lane ref inherit an earlier author's provider. Operator ruled 'card' on those findings (2026-10-04, 'Accept'). Scope: derive the list from the gate-config roster; bind lane-ref reuse to the original dispatch. Done-when: (1) the judge's protected list is computed from the gate-config roster, with no hand-enumerated paths; (2) a test fails if any gate code, workflow file under we:.github/workflows, judge module (including we:scripts/lib/judge-verdict-record.mjs) or ratification surface is missing from it; (3) a test shows a reused lane ref cannot inherit an earlier author's provider because the record is bound to the original dispatch.

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
