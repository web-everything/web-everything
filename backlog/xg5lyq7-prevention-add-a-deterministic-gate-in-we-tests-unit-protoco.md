---
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:tests/unit/protocols.test.ts", "we:protocols/tools/validate-protocols.mjs", "we:protocols/plateau/decision-method/v0.1/defs/confirm.schema.json", "we:protocols/tools/__tests__/validate-protocols.test.mjs"]
dateOpened: "2026-11-25"
tags: []
---

# Prevention — Add a deterministic gate in we:tests/unit/protocols.test.ts that removes each constraint keyword and requ… (from plateauapp/plateau-app#241 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:tests/unit/protocols.test.ts:542` — Add a deterministic gate in we:tests/unit/protocols.test.ts that removes each constraint keyword and required entry in defs/*.schema.json in turn and requires some vector row to change verdict; at minimum add invalid rows for these four.
2. `we:protocols/tools/validate-protocols.mjs:161` — Add a table-driven schemaProbe test with a malformed value for every validated keyword, with a completeness assertion against the exported keywords set.
3. `we:protocols/tools/validate-protocols.mjs:72` — Add a CLI test with a nested definition folder that pins the intended behaviour, then either recurse in the scan or narrow fileRef to match.
4. `we:protocols/plateau/decision-method/v0.1/defs/confirm.schema.json:4` — Add a deterministic mutation test over defs/*.schema.json: for every required entry, additionalProperties:false and pattern, require a vector that fails when that constraint is removed.
5. `we:tests/unit/protocols.test.ts:606` — File the 029 rule (and the default when approves is omitted) for the slice that wires these definitions in, with a negative vector for a declared non-approving outcome. Have the coverage check mark semantic-only clauses as unenforced instead of letting any tagged row satisfy them.
6. `we:protocols/tools/validate-protocols.mjs:161` — Add a table-driven test requiring a malformed-value rejection case for every non-annotation keyword in the exported keywords set.
7. `we:tests/unit/protocols.test.ts` — Require the protocol unit suite to pass in CI; use object-shaped parameter rows for tests whose input can itself be an array.

Idempotency key (do not edit): approval-prevention-key:plateauapp/plateau-app#241@e35d77f1eb20aa0df37f28bafefa00f118a0b6f3

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
