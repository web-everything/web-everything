---
bornAs: x6azz6j
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-load-overlay.mjs"]
dateOpened: "2026-10-17"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5460 (head 2640c4d42)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5460 (reviewed head `2640c4d42f8c75b5b7ab524208f8005612f1d09a`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-load-overlay.mjs:448` — (edge-case, degraded) Launch retries overlook existing sessions under CLAUDE_CONFIG_DIR.
   - Scenario: Set CLAUDE_CONFIG_DIR to a custom directory. Let the worker create its matching session and transcript there, but reach the timeout before writing the command marker or a final completion record; its wrapper record remains 'started'. The new observer searches only home/.claude, reports both evidence flags false, and launches a second worker despite existing session evidence. A read-only probe with an in-memory filesystem produced one launch with default paths versus two with the custom config directory. Resolve session, job and transcript paths from the worker's effective configuration directo
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
