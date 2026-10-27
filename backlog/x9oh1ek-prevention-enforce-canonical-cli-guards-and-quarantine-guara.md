---
kind: story
size: 3
status: open
scaffoldedBy: "fix-6014"
dateScaffolded: "2026-10-27"
scope: ["we:scripts/check-standards-rules.mjs", "we:scripts/__tests__/check-standards-rules-content-lint.test.mjs", "we:scripts/ci/quarantine-skip.mjs", "we:scripts/lib/red-main-quarantine-io.mjs", "we:scripts/lib/__tests__/red-main-quarantine-repeat.test.mjs", "we:scripts/lib/__tests__/red-main-quarantine.test.mjs", "we:docs/agent/testing.md", "we:docs/agent/reviewer-expectations.md"]
dateOpened: "2026-10-27"
tags: []
---

# Prevention: enforce canonical CLI guards and quarantine guarantee coverage

PR #6014 review prevention. Add a check:standards lint rejecting process.argv[1] entry guards that compare paths without canonicalizing both sides with realpathSync or an approved shared helper; defend direct, symlinked-directory, symlinked-file and import execution. Sweep sibling CLI guards, including we:scripts/ci/quarantine-skip.mjs. Document and enforce the review convention that each added validation branch and each bound advertised by settings has a named discriminating test. Keep the deterministic reader-spy cases for the ten-run slice, maxTests per-run log limit and malformed historical run IDs in the regular affected-test gate. Keep explicit stop against quarantine and quarantine against stop settings assertions. Require main-branch and name-qualified CI exclusion tests whenever quarantine is enabled. Record repeat-failed as deterministic-failure quarantine rather than flake evidence in settings and notices. Done when the lint rejects lexical-only guards, the canonical cases pass, and removal of each tested bound, validation or exclusion safeguard produces a targeted red test. Test the lint with small content fixtures and run affected quarantine and CI exclusion tests; do not alter the ten-run sliding-window semantics, which the operator ruled not-real as a defect.

## Acceptance

- [A1] **Executable** — The content lint tests in we:scripts/__tests__/check-standards-rules-content-lint.test.mjs reject lexical-only entry guards and accept canonical guards, including the sibling in we:scripts/ci/quarantine-skip.mjs. Run the affected test file through the queued unit runner.
- [A2] Named tests for reader bounds, malformed IDs, opposite-value mode overrides, main execution and name-qualified CI entries remain in the regular test gate. Each guard has a targeted test that fails when that guard is removed in the sanctioned mutation verifier.
- [A3] we:docs/agent/testing.md and we:docs/agent/reviewer-expectations.md require named tests for new validation branches and bounds advertised in settings.

## Non-goals

- [N1] No change to repeat-proof admission, run-window semantics, quarantine TTL, writer permissions or skip policy. No new receive/write endpoint, so body-size, CSRF and request-rate controls do not apply.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — Treat scanned source as data; never execute it. Reject malformed run IDs before reader calls.
2. **Truncated reads** — Retain ten-run and per-run log bounds and the existing unknown-evidence fallback; never turn a partial read into proof.
3. **Shared state files** — n/a: the lint and documentation add no shared-state writer.
4. **Fail closed** — A canonicalization error must not run an imported CLI; incomplete quarantine evidence must not authorize a new entry.
5. **Identity scoping** — Compare canonical entry and module paths; equal basenames do not identify the same module.
6. **State over time** — Exercise both mode override directions against a different lower-precedence mode so default changes cannot mask a broken override.
7. **Who wrote it** — Keep existing quarantine actor and transport guards; the lint does not grant write authority.
