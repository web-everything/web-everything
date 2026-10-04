---
bornAs: xsxphiw
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:backlog/5083-confirmed-finding-referral-records-close-when-a-later-review.md"]
dateOpened: "2026-10-04"
tags: []
---

# Prevention — Add a check:standards rule that fails a backlog card whose text loosens a gate or refusal (resolv… (from web-everything/web-everything#3894 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:backlog/5083-confirmed-finding-referral-records-close-when-a-later-review.md:14` — Add a check:standards rule that fails a backlog card whose text loosens a gate or refusal (resolved, close, no longer count, bypass, suppress) unless it contains a Must line covering the error path (refuse) and non-code input kinds. The template already carries this hint, so the rule would make it enforceable instead of advisory.
2. `we:backlog/5083-confirmed-finding-referral-records-close-when-a-later-review.md:18` — Reject on filing any backlog card whose Done-when still contains a literal 'TODO:' placeholder. Make that a deterministic lint in check:standards.

Idempotency key (do not edit): approval-prevention-key:web-everything/web-everything#3894@a44d0962cc91f2e80365db787b2e1f6391d1cf3c

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
