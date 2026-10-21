---
bornAs: x4kqidu
kind: story
size: 2
status: open
scope: ["we:backlog/x9jn692-red-team-follow-ups-from-web-everything-web-everything-5551.md"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5674 (head 808420d8e)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5674 (reviewed head `808420d8ed083a026be7537e103ca633d91eb554`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/6412-red-team-follow-ups-from-web-everything-web-everything-5551.md:14` — (edge-case, degraded) x9jn692 duplicates existing open card #6295 for the same finding.
   - Scenario: Admit this card while we:backlog/6295-saved-and-posted-red-team-results-share-one-finding-id.md remains open. Both track the same PR #5551 finding at we:drain-saved-red-team.mjs:58 and require saved/posted representations to share an identity. A read-only Node probe passed both cards' actual metadata to orderQueue; it returned [6295, x9jn692], totaling four points for one two-point fix. The cards have independent identities and no supersession relationship, leaving duplicate outstanding work. Extend #6295 with the replay scenario instead of admitting a second open card.
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
