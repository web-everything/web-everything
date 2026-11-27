---
kind: story
size: 2
status: open
scope: ["we:scripts/operations/fix-run.mjs"]
dateOpened: "2026-11-26"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7567 (head 0b5655bc8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7567 (reviewed head `0b5655bc8bec374aed19099c18d7e9e4ce7dba75`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/operations/fix-run.mjs:1278` — (failing-input, degraded) A normal multiline fixer response suppresses the no-code trailer.
   - Scenario: With valid operator authorization, an unchanged clean head and the original lease, return finalMessage="Already repaired.\nVerified the existing implementation." The launcher passes this verbatim as reason, but buildNoCodeOwedStandDown rejects newlines. Terminal evidence is withheld even though all state checks pass. A trailing newline alone also fails. Normalize the agent response into a bounded reason before building the record so ordinary response formatting does not suppress valid evidence.
   - Class: live-reproduced (basis: A read-only Node probe executed the exact builder and emitter source with valid binding and state ports. The single-line response emitted successfully; both the multiline response and a response ending in a newline returned emitted:false with an operator-inspection diagnostic.)
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
