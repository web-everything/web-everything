---
bornAs: xl4s901
kind: story
size: 2
status: open
scope: ["we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md", "we:src/_includes/research-descriptions/probation-registry-generalisation.njk"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5932 (head 398c05fd7)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5932 (reviewed head `398c05fd7581b96a8b42741df989c2680ed23615`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/4010-decision-one-probation-system-for-any-new-system-or-ruling.md:67` — (edge-case, degraded) The same-local-time deadline cannot exist across a spring DST gap.
   - Scenario: Activate at 2026-02-06T02:30:00-05:00. Thirty calendar days later is March 8, when America/Toronto skips from 01:59 to 03:00; the required 02:30 deadline does not exist. An Intl.DateTimeFormat probe confirmed the gap and that 2026-03-08T02:30:00-05:00 instead displays as 03:30. Deadline derivation must either reject the activation or violate the stated same-local-time requirement. Specify a deterministic DST-gap resolution and assert its persisted result.
   - Claude's re-check: demonstrated break
2. `we:src/_includes/research-descriptions/probation-registry-generalisation.njk:28` — (failing-input, degraded) The published research page links to statute documents absent from the static site.
   - Scenario: Publish the configured Eleventy output and follow the new research page's no-borrowed-evidence link, which targets we:/docs/agent/platform-decisions.md#supervision-no-borrowed-evidence. The source document is outside the src input directory; src/docs does not exist, and probing registerPassthroughs confirmed that docs is not copied. The static output therefore cannot supply the linked document. The model-graduation and planner-clause links have the same problem. Point these citations to an accessible published document or source URL.
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
