---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team gate did not send back 2 confirmed BROKEN breaks

[held entry 280] (2026-10-13, held) Red-team gate did not send back 2 confirmed BROKEN breaks on #5184 head 6c580afa1 (16:53Z red-team-advisory, no red-team-gate comment for that rev; then an accept at 17:19Z). redTeam.confirmedBreaks should have bounced them. | [held entry 288] (2026-10-13, held — build next, Codex direct) operator-queue NEEDS YOU lists a PR the red team sent back: #5184 at 402b66e36 is advisory:accepted but status:sent-back-red-team (confirmed break we:close-items.mjs:73), yet NEEDS YOU lists it. A confirmed red-team break / sent-back-red-team status on the live head must exclude a PR from NEEDS YOU (move it to NOT READY with the reason). | [held entry 289] (2026-10-13, held — build tomorrow with 288) A red-team send-back is undone by a re-review of the same head (#5184 402b66e36: sent back 00:42Z with a confirmed break, no fixer push, re-accepted on the same head → needs-you). A confirmed break must stand until a new head addresses it, and the send-back must dispatch a fixer.

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
