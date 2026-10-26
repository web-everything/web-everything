---
kind: story
size: 2
status: open
scope: ["we:scripts/lib/pr-size-admission.mjs"]
dateOpened: "2026-10-26"
tags: []
---

# Red-team follow-ups from web-everything/web-everything#5874 (head fb1a3c63f)

Filed mechanically by the red-team gate: the post-accept red team on web-everything/web-everything#5874 (reviewed head `fb1a3c63f99c2fd5cc07e184cdfb1d9b17d28a74`) found these, Claude's re-check confirmed them, and the setting `redTeam.confirmedBreaks` files their class as a follow-up card instead of blocking the PR:

1. `we:scripts/lib/pr-size-admission.mjs:241` — (edge-case, degraded) Same-head retries republish the split card after its batch seals
   - Scenario: Open a 301-line PR, let its split-card batch seal, then rerun the same head before that batch merges. The card is still absent from the canonical base, so publication calls fileIntoBatch again. Sealing archives the original membership and leaves an active state containing only seq and lastSealedState; admission therefore admits the identical idempotency key into the next batch. A read-only probe using the real admission runner, local lookup, and planAdmit produced lane/card-batch-filing-1 followed by lane/card-batch-filing-2 for one unchanged card. This creates redundant publication and verifi
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
