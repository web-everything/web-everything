---
bornAs: x3ij600
kind: story
size: 2
status: open
scope: ["we:backlog/xh2689e-prevention-add-a-deterministic-card-lint-gate-requiring-each.md"]
dateOpened: "2026-10-18"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5647 (head 3091c68ac)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5647 (reviewed head `3091c68ac79560cb67f6d5a36f93db237cc8b7b3`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:backlog/6589-prevention-add-a-deterministic-card-lint-gate-requiring-each.md:6` — (edge-case, degraded) Stale provisional scope misses overlap with the existing numbered card
   - Scenario: The scope names nonexistent we:backlog/6262-prevention-card-lint-plus-review-lens-when-prose-enumerates.md. That card already exists as we:backlog/6262-prevention-card-lint-plus-review-lens-when-prose-enumerates.md, with bornAs: xmokcam. Probe: pass the authored scope to overlapAtLaunch with an active lease covering the numbered file. It returns outcome='launch' and no overlaps; editing the numbered file also registers as a scope breach. Replacing the stale scope with the current path returns outcome='wait' on that lease and eliminates the breach. Normalize the scope and corresponding body citati
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
