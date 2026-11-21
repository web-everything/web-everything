---
kind: story
size: 2
status: open
scope: ["we:scripts/backlog-placement-trial.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use, coverage-or-style] from web-everything/web-everything#7269 (head e33f0e3ca)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7269 (reviewed head `e33f0e3ca5c1d4f205b884fd16cf066a22d9ac16`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/backlog-placement-trial.mjs:57` — (failing-input, degraded) Placement commentary overrides the explicitly declared target
   - Scenario: classifyCard("---\nkind: story\n---\n# Test\nPlacement: everstandards; plateau-app is only a consumer\n") returns target plateau-app, rule explicit-placement, confidence high. The parser searches for plateau anywhere before considering everstandards. It should honor the declared everstandards target, or return unsure if explanatory prose is unsupported.
   - Class: live-reproduced (basis: Direct invocation of the exported classifier reproduced the incorrect plateau-app result without filesystem writes.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/backlog-placement-trial.mjs:32` — (failing-input, degraded) Malformed YAML receives a confident placement instead of unsure
   - Scenario: classifyCard("---\nkind: [unterminated\n---\n# daemon lane drain\n") returns target plateau-app, rule score-plateau-app, confidence medium. splitCard checks delimiter presence but never validates the frontmatter. The script explicitly promises unreadable frontmatter becomes unsure; this invalid YAML should produce unsure with unreadable-frontmatter.
   - Class: live-reproduced (basis: Direct invocation of the exported classifier with an unterminated YAML sequence reproduced the confident classification.)
   - Also class: coverage-or-style
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
