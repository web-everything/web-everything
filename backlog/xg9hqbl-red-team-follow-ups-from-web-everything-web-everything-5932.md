---
kind: story
size: 2
status: open
scope: ["we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md", "we:src/_includes/research-descriptions/probation-registry-generalisation.njk"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5932 (head f63e2345f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5932 (reviewed head `f63e2345fa010188a607d5ec99baec184ba16f77`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md:67` — (edge-case, degraded) The deadline rule requires a local time that may not exist.
   - Scenario: Activate at 2027-02-12T02:30:00-05:00. Thirty calendar days later is March 14, when America/Toronto skips 02:00–02:59. The required same-local-time deadline has no corresponding instant. A read-only Node probe using TZ=America/Toronto and setDate(getDate()+30) produces 03:30 instead. Specify how nonexistent and ambiguous local times resolve, and add a spring-transition acceptance case; the planned autumn-transition case cannot expose this.
   - Claude's re-check: demonstrated break
2. `we:src/_includes/research-descriptions/probation-registry-generalisation.njk:30` — (failing-input, degraded) Published research links target unpublished Markdown paths.
   - Scenario: Follow Model graduation or planner clause 9 from the new research page. Both target we:/docs/agent/platform-decisions.md#..., but Eleventy's input is src/, its registered passthroughs exclude docs/, and the rules template publishes this document at /rules/platform-decisions/. The static build therefore has no destination for these links. Use /rules/platform-decisions/#... for these two links and the no-borrowed-evidence link on line 28.
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
