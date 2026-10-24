---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-sweep.mjs"]
dateOpened: "2026-10-24"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5856 (head 27fe24550)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5856 (reviewed head `27fe2455019eb09ded71a5292368040b06373416`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-sweep.mjs:229` — (failing-input, degraded) Published stalled events lose the mapped remedy.
   - Scenario: Pass a red-team:pending PR with a 90-minute clock and no daemon entries. Detection correctly supplies remedy='red team never ran: check red-team gate'. The publication path passes it through feedItem(), which drops remedy and does not include it in reason, evidence, or command. Executing the adapter confirms the remedy is absent from its entire output. Normal non-dry-run reports also retain only the detector count. The promised mapped remedy should survive into the operator's stalled event.
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
