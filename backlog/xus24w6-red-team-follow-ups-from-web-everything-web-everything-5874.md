---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-size-admission.mjs"]
dateOpened: "2026-10-25"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5874 (head 5a0b327d9)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5874 (reviewed head `5a0b327d943d32a9028adce76e36419417cfdd79`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-size-admission.mjs:202` — (edge-case, degraded) Reusing a branch reuses an unrelated, resolved split card
   - Scenario: PR #100 on lane/reused previously filed we:backlog/9001-split-old-pr.md containing 'size-split-ref:lane%2Freused. '; that card is now resolved. Open unrelated PR #200 on the same branch with 301 changed lines and no admission marker. The default local lookup matches the old card solely by branch token, ignoring its status and PR identity. A read-only probe observed zero fileItem calls and a body claiming 'split card 9001 filed' for #200. Deduplication should distinguish PR lifecycles and file a new card for the new PR.
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
