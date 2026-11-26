---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, theoretical-race] from web-everything/web-everything#7487 (head 4383bdc29)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7487 (reviewed head `4383bdc29180fb93835611df51872f69fed4f84b`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/orchestrator-ask.mjs:20` — (edge-case, degraded) The 4 MiB journal tail loses existing deduplication keys
   - Scenario: Record an ask for pin-moved:lane/x(at)&lt;sha&gt;, append more than 4 MiB of unrelated asks, then call askPinMoved for the same ref and adopted SHA. readBounded excludes the existing record, so the function returns asked:true and appends a duplicate. The once-per-key contract requires asked:false while that key already exists in the journal.
   - Class: live-reproduced (basis: Executed the actual askPinMoved and default readBounded logic with filesystem operations redirected to an in-memory journal. With approximately 4.3 MB of journal data, the existing key's record count increased from one to two. No disk files were changed.)
   - Also class: theoretical-race
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
