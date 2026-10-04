---
bornAs: xa4x3x2
kind: story
size: 3
parent: "4075"
status: open
scope: ["we:scripts/lib/daemon-rebuild.mjs", "we:scripts/lib/__tests__/daemon-rebuild.test.mjs"]
dateOpened: "2026-10-03"
tags: []
---

# Prevention — Require exclusive coordination with backlog writers throughout validation and restoration, and add a de… (from chalbert/web-everything#3796 review)

Filed mechanically ON APPROVAL (operator rule, 2026-09-27 — "prevention outstanding should be filed by default on approval") — this accept verdict named the guard(s) below as owed. None of them blocked the approval; the debt is tracked here instead:

1. `we:scripts/lib/daemon-rebuild.mjs:660` — Require exclusive coordination with backlog writers throughout validation and restoration, and add a deterministic concurrency regression test that attempts a substantive write between the final read and checkout and verifies preservation.

Idempotency key (do not edit): approval-prevention-key:chalbert/web-everything#3796@36310451aa6f15c8a8dfa0f2dc81b98c7ac44dde

## Done when

1. **Executable** — TODO: a command that fails before this item lands and passes after.

Hint: a card that loosens a refusal needs two Must lines — what happens on error (refuse), and every input kind besides source code (docs, config, data) that the loosening must still treat cautiously.
