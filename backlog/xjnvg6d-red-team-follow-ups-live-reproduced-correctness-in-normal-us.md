---
kind: story
size: 2
status: open
scope: ["we:protocols/plateau/decision-method/v0.1/defs/state.schema.json"]
dateOpened: "2026-11-25"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from plateauapp/plateau-app#242 (head 9394b37c6)

Filed mechanically by the red-team gate: the post-accept red team on plateauapp/plateau-app#242 (reviewed head `9394b37c6f1abc64b795cf4bef4def0801389b42`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:protocols/plateau/decision-method/v0.1/defs/state.schema.json:43` — (failing-input, degraded) The new state definition accepts malformed emitted-type URIs.
   - Scenario: Validating {"kind":"final","emits":"not a URI"} against the new state definition succeeds. The referenced flow/definition v0.1.2 schema requires state.emits to have format uri, so this input should fail. Using only minLength silently admits invalid emitted-type identifiers.
   - Class: live-reproduced (basis: An in-memory vector targeting the bundled state definition passed through the repository validator; its existing URI checker rejects the same string. The active root does not yet reference this definition, so the demonstrated defect is limited to direct definition validation.)
   - Also class: correctness-in-normal-use
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
