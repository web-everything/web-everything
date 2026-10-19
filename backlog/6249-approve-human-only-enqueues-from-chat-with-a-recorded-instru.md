---
bornAs: x6ix36v
kind: story
size: 5
status: open
scope: ["we:scripts/operations/land-human-only.mjs", "we:scripts/settings/land.json", "we:scripts/operations/__tests__/land-human-only-chat.test.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Approve human-only enqueues from chat, with a recorded instruction

Live: #5465 needed land-human-only, which only runs from an interactive terminal. The operator approved in chat ("Go, we will protect more when the project is more mature") and the session enqueued through the API, pinned to the head, with an audit comment. Fix: a sanctioned chat path that records the operator's verbatim instruction, pins the head, and runs the same human-only-surface and drain-gate checks as land-human-only, controlled by a setting (land.humanOnlyChannel=terminal|chat, default chat for now; tightened at public preview per the stringency levels). [A1] Executable: node --test we:scripts/operations/__tests__/land-human-only-chat.test.mjs, where chat mode without a recorded instruction is refused and terminal mode refuses chat.

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
