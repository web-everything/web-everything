---
kind: story
size: 2
status: open
scope: ["we:scripts/review-set-label.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [correctness-in-normal-use] from web-everything/web-everything#7274 (head 927b39a39)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7274 (reviewed head `927b39a399a452254e58023dcbd063ccb06985a4`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/review-set-label.mjs:1248` — (failing-input, degraded) Update the canonical review skill’s clearance commands for the mandatory head pin
   - Scenario: Follow we:skills-src/review/SKILL.md:339 with a valid PR, operator instruction and findings file. Its clear-human command omits --expect-head, so the new guard exits 2 before clearing anything. The transport example at line 375 likewise omits --expectedHead and now fails validation. Update both examples and their instructions to carry the explicitly approved full head SHA.
   - Class: correctness-in-normal-use (basis: Source-traced regression in the documented /review workflow: both canonical commands omit arguments this diff makes mandatory. No concurrency or attacker is required; runtime reproduction was unavailable because checkout dependencies are missing.)
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
