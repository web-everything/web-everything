---
kind: story
size: 2
status: open
scope: ["we:scripts/conveyor/pr-stall-classify.mjs"]
dateOpened: "2026-11-20"
tags: []
---

# Red-team follow-ups [live-reproduced, attacker-same-user] from web-everything/web-everything#7230 (head f7c7dcd37)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7230 (reviewed head `f7c7dcd376c6ff7a3ea6ccf46e69e7127a7bf361`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/conveyor/pr-stall-classify.mjs:318` — (edge-case, degraded) A published malformed finding is treated as pending publication
   - Scenario: Publish a trusted red-team advisory whose confirmed finding starts with one leading space: ' 1. [**confirmed**] (edge-case, broken) 'we:scripts/foo.mjs:1' — Release the claim before pushing.'. The parser records this in shapedLines but returns findings=[]. The judge consequently produces card-the-rest with latest=[], latestCount=0 and zero class counts. For an exact-age red-team-cap row aged 2 minutes, crossBroken=0 and ordinary files, the classifier returns null; at 46 minutes it returns findings-stuck. A published malformed finding should immediately reach the operator, as the PR claims, rather
   - Class: live-reproduced (basis: Reproduced using the checked-out parser and classifier in an isolated in-memory harness with unused dependencies stubbed. The verdict fixture matches the inspected judge mapping for a parsed round with no confirmed findings. Full production imports were blocked by missing dependencies.)
   - Also class: attacker-same-user
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
