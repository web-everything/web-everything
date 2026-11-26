---
kind: story
size: 2
status: open
scope: ["we:blocks/state-view/StateViewElement.ts"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from frontier-ui/frontierui#56 (head 4bc73ebcd)

Filed mechanically by the red-team gate: the post-accept red team on frontier-ui/frontierui#56 (reviewed head `4bc73ebcde79aba07d4e34256fa38d3ddd34d94c`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:blocks/state-view/StateViewElement.ts:197` — (failing-input, degraded) Bare text content remains visible outside the ready state
   - Scenario: Mount a loading we-state-view containing the text node 'Result text'. The text remains visible before 400 ms, alongside the skeleton, and alongside the error after 30 seconds. The hiding loop visits only element children. All authored content should remain hidden until state becomes ready.
   - Class: live-reproduced (basis: An in-memory happy-dom probe executing the transpiled checked-out source confirmed the text node remained unhidden after the timeout error rendered.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:blocks/state-view/StateViewElement.ts:206` — (edge-case, degraded) Successful Retry drops keyboard focus to the document body
   - Scenario: Mount an error we-state-view containing a data button. Register a retry listener that sets state to ready, focus Retry, and activate it. Removing the state view drops focus to BODY because focus restoration requires a non-null replacement view. Successful recovery should preserve a meaningful focus position in the host or revealed content.
   - Class: live-reproduced (basis: Executing this sequence against the transpiled source in happy-dom produced document.activeElement.tagName equal to BODY and host.contains(document.activeElement) equal to false.)
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
