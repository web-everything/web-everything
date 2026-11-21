---
kind: story
size: 2
status: open
scope: ["we:scripts/backlog-placement-trial.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, coverage-or-style, correctness-in-normal-use] from web-everything/web-everything#7269 (head d87b705d0)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7269 (reviewed head `d87b705d0c23b5fbaf62450452e39ffed05059ea`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/backlog-placement-trial.mjs:32` — (failing-input, degraded) Malformed YAML receives a placement instead of unreadable-frontmatter.
   - Scenario: Pass classifyCard the text "---\nkind: [story\n---\n# Fix daemon lane drain\n". Despite the unterminated YAML sequence, it returns plateau-app with rule score-plateau-app and medium confidence. It should return unsure with rule unreadable-frontmatter, as promised, so corrupt cards remain visible in the unreadable count.
   - Class: live-reproduced (basis: Observed directly by importing and calling the checked-out classifyCard function; no filesystem mutation or concurrency assumption.)
   - Also class: coverage-or-style
   - Claude's re-check: demonstrated break
2. `we:scripts/backlog-placement-trial.mjs:59` — (failing-input, degraded) Placement prose fabricates a repository name with high confidence.
   - Scenario: Pass classifyCard the text "---\nkind: story\n---\n# Work\nPlacement: everstandards for shared contracts\n". It returns target everstandards/for, rule explicit-placement, confidence high. The regex interprets the explanatory word 'for' as a repository. Since no repository is named, the result should be everstandards/unknown or unsure rather than a fabricated destination.
   - Class: live-reproduced (basis: Observed directly against the checked-out classifier with the exact input above.)
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
