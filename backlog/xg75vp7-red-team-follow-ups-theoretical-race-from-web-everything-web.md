---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/supersede-watch.mjs"]
dateOpened: "2026-11-24"
tags: []
---

# Red-team follow-ups [theoretical-race] from web-everything/web-everything#7423 (head 1ed4989b4)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7423 (reviewed head `1ed4989b49fc4773a78bb59657d2519f09f641f7`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/supersede-watch.mjs:36` — (edge-case, degraded) Offset pagination can silently omit a still-open supersede target
   - Scenario: Start with 101 open PRs ordered #1 through #101. Page 1 returns #1–#100. Close #1 before page 2: the remaining list has 100 entries, so offset 100 returns an empty page. The reader successfully returns #1–#100, omitting still-open #101. A trusted merged PR declaring Supersedes: #101 consequently produces no hold, allowing another fixer dispatch. The watch should detect incomplete evidence or retain #101 before authorizing dispatch.
   - Class: theoretical-race (basis: An in-memory probe executing the reader functions extracted unchanged from this checkout reproduced the omission; a stable-list control returned all 101 numbers. Production impact requires a PR closing between page requests. No live GitHub concurrency was observed.)
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
