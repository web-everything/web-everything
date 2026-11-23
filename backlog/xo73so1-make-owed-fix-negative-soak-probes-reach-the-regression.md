---
kind: task
status: open
dateOpened: "2026-11-22"
tags: [conveyor, testing]
scope: ["we:scripts/conveyor/soak/breaks/owed-fix-no-live-fixer-recovery.soak.test.mjs", "we:scripts/conveyor/soak/breaks/owed-fix-no-live-fixer-recovery.mjs"]
---

# Make owed-fix negative soak probes reach the injected regression

PR #7336's simplicity and codex-correctness advisory findings identify the same gap: the never-release and always-redispatch fixtures omit `we:scripts/conveyor/reconcile-pass.mjs`, so their negative result can come from a missing dependency before the injected behavior executes. The review explicitly asks to card this separately.

## Acceptance

- Provide the fixture's full import/export dependencies and run each injected regression against its intended scenario.
- Assert the expected behavioral assertion fails and reject module-resolution errors as evidence for those two mutations.
- Retain a separate named missing-module test, and show the valid fixture passes before injecting either defect.

## Proof plan

Run the scoped soak wrapper through heavy-admission and record the specific behavioral failure for each mutation; do not accept only a nonzero child status.

Prevention: add `negative-probe-rejects-module-error` and `negative-probe-matches-scenario-assertion` fixtures to the shared negative-probe contract. `ERR_MODULE_NOT_FOUND` cannot satisfy never-release or always-redispatch evidence. This card also captures the repeated 2026-11-23 simplicity and codex-correctness advisory suggestions; those fixtures are deliberately not repaired as part of the park regression.
