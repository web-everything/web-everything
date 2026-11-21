---
kind: story
size: 2
status: open
scope: ["we:scripts/backlog-placement-trial.mjs"]
dateOpened: "2026-11-21"
tags: []
---

# Red-team follow-ups [live-reproduced, correctness-in-normal-use] from web-everything/web-everything#7269 (head 2b7498e41)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#7269 (reviewed head `2b7498e41766b7aa5c56f2a28ddfbe956db9b8b3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/backlog-placement-trial.mjs:53` — (failing-input, degraded) A blank Placement field consumes the following sentence as its target
   - Scenario: classifyCard("---\nkind: story\n---\n# Fix daemon conveyor lane drain\nPlacement:\nWe still need to decide.\n") returns we, explicit-placement, high. The regex's whitespace match crosses the newline, and the pronoun 'We' becomes an authoritative repository selection. An empty placement should not override scoring; this input should score plateau-app.
   - Class: live-reproduced (basis: Directly executed classifyCard with this exact input and observed the high-confidence we result.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
2. `we:scripts/backlog-placement-trial.mjs:31` — (failing-input, degraded) Malformed YAML receives a confident placement instead of unreadable-frontmatter
   - Scenario: classifyCard("---\nkind: [story\n---\n# Add intent block plug adapter\n") returns we, score-we, medium despite the unterminated YAML sequence. splitCard only recognizes delimiters and never validates the frontmatter. The documented unreadable-frontmatter fallback should return unsure with no confidence.
   - Class: live-reproduced (basis: Directly executed classifyCard with the malformed frontmatter and observed the confident classification.)
   - Also class: correctness-in-normal-use
   - Claude's re-check: demonstrated break
3. `we:scripts/backlog-placement-trial.mjs:69` — (edge-case, degraded) Report-backed backlog cards are classified without their title or body
   - Scenario: Run runTrial('backlog') for the checked-out corpus. Card 049, we:backlog/049-declarative-component-element.md, receives unsure/no-signal because its body is empty. It is a supported relatedReport pointer whose title and content come from we:reports/2026-06-03-declarative-component-element.md. Applying the classifier to that report content produces we/high. The trial should resolve report-backed content before scoring the card's title and body.
   - Class: live-reproduced (basis: Observed nine bodyless relatedReport pointers in the corpus, all classified without report content. Verified card 049's no-signal result and the we/high result when its referenced report supplies the body.)
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
