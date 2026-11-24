---
kind: story
size: 2
status: open
scope: ["we:blocks/state-view/StateViewElement.ts"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from frontier-ui/frontierui#54 (head 4cadce2ae)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#54 (reviewed head `4cadce2ae701c64466bac95714f6e9d09c2fbae9`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/state-view/StateViewElement.ts:36` — (edge-case, degraded) Attribute updates close an open error-details disclosure.
   - Scenario: Mount an error state with details, open Details, then update the message attribute while keeping state='error'. render() replaces the entire section with a newly created, closed details element, hiding the information being read. Preserve the disclosure's open state across updates within the error state.
   - Class: correctness-in-normal-use (basis: The observed message attribute synchronously triggers render(), which unconditionally replaces every child. createStateView creates a fresh details element without restoring its open state; only focus is restored.)
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
