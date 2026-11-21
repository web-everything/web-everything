---
kind: story
size: 2
status: open
scope: ["we:scripts/merge-ai-prs.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7160 (head b94d8f9b8)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7160 (reviewed head `b94d8f9b866f2f39089c6771914c4ca40e4e13fb`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/merge-ai-prs.mjs:1110` — (failing-input, degraded) Fast-drain targets lose provenance before the new BLOCKED-relief gate
   - Scenario: Run --from-green-event --only=42 with usable snapshots, no eligible pre-stage cache entry, and a queue-required PR whose required checks are green but mergeStateStatus is BLOCKED. readFullListingPr refreshes the target through gh pr view; resolveRequiredCheck leaves a short rollup containing test unchanged, without rowsComplete/rowsHead. readFastDrainContext replaces the complete snapshot target with this flattened result. The new gate therefore returns rows-incomplete, and candidate selection skips the PR before fresh revalidation can hydrate it. Hydrate targeted listing reads before classifi
   - Class: correctness-in-normal-use (basis: The production reader and candidate-selection call chain establish this ordinary fast-drain sequence. A direct Node probe confirmed that the green flattened rows return rows-incomplete while identical rows with complete current-head provenance pass. Full CLI execution was unavailable because checkout dependencies were missing.)
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
