---
bornAs: x65lboa
kind: story
size: 2
status: open
scope: ["we:skills-src/conveyor/review-daemon.mjs"]
dateOpened: "2026-10-21"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5769 (head f501c83a0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5769 (reviewed head `f501c83a08006e8ceb0bc535e58dd8eec5096472`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:skills-src/conveyor/review-daemon.mjs:1296` — (edge-case, broken) Line separators in relative checkout paths silently undercount live rounds
   - Scenario: Supply three distinct PID-bearing commands of the form node ./Review\we:u2028Work/scripts/operations/review-job.mjs run --pr=N, where \u2028 represents an actual U+2028 character. The script-path regex uses dot without dotAll, so it cannot span the separator and falls back to './Review'. There is only one suffix candidate, so ambiguity detection does not catch this. The unchanged budget functions return live:0,left:3. A carriage return produces the same undercount. These paths should count as reviews or hold dispatch as ambiguous.
   - Claude's re-check: demonstrated break

Operator ruling (chalbert via claude-code-chat): carded at the round cap. Reason: operator 2026-10-21 ~07:00 ET in chat: "Card" — rare argv shapes; PR is a clear improvement over main

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
