---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/check-local-settings.mjs", "we:scripts/check-local-settings.test.mjs", "we:protocols/tools/validate-protocols.mjs", "we:protocols/plateau/decision-method/v0.1/defs/text.schema.json", "we:tests/unit/protocols.test.ts", "we:scripts/__tests__/check-local-settings.test.mjs", "we:protocols/tools/__tests__/validate-protocols.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Compare fs.realpathSync(process.argv[1]) with the module path, and add a child-process test that runs the… (from plateauapp/plateau-app#239 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/check-local-settings.mjs:19` — Compare fs.realpathSync(process.argv[1]) with the module path, and add a child-process test that runs the script through a symlinked path and asserts the PASS line. Add a lint or standards rule against an unresolved argv[1] main-module comparison.
2. `we:scripts/check-local-settings.test.mjs:30` — Add a child-process test in a temporary git repo with the file tracked that asserts a non-zero exit, and add an `npm run check:standards` step to we:ci.yml.
3. `we:protocols/tools/validate-protocols.mjs:49` — Add a test with two definition files that reference each other and assert the validator exits 0.
4. `we:protocols/tools/validate-protocols.mjs:47` — Add a named test in we:tests/unit/protocols.test.ts that writes invalid JSON to a referenced definition file and asserts exit 1 with the protocol named; add a review lens requiring one negative test per failure mode listed in a fail-closed comment.
5. `we:scripts/check-local-settings.test.mjs:9` — Add one test that calls checkLocalSettings() against the real repository index (so the required `test` job enforces it) and one child-process test asserting a non-zero exit on a tracked file.
6. `we:protocols/plateau/decision-method/v0.1/defs/text.schema.json:2` — File a follow-up for the activating slice: one invalid vector per constraint stated in a definition description; the existing traceability check (each MUST clause needs a negative vector) covers it once the definitions are wired.
7. `we:scripts/check-local-settings.mjs:19` — Compare fs.realpathSync(process.argv[1]) with the module path (or use a separate always-run CLI file), and add a lint rule that rejects the unresolved comparison.
8. `we:tests/unit/protocols.test.ts` — Extend the named test with exercised const and enum schemas and fixtures that distinguish the original values from altered values.
9. `we:tests/unit/protocols.test.ts` — Gate on deep equality of bundled const/enum data, or add referenced fixture cases that distinguish preserved values from removed or modified constraints.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#239@b0d0244d93c7a1c57c12456ea47f4d39e7b138e9

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
