---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/daemon-rebuild/prepare.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7171 (head cfff4bc81)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7171 (reviewed head `cfff4bc810e8ab9707a8006b377be76472612192`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/daemon-rebuild/prepare.mjs:628` — (edge-case, degraded) Unreadable live history crashes ready-candidate adoption
   - Scenario: With mainOnly=false and a ready candidate present, let the live-overlay Git log command return status 128. liveOverlaysOf returns undefined, and the new liveApplied.length access throws TypeError before matchReadyCandidate runs. This also blocks an exact candidate match that does not require live-history evidence. Unknown history should reach the matcher's existing safety handling instead of aborting the rebuild.
   - Class: live-reproduced (basis: An in-memory fault-injection probe executed the production prepareRebuild function body with filesystem operations stubbed and the history command returning status 128. It observed TypeError: Cannot read properties of undefined (reading 'length'). No files were changed; a live daemon was not exercised.)
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
