---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/build-priority-set-io.mjs"]
dateOpened: "2026-11-23"
tags: []
---

# Red-team follow-ups [attacker-same-user] from web-everything/web-everything#7365 (head 3487fdb0c)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7365 (reviewed head `3487fdb0c84ede21787963bb6c902542d48c1e11`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/build-priority-set-io.mjs:31` — (edge-case, degraded) Wildcard auditor basenames lose protection when relocated.
   - Scenario: On pinned main, place a copy of we:scripts/operations/codex-audit-io.mjs at we:scripts/adapters/codex-audit-io.mjs and allowlist that exact path. A card scoped to we:scripts/adapters/codex-audit-io.mjs is admitted. An in-memory probe using the existing auditor source reproduced acceptance, while its original path was refused. AUDITOR_FLOOR's codex-audit* becomes a literal Set entry, so has('we:codex-audit-io.mjs') misses it; the path matcher protects only the original directory. The relocated auditor should remain refused even when allowlisted.
   - Class: attacker-same-user (basis: Productization concern requiring a reviewed nonempty allowlist and a pinned tree containing the relocated auditor. The shipped empty allowlist refuses this input today. The probe executed the production scopeReader with injected regular-file/settings readers and the actual auditor content; no repository files were changed.)
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
