---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/direct-entry-guard.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced] from web-everything/web-everything#7241 (head 67589c39e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7241 (reviewed head `67589c39e402a47adde1a556f341f6354a3ad080`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/direct-entry-guard.mjs:20` — (edge-case, degraded) An eval-based library import incorrectly triggers the direct-entry refusal.
   - Scenario: Run: node --input-type=module -e 'const m = await import(process.argv[1]); console.log(typeof m.planRoundExtension)' we:./scripts/operations/extend-rounds.mjs. It prints the refusal and exits 2 instead of printing function and exiting 0. Node places the first eval argument in process.argv[1], so matching that path does not establish direct execution. This breaks the claimed unchanged library-import behavior.
   - Class: live-reproduced (basis: Observed on Node v22.1.0 with the checked-out code. The invocation uses a dynamic import without modifying process.argv or any files; importing the same module without the path argument succeeds.)
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
