---
kind: story
size: 2
status: open
scope: ["we:protocols/tools/validate-protocols.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, coverage-or-style] from plateauapp/plateau-app#244 (head 0fbf26a49)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#244 (reviewed head `0fbf26a49abbae31130818de55f1ff2f42cd4d95`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:protocols/tools/validate-protocols.mjs:302` — (edge-case, degraded) A subsection heading hides a MUST from mandatory coverage checks
   - Scenario: Append '\n## [PLT-DM-015] Required additional behavior\n\n### Validation\n\nA consumer MUST reject a revoked decision.\n' to we:decision-method/spec.md. Add a traceability row with clause PLT-DM-015, designOnly true, reason 'Revoked decisions require explicit consumer validation behavior.', kind semantic, and no vectors. validateAll returns ok:true and Link B PASS. Removing only the '### Validation' heading correctly produces three missing-evidence errors. The parser stops at every heading, including subsections belonging to the clause; it should discover this MUST and require coverage and traced
   - Class: live-reproduced (basis: Reproduced through the exported validateAll function with in-memory file-content overrides. The otherwise identical control without the subsection heading failed as expected; no files were changed.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:protocols/tools/validate-protocols.mjs:363` — (failing-input, degraded) Schema failures satisfy negative evidence for semantic clauses
   - Scenario: In we:decision-method/vectors/vectors.json, replace mergePatch with an object containing initial:null and expectError with 'missing initial' for every invalid vector whose covers includes PLT-DM-002. Preserve their rule:sound targets and traceability. All 47 vectors and Link B still pass, although every negative case for this semantic MUST stops at schema validation before the semantic rule executes. The new semantic check examines only the target prefix. It should reject schema-only failures as negative evidence for a semantic clause.
   - Class: live-reproduced (basis: Reproduced through validateAll using an in-memory vectors override. The schema precheck returns the matching missing-initial error and skips the rule invocation, while the gate reports ok:true.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break

## Acceptance

- [A1] **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.

Hint: For any receive or write endpoint, specify the body-size cap, rate limit, CSRF/origin check, and protection against abuse of state-resetting triggers; mirror each in the port test plan, or explain why it does not apply.

## Non-goals

- [N1] TODO: what this item deliberately does not do — or `n/a: <why>` when nothing is excluded.

## Edge cases this change must handle

One line per class: either the handling, or `n/a: <why>`.

1. **Untrusted text** — TODO: the handling, or n/a: <why>.
2. **Truncated reads** — TODO: the handling, or n/a: <why>.
3. **Shared state files** — TODO: the handling, or n/a: <why>.
4. **Fail closed** — TODO: the handling, or n/a: <why>.
5. **Identity scoping** — TODO: the handling, or n/a: <why>.
6. **State over time** — TODO: the handling, or n/a: <why>.
7. **Who wrote it** — TODO: the handling, or n/a: <why>.
