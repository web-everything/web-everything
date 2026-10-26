---
bornAs: x8jgqee
kind: story
size: 2
status: open
scope: ["we:src/_includes/research-descriptions/heavy-admission-adaptive-cap.njk"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5930 (head 976a02e11)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5930 (reviewed head `976a02e11ae11dab50d9bc0b54226f07c8fd3225`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:src/_includes/research-descriptions/heavy-admission-adaptive-cap.njk:17` — (failing-input, degraded) The published research page links to unpublished statute URLs.
   - Scenario: Open /research/heavy-admission-adaptive-cap/ and click either settings-rule link, or the admission-rule link on line 29. Their destinations start with we:/docs/agent/platform-decisions.md, which the static build neither generates nor copies. Eleventy reads src/, its registered passthroughs exclude docs/, and we:src/rules-pages.njk publishes this document at /rules/platform-decisions/. These links therefore lead to missing pages on static hosting. Use /rules/platform-decisions/# followed by each existing anchor instead.
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
